// src/ai/ingest/attempts.ts

import { supa } from "../../db";

export async function getAttempts(org_id: string, phone: string): Promise<number> {
  const { data } = await supa
    .from("session_state")
    .select("failed_attempts")
    .eq("org_id", org_id)
    .eq("from_phone", phone)
    .single();

  return data?.failed_attempts ?? 0;
}

export async function incAttempts(org_id: string, phone: string) {
  await supa.rpc("inc_failed_attempts", { _org: org_id, _phone: phone });
}

export async function resetAttempts(org_id: string, phone: string) {
  await supa
    .from("session_state")
    .update({ failed_attempts: 0 })
    .eq("org_id", org_id)
    .eq("from_phone", phone);
}