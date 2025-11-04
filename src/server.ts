// src/server.ts
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { auth } from './routes/auth';
import { org } from './routes/org';
import { orders } from './routes/orders';
import { payments } from './routes/payments';
import { webhook } from './routes/webhook';
import { ingest } from './routes/ingest';
import { ordersFeedback } from './routes/orders_feedback';
import { aiCorrections } from "./routes/ai-corrections";
import aiDebug from './routes/aiDebug';

console.log('[BOOT] JWT_SECRET present?', !!process.env.JWT_SECRET, 'value:', process.env.JWT_SECRET);
console.log('✅ MOBILE_INGEST_SECRET =', process.env.MOBILE_INGEST_SECRET);
console.log('[BOOT] JWT_SECRET present?', !!process.env.JWT_SECRET, 'value:', process.env.JWT_SECRET);
console.log('✅ MOBILE_INGEST_SECRET =', process.env.MOBILE_INGEST_SECRET);

// ⬇️ ADD:
console.log('[AI] OPENAI_API_KEY present?', !!process.env.OPENAI_API_KEY);
console.log('[AI] AI_MODEL =', process.env.AI_MODEL || 'gpt-4o-mini');
console.log('[AI] AI_DAILY_USD =', process.env.AI_DAILY_USD || '(default 5.00)');
const app = express();
app.use(cors({
  origin: (process.env.CORS_ORIGIN || '*').split(','),
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Signature','ngrok-skip-browser-warning'],
  credentials: false,
}));
app.options('*', cors());
// HMAC route MUST run raw, so mount it BEFORE bodyParser.json()
app.use('/api/ingest', ingest);  // ✅ put this FIRST

// JSON for normal routes
app.use(bodyParser.json());


app.use('/api/ai', aiDebug); 
// health
app.get('/health', (_req, res) => res.json({ ok: true }));

// routes
app.use('/api/auth', auth);
app.use('/api/org', org);
app.use('/api/orders', orders);
app.use('/api/orders', ordersFeedback);
app.use('/api/payments', payments);
app.use('/webhook', webhook);
app.use("/api/ai-corrections", aiCorrections);

const PORT = Number(process.env.PORT || 8787);
app.listen(PORT, () => console.log('Backend listening on', PORT));