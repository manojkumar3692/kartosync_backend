// src/ai/ingest/clinicAppointmentEngine.ts

import { supa } from "../../db";
import type { IngestContext, IngestResult, ConversationState } from "./types";
import { clearState, setState } from "./stateManager";

type OrderRow = {
  id: string;
  org_id: string;
  source_phone: string;
  status: string;
  appointment_patient_name?: string | null;
  appointment_date?: string | null; // YYYY-MM-DD
  appointment_slot_start?: string | null; // "HH:MM"
  appointment_slot_label?: string | null; // e.g. "11:00 AM"
   // 🆕 for frontend
   patient_name?: string | null;
   patient_phone?: string | null;
   total_amount?: number | null;
   order_total?: number | null;
   currency_code?: string | null;
};

// Very simple date helper: returns YYYY-MM-DD in org timezone is overkill.
// For v1 we'll use server UTC date for appointment_date.
// Use clinic timezone (default Asia/Dubai) for "today"
const CLINIC_TZ = process.env.CLINIC_TZ || "Asia/Dubai";

function getClinicToday(): Date {
  const now = new Date();
  const inTz = new Date(now.toLocaleString("en-US", { timeZone: CLINIC_TZ }));

  return new Date(inTz.getFullYear(), inTz.getMonth(), inTz.getDate());
}

// Canonical YYYY-MM-DD for DB
function toISODate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Display-friendly DD-MM-YYYY for WhatsApp
function formatDisplayDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// Parse only natural language: "today", "tomorrow", weekday names.
// ❌ No more loose "15th"/"15" parsing here.
function parseRequestedDate(text: string): Date | null {
  const lower = text.toLowerCase().trim();

  const today = getClinicToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  if (lower.includes("today")) return today;
  if (lower.includes("tomorrow") || lower.includes("tmrw")) return tomorrow;

  // Weekday names
  const weekdays = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];

  for (let i = 0; i < weekdays.length; i++) {
    if (lower.includes(weekdays[i])) {
      const target = new Date(today);
      const diff = (i - target.getDay() + 7) % 7;
      target.setDate(target.getDate() + (diff === 0 ? 7 : diff)); // next occurrence
      return target;
    }
  }

  return null;
}

// Strict DD/MM/YYYY parser (e.g. "15/01/2026")
function parseDdmmyyyy(text: string): Date | null {
  const m = text.trim().match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (!m) return null;

  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);

  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  // Create date in local server time
  const d = new Date(year, month - 1, day);
  // Basic sanity: check the components match (avoid 31/02 → Mar 3)
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }

  return d;
}

// Build time slots from org's open/close time (30-min step)
function buildSlotsForOrg(
  orgRow: any,
  date: Date
): { value: string; label: string }[] {
  const open = orgRow?.delivery_open_time || "09:00:00";
  const close = orgRow?.delivery_close_time || "13:00:00";

  const [oh, om] = open.split(":").map((n: string) => parseInt(n, 10));
  const [ch, cm] = close.split(":").map((n: string) => parseInt(n, 10));

  let startMinutes = oh * 60 + (om || 0);
  const endMinutes = ch * 60 + (cm || 0);

  const slots: { value: string; label: string }[] = [];
  const step = 30; // minutes

  while (startMinutes + step <= endMinutes) {
    const h = Math.floor(startMinutes / 60);
    const m = startMinutes % 60;
    const hh = h.toString().padStart(2, "0");
    const mm = m.toString().padStart(2, "0");

    // nice label like "9:00 AM"
    const hour12 = ((h + 11) % 12) + 1;
    const ampm = h < 12 ? "AM" : "PM";
    const label = `${hour12}:${mm} ${ampm}`;

    slots.push({ value: `${hh}:${mm}`, label });

    startMinutes += step;
  }

  return slots;
}

// Fetch booked slots for a given date
async function getBookedSlotValues(
  org_id: string,
  isoDate: string
): Promise<Set<string>> {
  const { data } = await supa
    .from("orders")
    .select("appointment_slot_start, appointment_status")
    .eq("org_id", org_id)
    .eq("appointment_date", isoDate)
    .in("appointment_status", ["pending", "confirmed"] as any);

  const taken = new Set<string>();
  if (data) {
    for (const row of data as any[]) {
      if (row.appointment_slot_start) {
        taken.add(row.appointment_slot_start);
      }
    }
  }
  return taken;
}

// Pick the latest *open* clinic appointment order for this customer
async function getLatestClinicOrder(
  org_id: string,
  phone: string
): Promise<OrderRow | null> {
  const phoneKey = phone.replace(/[^\d]/g, "");

  console.log("[CLINIC][GET_LATEST_ORDER][IN]", { org_id, phoneKey });

  const { data, error } = await supa
    .from("orders")
    .select(
      "id, org_id, source_phone, status, appointment_patient_name, appointment_date, appointment_slot_start, appointment_slot_label, appointment_status"
    )
    .eq("org_id", org_id)
    .eq("source_phone", phoneKey)
    // only treat orders with *no* appointment_status as open
    .is("appointment_status", null)
    // still treat only certain statuses as "open"
    .in("status", ["awaiting_customer_action", "draft", "pending"] as any)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[CLINIC][GET_LATEST_ORDER_ERR]", {
      org_id,
      phoneKey,
      error,
    });
    return null;
  }

  console.log("[CLINIC][GET_LATEST_ORDER][OUT]", { org_id, phoneKey, data });

  return (data as any) || null;
}


// --- NEW HELPERS ---

function normalizePhone(p: string): string {
    return (p || "").replace(/[^\d]/g, "");
  }
  
  async function getOrCreateClinicOrder(
    org_id: string,
    phone: string
  ): Promise<OrderRow> {
    // 1) Try existing open order
    const existing = await getLatestClinicOrder(org_id, phone);
    if (existing) {
      console.log("[CLINIC][GET_OR_CREATE][FOUND]", {
        org_id,
        phone: normalizePhone(phone),
        order_id: existing.id,
      });
      return existing;
    }
  
    // 2) Create fresh order
    const phoneKey = normalizePhone(phone);
  
    console.log("[CLINIC][GET_OR_CREATE][CREATE]", { org_id, phoneKey });
  
    const { data, error } = await supa
      .from("orders")
      .insert({
        org_id,
        source_phone: phoneKey,
        status: "awaiting_customer_action",
  
        // ✅ REQUIRED: NOT NULL in your schema
        raw_text: "Clinic appointment booking started via WhatsApp",
  
        // ✅ Force “open” clinic appointment
        appointment_status: null,
  
        // 🆕 tie clinic record to WhatsApp number
        patient_phone: phoneKey,
        patient_name: null,
      } as any)
      .select(
        "id, org_id, source_phone, status, appointment_patient_name, appointment_date, appointment_slot_start, appointment_slot_label, appointment_status, patient_name, patient_phone"
      )
      .maybeSingle();
  
    if (error || !data) {
      console.error("[CLINIC][CREATE_ORDER_ERR]", {
        org_id,
        phoneKey,
        error,
      });
      throw new Error("Failed to create clinic appointment order");
    }
  
    console.log("[CLINIC][GET_OR_CREATE][CREATED]", {
      org_id,
      phoneKey,
      order_id: (data as any).id,
    });
  
    return data as any;
  }

export async function handleClinicStep(
  ctx: IngestContext,
  state: ConversationState
): Promise<IngestResult> {
    const { org_id, from_phone, text } = ctx;
    const raw = (text || "").trim();
    const lower = raw.toLowerCase();

    // 🔹 Local cancel/reset words *inside clinic flow*
  const CLINIC_CANCEL_WORDS = ["cancel", "stop", "reset", "start over"];

  // If user says "cancel" while in clinic flow, just reset the flow.
  // Do NOT cancel any existing appointment rows in DB.
  if (CLINIC_CANCEL_WORDS.some((w) => lower === w || lower.includes(w))) {
    await clearState(org_id, from_phone);
    return {
      used: true,
      kind: "smalltalk",
      order_id: null,
      reply:
        "Okay, I’ve cancelled this appointment flow. " +
        "Your existing appointment (if any) is unchanged. " +
        'You can type *book appointment* to start a new booking.',
    };
  }

  // 👇 declare here so catch can see it
  let supportPhone: string | null = null;

  try {
    const orgRes = await supa
    .from("orgs")
    .select(
      "name, phone, store_address_text, store_address, store_lat, store_lng, delivery_open_time, delivery_close_time, clinic_consultation_fee, default_currency, currency_code"
    )
    .eq("id", org_id)
    .maybeSingle();
  
  const orgRow = orgRes.data as any;
  
  // Name: use DB name, fall back to generic
  const clinicName = orgRow?.name || "the clinic";
  
  // Phone: use the org’s main phone
  const clinicPhone = orgRow?.phone || null;
  
  // Address: prefer store_address_text, else store_address
  const clinicAddress =
    orgRow?.store_address_text || orgRow?.store_address || null;
  
  // 🆕 Pricing + currency (all optional / safe)
  const baseFee: number | null =
    typeof orgRow?.clinic_consultation_fee === "number"
      ? orgRow.clinic_consultation_fee
      : null;
  
  const currency: string =
    orgRow?.default_currency || orgRow?.currency_code || "INR";

    // Build a basic Google Maps link if we have lat/lng
    let clinicMapsUrl: string | null = null;
    if (
      typeof orgRow?.store_lat === "number" &&
      typeof orgRow?.store_lng === "number"
    ) {
      clinicMapsUrl = `https://www.google.com/maps?q=${orgRow.store_lat},${orgRow.store_lng}`;
    }

    // Also keep a generic supportPhone for error messages
    supportPhone = clinicPhone;

    console.log("[CLINIC][ORG_META]", {
      org_id,
      clinicName,
      clinicPhone,
      clinicAddress,
      clinicMapsUrl,
    });

    if (state === "clinic_awaiting_patient_name") {
        // take full text as name
        const patientName = raw;
      
        // 🔥 Ensure an order row exists
        const latest = await getOrCreateClinicOrder(org_id, from_phone);
        const phoneKey = normalizePhone(from_phone);
      
        await supa
          .from("orders")
          .update({
            appointment_patient_name: patientName, // for AI / logs
            patient_name: patientName,            // for frontend
            patient_phone: latest.patient_phone || phoneKey,
          } as any)
          .eq("id", latest.id);
      
        await setState(org_id, from_phone, "clinic_awaiting_date");
      
        return {
          used: true,
          kind: "order",
          order_id: latest.id,
          reply:
            `Thanks, *${patientName}* 👍\n` +
            `Please choose a day for your appointment at *${clinicName}*:\n\n` +
            `1) Today\n` +
            `2) Tomorrow\n` +
            `3) Pick another date (DD/MM/YYYY)\n\n` +
            `Reply with *1*, *2* or *3*.`,
        };
      }

    if (state === "clinic_awaiting_date") {
      const lower = raw.toLowerCase().trim();

      // 🔥 Use clinic-local today
      const today = getClinicToday();
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);

      let chosenDate: Date | null = null;

      // 1️⃣ NUMBER FIRST
      if (lower === "1") {
        chosenDate = today;
      } else if (lower === "2") {
        chosenDate = tomorrow;
      } else if (lower === "3") {
        // Ask specifically for DD/MM/YYYY in a dedicated state
        await setState(org_id, from_phone, "clinic_awaiting_specific_date");
        return {
          used: true,
          kind: "order",
          order_id: null,
          reply:
            "Please type the date in *DD/MM/YYYY* format.\n" +
            "Example: *15/01/2026*.",
        };
      }

      // 2️⃣ TEXT FALLBACK: "today", "tomorrow", "friday", etc.
      if (!chosenDate) {
        chosenDate = parseRequestedDate(raw);
      }

      // 3️⃣ DIRECT STRICT DD/MM/YYYY (if they skipped 3 and just typed a date)
      if (!chosenDate) {
        chosenDate = parseDdmmyyyy(raw);
      }

      // ❌ Still nothing understood → repeat menu with numbers
      if (!chosenDate) {
        return {
          used: true,
          kind: "order",
          order_id: null,
          reply:
            "I couldn't understand that date 😊\n\n" +
            "Please reply with:\n" +
            "1) Today\n" +
            "2) Tomorrow\n" +
            "3) Pick another date (DD/MM/YYYY)\n\n" +
            "Reply with *1*, *2* or *3*.",
        };
      }

      const isoDate = toISODate(chosenDate);
      const displayDate = formatDisplayDate(chosenDate);

      // Build all slots from clinic timings
      const allSlots = buildSlotsForOrg(orgRow, chosenDate);
      if (!allSlots.length) {
        return {
          used: true,
          kind: "order",
          order_id: null,
          reply:
            "Sorry, there are no appointment slots configured for that day. Please try a different date.",
        };
      }

      // 🔥 Filter out past slots if the date is today
      let candidateSlots = allSlots;
      if (toISODate(chosenDate) === toISODate(today)) {
        const nowInTz = new Date(
          new Date().toLocaleString("en-US", { timeZone: CLINIC_TZ })
        );
        const nowMinutes = nowInTz.getHours() * 60 + nowInTz.getMinutes();

        candidateSlots = allSlots.filter((s) => {
          const [hh, mm] = s.value.split(":").map((n) => parseInt(n, 10));
          const slotMinutes = hh * 60 + (mm || 0);
          return slotMinutes >= nowMinutes;
        });

        console.log("[CLINIC][SLOTS][TODAY]", {
          org_id,
          isoDate,
          nowMinutes,
          total: allSlots.length,
          candidate: candidateSlots.length,
        });
      }

      const taken = await getBookedSlotValues(org_id, isoDate);
      const freeSlots = candidateSlots.filter((s) => !taken.has(s.value));

      if (!freeSlots.length) {
        return {
          used: true,
          kind: "order",
          order_id: null,
          reply:
            "That day is fully booked. Please choose another day (for example, *tomorrow*).",
        };
      }

      // Persist date on order – ensure an order row exists
      const latest = await getOrCreateClinicOrder(org_id, from_phone);

      await supa
        .from("orders")
        .update({
          appointment_date: isoDate,
        } as any)
        .eq("id", latest.id);

      const maxOptions = 5;
      const options = freeSlots.slice(0, maxOptions);
      const lines = options
        .map((s, idx) => `${idx + 1}) ${s.label}`)
        .join("\n");

      await setState(org_id, from_phone, "clinic_awaiting_time");

      return {
        used: true,
        kind: "order",
        order_id: latest.id,
        reply:
          `Great, let's book on *${displayDate}*.\n` +
          "These are the next available slots:\n" +
          lines +
          "\n\nPlease reply with the *number* (e.g. 1 or 2).",
      };
    }

    if (state === "clinic_awaiting_time") {
        const latest = await getLatestClinicOrder(org_id, from_phone);
        if (!latest?.id || !latest.appointment_date) {
          console.error("[CLINIC][SESSION_MISSING_LATEST]", {
            org_id,
            from_phone,
            latest,
          });
      
          await clearState(org_id, from_phone);
          return {
            used: true,
            kind: "order",
            order_id: null,
            reply:
              "Something went wrong with your appointment session. Please type *book appointment* to start again.",
          };
        }
      
        const chosenDate = new Date(latest.appointment_date);
        const allSlots = buildSlotsForOrg(orgRow, chosenDate);
      
        const taken = await getBookedSlotValues(org_id, latest.appointment_date);
        const freeSlots = allSlots.filter((s) => !taken.has(s.value));
        if (!freeSlots.length) {
          await setState(org_id, from_phone, "clinic_awaiting_date");
          return {
            used: true,
            kind: "order",
            order_id: latest.id,
            reply:
              "All slots for that day just got filled. Please choose another day (e.g. *tomorrow*).",
          };
        }
      
        // parse numeric choice
        const n = parseInt(raw, 10);
        if (Number.isNaN(n) || n < 1 || n > Math.min(5, freeSlots.length)) {
          const options = freeSlots.slice(0, 5);
          const lines = options
            .map((s, idx) => `${idx + 1}) ${s.label}`)
            .join("\n");
      
          return {
            used: true,
            kind: "order",
            order_id: latest.id,
            reply:
              "Please reply with a valid slot number from the list.\n\n" + lines,
          };
        }
      
        const slot = freeSlots[n - 1];
      
        const updatePayload: any = {
          appointment_slot_start: slot.value,
          appointment_slot_label: slot.label,
          appointment_status: "pending",
        };
      
        // 🆕 add consultation fee into order totals if configured
        if (baseFee && baseFee > 0) {
          updatePayload.total_amount = baseFee;
          updatePayload.order_total = baseFee;
          updatePayload.currency_code = currency;
        }
      
        await supa.from("orders").update(updatePayload).eq("id", latest.id);
      
        await clearState(org_id, from_phone);
      
        // Fetch patient name (prefer patient_name, fallback to appointment_patient_name)
        const { data: refreshed } = await supa
          .from("orders")
          .select("patient_name, appointment_patient_name")
          .eq("id", latest.id)
          .maybeSingle();
      
        const patient =
          (refreshed as any)?.patient_name ||
          (refreshed as any)?.appointment_patient_name ||
          "the patient";
      
        let displayDate = latest.appointment_date || "";
        if (latest.appointment_date) {
          const dateObj = new Date(latest.appointment_date);
          displayDate = formatDisplayDate(dateObj);
        }
      
        return {
          used: true,
          kind: "order",
          order_id: latest.id,
          reply:
            "✅ *Appointment booked!*\n\n" +
            `👤 Patient: *${patient}*\n` +
            (displayDate ? `🗓 Date: *${displayDate}*\n` : "") +
            `⏰ Time: *${slot.label}*\n` +
            `🏥 Clinic: *${clinicName}*\n` +
            (clinicPhone ? `📞 Contact: *${clinicPhone}*\n` : "") +
            (clinicAddress ? `🧭 Address: *${clinicAddress}*\n` : "") +
            (clinicMapsUrl ? `📍 Google Maps: ${clinicMapsUrl}\n` : "") +
            "\nIf you want to *reschedule* or *cancel*, just send a message here.",
        };
      }

    if (state === "clinic_awaiting_specific_date") {
      const dateObj = parseDdmmyyyy(raw);
      if (!dateObj) {
        return {
          used: true,
          kind: "order",
          order_id: null,
          reply:
            "That doesn’t look like a valid date.\n" +
            "Please use *DD/MM/YYYY* format only. Example: *15/01/2026*.",
        };
      }

      const isoDate = toISODate(dateObj);
      const displayDate = formatDisplayDate(dateObj);

      const allSlots = buildSlotsForOrg(orgRow, dateObj);
      if (!allSlots.length) {
        return {
          used: true,
          kind: "order",
          order_id: null,
          reply:
            "Sorry, there are no appointment slots configured for that day. Please try a different date.",
        };
      }

      const taken = await getBookedSlotValues(org_id, isoDate);
      const freeSlots = allSlots.filter((s) => !taken.has(s.value));
      if (!freeSlots.length) {
        return {
          used: true,
          kind: "order",
          order_id: null,
          reply:
            "That day is fully booked. Please choose another day (for example, *tomorrow*).",
        };
      }

      // Ensure an order exists before saving the specific date
      const latest = await getOrCreateClinicOrder(org_id, from_phone);

      await supa
        .from("orders")
        .update({
          appointment_date: isoDate,
        } as any)
        .eq("id", latest.id);

      const maxOptions = 5;
      const options = freeSlots.slice(0, maxOptions);
      const lines = options
        .map((s, idx) => `${idx + 1}) ${s.label}`)
        .join("\n");

      await setState(org_id, from_phone, "clinic_awaiting_time");

      return {
        used: true,
        kind: "order",
        order_id: latest.id,
        reply:
          `Great, let's book on *${displayDate}*.\n` +
          "These are the next available slots:\n" +
          lines +
          "\n\nPlease reply with the *number* (e.g. 1 or 2).",
      };
    }

    // default fallback inside try
    await clearState(org_id, from_phone);
    return {
      used: true,
      kind: "order",
      order_id: null,
      reply:
        "I reset your clinic booking session. Please type *book appointment* to start again.",
    };
  } catch (e: any) {
    console.error("[CLINIC][FATAL]", {
      org_id,
      from_phone,
      error: e?.message || e,
    });

    // We might not have orgRow here, so do a light fetch:
    // We might not have orgRow here, so do a light fetch:
    let supportPhone: string | null = null;
    try {
      const { data } = await supa
        .from("orgs")
        .select("phone")
        .eq("id", org_id)
        .maybeSingle();
      supportPhone = (data as any)?.phone || null;
    } catch {}

    await clearState(org_id, from_phone);

    const safeMessage =
      "⚠️ I’m having trouble booking your appointment right now.\n" +
      "Please contact the clinic directly" +
      (supportPhone ? ` at *${supportPhone}*` : "") +
      ".\n\n" +
      "You can also try again in a few minutes by typing *book appointment*.";

    return {
      used: true,
      kind: "smalltalk",
      order_id: null,
      reply: safeMessage,
    };
  }
}
