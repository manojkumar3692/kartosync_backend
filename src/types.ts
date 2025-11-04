export type Org = {
  id: string; name: string; phone?: string; wa_phone_number_id?: string; plan: 'free'|'pro'; created_at: string;
};
export type Order = {
  id: string; org_id: string; customer_name: string|null; source_phone: string|null; raw_text: string;
  items: {name:string; qty:number; unit?:string}[]; status: 'pending'|'delivered'|'paid'; created_at: string;
};