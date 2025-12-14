// src/ai/ingest/intentRouter.ts

import OpenAI from "openai";
import { supa } from "../../db";
import { normalizeCustomerText } from "../lang/normalize";

export type IntentLane =
  | "order"
  | "menu"
  | "opening_hours"
  | "delivery_now"
  | "delivery_area"
  | "delivery_time_specific"
  | "pricing_generic"
  | "store_location"
  | "contact"
  | "human_help"
  | "unknown";

export type RouteResult = {
  intent: IntentLane;
  confidence: number;              // 0..1
  source: "override" | "rules" | "ai" | "fallback";
  reply?: string | null;
  entities?: Record<string, any>;
};

const openai =
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

function norm(t: string) {
        return (t || "")
          .toLowerCase()
          .replace(/[?.!,]/g, "")   // ✅ remove punctuation
          .replace(/\s+/g, " ")
          .trim();
      }

/** -------------------- OVERRIDES -------------------- */
async function tryOverrides(
  orgId: string,
  normalizedText: string
): Promise<RouteResult | null> {

  const { data: rows, error } = await supa
    .from("org_intent_overrides")
    .select("id, pattern, match_type, intent, is_active")
    .eq("org_id", orgId)
    .eq("is_active", true)
    .limit(200);

  // 🔥 THIS IS THE LOG YOU MEANT
  console.log("[AI][OVERRIDE][CANDIDATES]", {
    orgId,
    normalizedText,
    total: rows?.length || 0,
    rows: (rows || []).map(r => ({
      id: r.id,
      pattern: r.pattern,
      intent: r.intent,
      is_active: r.is_active,
      match_type: r.match_type,
    })),
    error: error?.message || null,
  });

  if (error || !rows?.length) return null;

  const txt = norm(normalizedText);

  for (const r of rows) {
    const pat = norm(r.pattern || "");
    let ok = false;

    if (r.match_type === "exact") ok = txt === pat;
    else if (r.match_type === "contains") ok = txt.includes(pat);
    else if (r.match_type === "regex") {
      try { ok = new RegExp(pat, "i").test(txt); } catch {}
    }

    if (ok) {
      console.log("[AI][OVERRIDE][MATCH]", {
        incoming: txt,
        pattern: pat,
        intent: r.intent,
      });

      return {
        intent: r.intent,
        confidence: 0.98,
        source: "override",
      };
    }
  }

  return null;
}

/** -------------------- RULES -------------------- */
function ruleRoute(normalizedText: string): RouteResult | null {
  const t = normalizedText;

  // MENU
  if (t.includes("menu") || t.includes("price list") || t.includes("show menu") || t.includes("send menu")) {
    return { intent: "menu", confidence: 0.95, source: "rules" };
  }

  // OPENING HOURS (include “is shop open?”)
  if (
    t.includes("open now") ||
    t.includes("are you open") ||
    t.includes("is the shop open") ||
    t.includes("shop open") ||
    t.includes("restaurant open") ||
    t.includes("kadai open") ||
    t.includes("opening time") ||
    t.includes("closing time") ||
    t.includes("what time do you open") ||
    t.includes("what time do you close") ||
    t.includes("timings") ||
    t.includes("working hours") ||
    t.includes("business hours")
  ) {
    return { intent: "opening_hours", confidence: 0.92, source: "rules" };
  }

  // CONTACT
  if (
    t.includes("contact") ||
    t.includes("phone number") ||
    t.includes("call") ||
    t.includes("how to reach you") ||
    t.includes("how can i contact") ||
    t.includes("number?")
  ) {
    return { intent: "contact", confidence: 0.92, source: "rules" };
  }

  // LOCATION
  if (
    t.includes("where is your shop") ||
    t.includes("where is your store") ||
    t.includes("where is your restaurant") ||
    t.includes("address") ||
    t.includes("location") ||
    t.includes("google map") ||
    t.includes("share location")
  ) {
    return { intent: "store_location", confidence: 0.92, source: "rules" };
  }

  // DELIVERY time-specific (12am etc)
  const hasTime =
  /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i.test(t) ||   // 12am, 12:30 pm
  /\b\d{1,2}\b/.test(t) && (t.includes("night") || t.includes("tonight")) || // 12 + night/tonight
  t.includes("midnight");

if ((t.includes("delivery") || t.includes("deliver")) && hasTime) {
  return { intent: "delivery_time_specific", confidence: 0.80, source: "rules" };
}

  // DELIVERY now
  if ((t.includes("deliver") || t.includes("delivery")) && (t.includes("now") || t.includes("today") || t.includes("available"))) {
    return { intent: "delivery_now", confidence: 0.86, source: "rules" };
  }

  if ((t.includes("delivery") || t.includes("deliver")) && (t.includes("what time") || t.includes("delivery time") || t.includes("when"))) {
    return { intent: "delivery_now", confidence: 0.70, source: "rules" }; // or human_help
  }

  // DELIVERY area
  if ((t.includes("deliver to") || t.includes("deliver in") || t.includes("delivery to") || t.includes("delivery in"))) {
    return { intent: "delivery_area", confidence: 0.82, source: "rules" };
  }

  // PRICING generic
  if (t.includes("price") || t.includes("how much") || t.includes("rate card") || t.includes("ratecard")) {
    return { intent: "pricing_generic", confidence: 0.75, source: "rules" };
  }

  // If it's clearly a question but unknown intent → human_help
  if (t.endsWith("?") || t.startsWith("where") || t.startsWith("how") || t.startsWith("when") || t.startsWith("what")) {
    return { intent: "human_help", confidence: 0.55, source: "rules" };
  }

  return null;
}

/** -------------------- AI CLASSIFIER (only when needed) -------------------- */
async function aiRoute(normalizedText: string): Promise<RouteResult | null> {
  if (!openai) return null;

  // Keep it super small + deterministic
  const prompt = `
Classify the user's message into one intent from:
order, menu, opening_hours, delivery_now, delivery_area, delivery_time_specific, pricing_generic, store_location, contact, human_help, unknown

Return ONLY minified JSON:
{"intent":"...","confidence":0.0}

Message:
${normalizedText}
`.trim();

  const resp = await openai.chat.completions.create({
    model: process.env.AI_ROUTER_MODEL || "gpt-4o-mini",
    temperature: 0,
    max_tokens: 60,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = resp.choices[0]?.message?.content?.trim() || "";
  try {
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const intent = String(json.intent || "unknown") as IntentLane;
    const confidence = Math.max(0, Math.min(1, Number(json.confidence || 0)));
    return { intent, confidence, source: "ai" };
  } catch {
    return null;
  }
}

/** -------------------- LEARNING: auto-create overrides on “correction” -------------------- */
// Called when we *detect* misroute (you will wire this from ingestCore when user says “no I asked …”)
export async function learnOverride(params: {
  orgId: string;
  normalizedText: string;      // the text that was misrouted (previous message)
  correctedIntent: IntentLane;
  createdBy?: "system" | "admin";
}) {
  const { orgId, normalizedText, correctedIntent } = params;
  const pattern = norm(normalizedText).slice(0, 200);

  if (!pattern || pattern.length < 4) return;

  // prevent duplicates
  const existing = await supa
    .from("org_intent_overrides")
    .select("id")
    .eq("org_id", orgId)
    .eq("pattern", pattern)
    .eq("intent", correctedIntent)
    .maybeSingle();

  if (existing.data?.id) return;

  const normalizedPattern = normalizeCustomerText(pattern);

  const ins = await supa
    .from("org_intent_overrides")
    .insert({
      org_id: orgId,
      pattern: normalizedPattern,
      match_type: "exact",
      intent: correctedIntent,
      created_by: "system",
      confidence: 0.75,
      is_active: true,
      hits: 0,
    })
    .select(); // 🔥 IMPORTANT
  
  console.log("[AI][LEARN][OVERRIDE_INSERT]", {
    ok: !ins.error,
    error: ins.error?.message || null,
    details: ins.error || null,
    rows: ins.data || [],
  });


  const check = await supa
  .from("org_intent_overrides")
  .select("*")
  .eq("org_id", orgId);

console.log("[AI][LEARN][POST_INSERT_CHECK]", check.data, check.error);

  // const check = await supa
  //   .from("org_intent_overrides")
  //   .select("id, pattern, match_type, intent, is_active, created_at")
  //   .eq("org_id", orgId)
  //   .eq("pattern", pattern)
  //   .order("created_at", { ascending: false })
  //   .limit(5);

  // console.log("[AI][LEARN][OVERRIDE_DB_CHECK]", {
  //   rows: check.data || [],
  //   error: check.error?.message || null,
  // });

  const canRead = await supa
  .from("org_intent_overrides")
  .select("id, org_id, pattern, intent, is_active, created_at")
  .eq("org_id", orgId)
  .order("created_at", { ascending: false })
  .limit(5);

console.log("[AI][LEARN][OVERRIDE_CAN_READ_AFTER_INSERT]", {
  rows: canRead.data || [],
  error: canRead.error
    ? {
        message: canRead.error.message,
        code: (canRead.error as any).code,
        details: (canRead.error as any).details,
      }
    : null,
});

 
}

/** -------------------- PUBLIC ROUTER -------------------- */
export async function routeIntent(params: {
  orgId: string;
  customerPhone?: string | null;
  rawText: string;
  normalizedText: string;
  state?: string | null;
}): Promise<RouteResult> {
  const { orgId, customerPhone, rawText, normalizedText, state } = params;
  const txt = norm(normalizedText || rawText);

  // 1) overrides
  const ov = await tryOverrides(orgId, txt);
  if (ov) {
    await logEvent(orgId, customerPhone, rawText, txt, ov, state);
    return ov;
  }

  // 2) rules
  const rr = ruleRoute(txt);
  if (rr && rr.confidence >= 0.70) {
    await logEvent(orgId, customerPhone, rawText, txt, rr, state);
    return rr;
  }

  // 3) AI router if still unclear
  const ar = await aiRoute(txt);
  if (ar && ar.confidence >= 0.65 && ar.intent !== "unknown") {
    await logEvent(orgId, customerPhone, rawText, txt, ar, state);
    return ar;
  }

  // 4) fallback
  const fb: RouteResult = {
    intent: "human_help",
    confidence: 0.40,
    source: "fallback",
  };
  await logEvent(orgId, customerPhone, rawText, txt, fb, state);
  return fb;
}

async function logEvent(
  orgId: string,
  customerPhone: string | null | undefined,
  rawText: string,
  normalizedText: string,
  r: RouteResult,
  state?: string | null
) {
  await supa.from("org_intent_events").insert({
    org_id: orgId,
    customer_phone: customerPhone ?? null,
    raw_text: rawText,
    normalized_text: normalizedText,
    decided_intent: r.intent,
    confidence: Number((r.confidence ?? 0).toFixed(3)),
    source: r.source,
    state: state ?? null,
    meta: r.entities ?? null,
  });
}