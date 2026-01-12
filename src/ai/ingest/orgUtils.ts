// src/ai/ingest/orgUtils.ts
import { supa } from "../../db";

export async function getOrgBusinessType(org_id: string): Promise<string | null> {
  const { data, error } = await supa
    .from("orgs")
    .select("business_type")
    .eq("id", org_id)
    .maybeSingle();

  if (error || !data) {
    console.warn("[ORG][business_type] error", { org_id, error });
    return null;
  }
  return (data as any).business_type || null;
}

export async function isClinicOrg(org_id: string): Promise<boolean> {
  const bt = await getOrgBusinessType(org_id);
  return bt === "clinic";
}