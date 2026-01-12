// src/ai/ingest/clinicAppointmentEngine.ts
import { supa } from "../../db";
import { IngestContext, IngestResult, ConversationState } from "./types";
import { setState, clearState } from "./stateManager";

type OrderRow = {
  id: string;
  items: any[] | null;
  appointment_date?: string | null;
  appointment_start_time?: string | null;
  appointment_end_time?: string | null;
  patient_name?: string | null;
  patient_phone?: string | null;
  doctor_name?: string | null;
};

async function getLatestPendingOrder(org_id: string, from_phone: string) {
  const { data, error } = await supa
    .from("orders")
    .select("id, items, appointment_date, appointment_start_time, appointment_end_time, patient_name, patient_phone, doctor_name")
    .eq("org_id", org_id)
    .eq("source_phone", from_phone)
    .in("status", ["awaiting_customer_action"] as any)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    console.warn("[CLINIC][order_not_found]", { org_id, from_phone, error });
    return null;
  }
  return data as OrderRow;
}

// Helper: generate simple 30-min slots for today/tomorrow morning (example)
function buildSlots(): { label: string; value: string }[] {
  const slots: { label: string; value: string }[] = [];
  const startHour = 9;
  const endHour = 13; // 1 PM

  for (let h = startHour; h < endHour; h++) {
    for (const m of [0, 30]) {
      const hh = h.toString().padStart(2, "0");
      const mm = m.toString().padStart(2, "0");
      const label = `${hh}:${mm}`;
      slots.push({ label, value: `${hh}:${mm}:00` });
    }
  }
  return slots;
}

export async function handleClinicStep(
  ctx: IngestContext,
  state: ConversationState
): Promise<IngestResult> {
  const { org_id, from_phone } = ctx;
  const raw = (ctx.text || "").trim();

  const order = await getLatestPendingOrder(org_id, from_phone);
  if (!order) {
    await clearState(org_id, from_phone);
    return {
      used: true,
      kind: "order",
      order_id: null,
      reply:
        "⚠️ I couldn’t find an active appointment.\nPlease type what you need help with (e.g. *tooth pain*, *teeth cleaning*).",
    };
  }

  // 1️⃣ Collect patient name
  if (state === "clinic_awaiting_patient_name") {
    if (!raw) {
      return {
        used: true,
        kind: "order",
        order_id: order.id,
        reply: "👤 Please share the *patient full name*.",
      };
    }

    await supa
      .from("orders")
      .update({
        patient_name: raw,
        patient_phone: from_phone,
        doctor_name: "Dr Vani", // for Lotus; later make this configurable
      } as any)
      .eq("id", order.id);

    await setState(org_id, from_phone, "clinic_awaiting_date");

    return {
      used: true,
      kind: "order",
      order_id: order.id,
      reply:
        `Thanks, *${raw}* 👍\n\n` +
        "📅 Please choose a *date* for the appointment:\n" +
        "1) Today\n" +
        "2) Tomorrow\n" +
        "3) Other date (type in DD-MM-YYYY)",
    };
  }

  // 2️⃣ Collect appointment date
  if (state === "clinic_awaiting_date") {
    let dateStr: string | null = null;

    if (raw === "1") {
      // today (server time)
      dateStr = new Date().toISOString().slice(0, 10);
    } else if (raw === "2") {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      dateStr = d.toISOString().slice(0, 10);
    } else {
      // naive DD-MM-YYYY parsing
      const m = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if (m) {
        const dd = m[1].padStart(2, "0");
        const mm = m[2].padStart(2, "0");
        const yyyy = m[3];
        dateStr = `${yyyy}-${mm}-${dd}`; // ISO date
      }
    }

    if (!dateStr) {
      return {
        used: true,
        kind: "order",
        order_id: order.id,
        reply:
          "📅 I didn’t understand the date.\nPlease reply:\n1 for *Today*, 2 for *Tomorrow*, or type in *DD-MM-YYYY*.",
      };
    }

    await supa
      .from("orders")
      .update({ appointment_date: dateStr } as any)
      .eq("id", order.id);

    await setState(org_id, from_phone, "clinic_awaiting_time");

    const slots = buildSlots();
    const lines = slots
      .map((s, idx) => `${idx + 1}) ${s.label}`)
      .join("\n");

    return {
      used: true,
      kind: "order",
      order_id: order.id,
      reply:
        `📅 Date saved: *${dateStr}*.\n\n` +
        "⏰ Please choose a *time slot*:\n" +
        lines +
        "\n\nReply with the number (e.g. 1, 2…).",
    };
  }

  // 3️⃣ Collect appointment time slot
  if (state === "clinic_awaiting_time") {
    const slots = buildSlots();
    const idx = parseInt(raw, 10) - 1;

    if (Number.isNaN(idx) || idx < 0 || idx >= slots.length) {
      const lines = slots
        .map((s, i) => `${i + 1}) ${s.label}`)
        .join("\n");
      return {
        used: true,
        kind: "order",
        order_id: order.id,
        reply:
          "⏰ I didn’t catch that.\nPlease choose a slot number from the list:\n" +
          lines,
      };
    }

    const chosen = slots[idx];
    const [hh, mm] = chosen.value.split(":").map((v) => parseInt(v, 10));
    const endMinutes = hh * 60 + mm + 30; // 30-min slot
    const endH = Math.floor(endMinutes / 60)
      .toString()
      .padStart(2, "0");
    const endM = (endMinutes % 60).toString().padStart(2, "0");

    const startTime = `${hh.toString().padStart(2, "0")}:${mm
      .toString()
      .padStart(2, "0")}:00`;
    const endTime = `${endH}:${endM}:00`;

    await supa
      .from("orders")
      .update({
        appointment_start_time: startTime,
        appointment_end_time: endTime,
        appointment_status: "pending",
        status: "awaiting_store_action", // clinic to confirm
      } as any)
      .eq("id", order.id);

    await clearState(org_id, from_phone);

    // Small summary
    const name = order.patient_name || "patient";
    const slotLabel = chosen.label;

    return {
      used: true,
      kind: "order",
      order_id: order.id,
      reply:
        `✅ *Appointment request received!*\n\n` +
        `👤 Patient: *${name}*\n` +
        `📅 Date: *saved in system*\n` +
        `⏰ Time: *${slotLabel}* (30 min)\n` +
        `👩‍⚕️ Doctor: *Dr Vani*\n\n` +
        "The clinic will confirm your appointment time shortly.",
    };
  }

  // Not our state
  return { used: false, kind: "order", order_id: null, reply: "" };
}