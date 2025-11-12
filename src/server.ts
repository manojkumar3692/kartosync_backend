// src/server.ts
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { auth } from './routes/auth';
import { org } from './routes/org';
import { orders } from './routes/orders';
import { payments } from './routes/payments';
import { ingest } from './routes/ingest';
import { ordersFeedback } from './routes/orders_feedback';
import { aiCorrections } from "./routes/ai-corrections";
import aiDebug from './routes/aiDebug';
import { admin } from './routes/admin';
import adminProducts from './routes/admin_products';
import clarify from './routes/clarify';
import { clarifyLink } from "./routes/clarifyLink";
import suggestReply from './routes/suggestReply';
import availability from './routes/availability';
import waba from './routes/waba';
import { inbox } from './routes/inbox';

// ─────────────────────────────
// Boot diagnostics
// ─────────────────────────────
console.log('[BOOT] JWT_SECRET present?', !!process.env.JWT_SECRET, 'value:', process.env.JWT_SECRET);
console.log('✅ MOBILE_INGEST_SECRET =', process.env.MOBILE_INGEST_SECRET);
console.log('[AI] OPENAI_API_KEY present?', !!process.env.OPENAI_API_KEY);
console.log('[AI] AI_MODEL =', process.env.AI_MODEL || 'gpt-4o-mini');
console.log('[AI] AI_DAILY_USD =', process.env.AI_DAILY_USD || '(default 5.00)');

const app = express();

// ─────────────────────────────
// Global CORS
// ─────────────────────────────
app.use(cors({
  origin: (process.env.CORS_ORIGIN || '*').split(','),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Signature', 'ngrok-skip-browser-warning'],
  credentials: false,
}));
app.options('*', cors());

// ─────────────────────────────
// Global request logger (top of chain)
// ─────────────────────────────
app.use((req, _res, next) => {
  console.log('[SERVER HIT]', req.method, req.originalUrl);
  next();
});

// ─────────────────────────────
// Handle CORS for ingest routes
// ─────────────────────────────
const ingestCors = cors({
  origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(','),
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Signature', 'ngrok-skip-browser-warning'],
});

app.options('/api/ingest/local', ingestCors);
app.use('/api/ingest', ingestCors, ingest);

// ─────────────────────────────
// Legacy webhook trap (if Meta still hits old URL)
// ─────────────────────────────
app.all('/webhook', (req, res) => {
  console.log('[LEGACY /webhook HIT]', req.method, req.originalUrl);
  console.log('↪️ Expected callback is /webhook/whatsapp. Update it in WABA settings.');
  return res.sendStatus(410);
});

// ─────────────────────────────
// WABA Webhook mounts (main + fallback path)
// ─────────────────────────────
app.use('/webhook/whatsapp', express.json(), waba);
app.use('/api/waba/webhook', express.json(), waba);

// ─────────────────────────────
// Standard JSON body parser for remaining routes
// ─────────────────────────────
app.use(bodyParser.json());

// ─────────────────────────────
// Health check
// ─────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ─────────────────────────────
// Main API routes
// ─────────────────────────────
app.use(clarify);
app.use('/api/ai', aiDebug);
app.use('/api/inbox', inbox);
app.use('/api/availability', availability);
app.use('/api/suggest-reply', suggestReply);
app.use('/api/admin', admin);
app.use('/api/clarify-link', clarifyLink);
app.use('/api/admin/products', adminProducts);
app.use('/api/auth', auth);
app.use('/api/org', org);
app.use('/api/orders', orders);
app.use('/api/orders', ordersFeedback);
app.use('/api/payments', payments);
app.use("/api/ai-corrections", aiCorrections);

// ─────────────────────────────
// Server start
// ─────────────────────────────
const PORT = Number(process.env.PORT || 8787);
app.listen(PORT, () => console.log('✅ Backend listening on', PORT));