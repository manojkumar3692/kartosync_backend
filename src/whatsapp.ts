import axios from 'axios';
const WA_GRAPH = 'https://graph.facebook.com/v19.0';
export async function sendWhatsAppText(phone_number_id: string, to: string, text: string) {
  if (!process.env.WA_ACCESS_TOKEN) return;
  await axios.post(`${WA_GRAPH}/${phone_number_id}/messages`, {
    messaging_product:'whatsapp', to, type:'text', text:{ body:text }
  }, { headers:{ Authorization:`Bearer ${process.env.WA_ACCESS_TOKEN}` }});
}