// src/ai/preferenceMemory.ts
import { supa } from "../db";

export type PreferenceKey = "spice" | "onion" | "oil" | "chilli";

// Values are optional (customer may only have 1–2 prefs saved)
export type PreferencesMap = Record<PreferenceKey, string | undefined>;

export type PreferenceRecord = {
  pref_key: PreferenceKey;
  pref_value: string; // e.g. "less", "extra", "no", "regular"
  raw_text: string;
};

/**
 * Normalize text for pattern matching.
 */
function norm(s: string | null | undefined): string {
  return (s || "").toString().toLowerCase().trim();
}

/**
 * Very conservative extractor:
 * We ONLY record preferences when the message clearly looks like
 * a GENERAL preference (always / usually / for me).
 *
 * Examples that will be recorded:
 *  - "for me always less spicy"
 *  - "i usually take less spicy and no onion"
 *  - "my usual is extra spicy"
 *
 * One-off messages like "make biryani spicy this time"
 * will NOT be stored as preferences.
 */
export function extractPreferencesFromText(text: string): PreferenceRecord[] {
  const raw = text || "";
  const t = norm(raw);

  if (!t) return [];

  // Heuristic: only learn when user talks about usual/always
  const isGeneral =
    /\balways\b/.test(t) ||
    /\bevery time\b/.test(t) ||
    /\bfor me\b/.test(t) ||
    /\bfor my\b/.test(t) ||
    /\bmy usual\b/.test(t) ||
    /\busual for me\b/.test(t) ||
    /\bi usually\b/.test(t) ||
    /\bi normally\b/.test(t);

  if (!isGeneral) {
    // v1: we stay safe, no memory for one-off messages
    return [];
  }

  const prefs: PreferenceRecord[] = [];

  // ---- SPICE LEVEL ----
  if (
    /less spicy|medium spicy|mild spicy|not too spicy|little spicy/.test(t)
  ) {
    prefs.push({ pref_key: "spice", pref_value: "less", raw_text: raw });
  } else if (
    /extra spicy|very spicy|more spicy|super spicy|too spicy/.test(t)
  ) {
    prefs.push({ pref_key: "spice", pref_value: "extra", raw_text: raw });
  } else if (/regular spicy|normal spicy|normal spice/.test(t)) {
    prefs.push({ pref_key: "spice", pref_value: "regular", raw_text: raw });
  }

  // ---- ONION ----
  if (/no onion|without onion|dont add onion|don't add onion/.test(t)) {
    prefs.push({ pref_key: "onion", pref_value: "no", raw_text: raw });
  }

  // ---- CHILLI ----
  if (
    /no chilli|no chili|without chilli|without chili|dont add chilli|don't add chilli/.test(
      t
    )
  ) {
    prefs.push({ pref_key: "chilli", pref_value: "no", raw_text: raw });
  } else if (/less chilli|less chili|mild chilli|mild chili/.test(t)) {
    prefs.push({ pref_key: "chilli", pref_value: "less", raw_text: raw });
  }

  // ---- OIL ----
  if (/less oil|low oil/.test(t)) {
    prefs.push({ pref_key: "oil", pref_value: "less", raw_text: raw });
  } else if (/no oil|without oil/.test(t)) {
    prefs.push({ pref_key: "oil", pref_value: "no", raw_text: raw });
  }

  // De-duplicate by pref_key (keep the last match)
  const byKey = new Map<PreferenceKey, PreferenceRecord>();
  for (const p of prefs) {
    byKey.set(p.pref_key, p);
  }

  return Array.from(byKey.values());
}

/**
 * Store general preferences for a customer.
 * SAFE: if no general preference phrase is found, this is a no-op.
 */
export async function rememberPreferenceFromText(opts: {
  orgId: string;
  phoneKey: string;
  text: string;
}): Promise<void> {
  const { orgId, phoneKey, text } = opts;
  const prefs = extractPreferencesFromText(text);

  if (!prefs.length) return;

  const rows = prefs.map((p) => ({
    org_id: orgId,
    customer_phone: phoneKey,
    pref_key: p.pref_key,
    pref_value: p.pref_value,
    raw_text: p.raw_text,
    updated_at: new Date().toISOString(),
  }));

  try {
    await supa.from("customer_preferences").upsert(rows, {
      onConflict: "org_id,customer_phone,pref_key",
    });
  } catch (e: any) {
    console.warn("[PREF][rememberPreferenceFromText err]", e?.message || e);
  }
}

/**
 * Load all preferences for this customer into a simple key → value map.
 */
export async function loadPreferencesForCustomer(opts: {
  orgId: string;
  phoneKey: string;
}): Promise<PreferencesMap> {
  const { orgId, phoneKey } = opts;

  try {
    const { data, error } = await supa
      .from("customer_preferences")
      .select("pref_key, pref_value")
      .eq("org_id", orgId)
      .eq("customer_phone", phoneKey);

    if (error || !data) {
      if (error) {
        console.warn("[PREF][loadPreferences err]", error.message);
      }
      // return all keys present but undefined, so TS is happy
      return {
        spice: undefined,
        onion: undefined,
        oil: undefined,
        chilli: undefined,
      };
    }

    const out: PreferencesMap = {
      spice: undefined,
      onion: undefined,
      oil: undefined,
      chilli: undefined,
    };

    for (const row of data as any[]) {
      const k = row.pref_key as PreferenceKey;
      const v = String(row.pref_value || "").trim();
      if (k && v) {
        out[k] = v;
      }
    }

    return out;
  } catch (e: any) {
    console.warn("[PREF][loadPreferences catch]", e?.message || e);
    return {
      spice: undefined,
      onion: undefined,
      oil: undefined,
      chilli: undefined,
    };
  }
}

/**
 * Internal helper to merge a phrase into notes.
 */
function mergeNotes(existing: any, phrase: string): string {
  const base = (existing || "").toString().trim();
  if (!base) return phrase;
  const lower = base.toLowerCase();
  const pLower = phrase.toLowerCase();

  // avoid simple duplicates
  if (lower.includes(pLower)) return base;
  return `${base}; ${phrase}`;
}

/**
 * Attach human-readable notes to items based on stored preferences.
 * V1: we annotate **all items** with the customer's global prefs.
 */
export function applyPreferencesToItems(opts: {
  items: any[];
  prefs: PreferencesMap;
}): any[] {
  const { items, prefs } = opts;

  if (!items || !Array.isArray(items) || !items.length) return items;
  if (!prefs) return items;

  return items.map((item) => {
    const cloned: any = { ...(item || {}) };
    let notes: string | undefined = cloned.notes;

    // SPICE
    const spice = prefs.spice;
    if (spice === "less") {
      notes = mergeNotes(notes, "less spicy");
    } else if (spice === "extra") {
      notes = mergeNotes(notes, "extra spicy");
    } else if (spice === "regular") {
      notes = mergeNotes(notes, "normal spicy");
    }

    // ONION
    const onion = prefs.onion;
    if (onion === "no") {
      notes = mergeNotes(notes, "no onion");
    }

    // CHILLI
    const chilli = prefs.chilli;
    if (chilli === "no") {
      notes = mergeNotes(notes, "no chilli");
    } else if (chilli === "less") {
      notes = mergeNotes(notes, "less chilli");
    }

    // OIL
    const oil = prefs.oil;
    if (oil === "less") {
      notes = mergeNotes(notes, "less oil");
    } else if (oil === "no") {
      notes = mergeNotes(notes, "no oil");
    }

    if (notes && notes.trim()) {
      cloned.notes = notes;
    }

    return cloned;
  });
}

/**
 * Convenience helper: load preferences for this customer and apply to items.
 */
export async function applyPreferencesForCustomerToItems(opts: {
  orgId: string;
  phoneKey: string;
  items: any[];
}): Promise<any[]> {
  const { orgId, phoneKey, items } = opts;
  const prefs = await loadPreferencesForCustomer({ orgId, phoneKey });
  return applyPreferencesToItems({ items, prefs });
}