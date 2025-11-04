import { supa } from '../src/db';
export async function checkFreeLimit(org_id: string){
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const { count } = await supa.from('orders').select('*', { count:'exact', head:true })
    .eq('org_id', org_id).gte('created_at', todayStart.toISOString());
  const todayCount = count||0; const limit = 25; return { todayCount, limit, allowed: todayCount < limit };
}