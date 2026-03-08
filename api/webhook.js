// api/webhook.js — Paddle webhook → Supabase
// Vercel env vars needed:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, PADDLE_WEBHOOK_SECRET
//
// В Paddle Dashboard → Notifications → Add notification:
//   URL: https://statsfai.com/api/webhook
//   Events: subscription.created, subscription.updated,
//           subscription.canceled, subscription.paused,
//           transaction.completed

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── ПЛАН ПО PRICE ID ────────────────────────────────────────────────────────
// Заполни после создания продуктов в Paddle Dashboard → Catalog → Products
// Price ID выглядит как: pri_01abc123...
const PRICE_PLANS = {
  'pri_STARTER_MONTHLY_ID': { plan: 'starter', analyses_limit: 25 },
  'pri_PRO_MONTHLY_ID':     { plan: 'pro',     analyses_limit: 999999 },
  'pri_PRO_YEARLY_ID':      { plan: 'pro',     analyses_limit: 999999 },
};

// ── VERIFY PADDLE SIGNATURE ─────────────────────────────────────────────────
function verifyPaddleSignature(rawBody, signature, secret) {
  try {
    const parts = {};
    signature.split(';').forEach(part => {
      const [key, val] = part.split('=');
      parts[key] = val;
    });
    const { ts, h1 } = parts;
    if (!ts || !h1) return false;
    const signed = `${ts}:${rawBody}`;
    const digest = crypto.createHmac('sha256', secret).update(signed).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(digest,'hex'), Buffer.from(h1,'hex'));
  } catch (e) { return false; }
}

async function resolveUser(email) {
  if (!email) return null;
  try {
    const { data } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    return data?.users?.find(u => u.email === email) || null;
  } catch (e) { return null; }
}

async function upsertSubscription({ email, userId, plan, limit, paddleSubId, priceId, status }) {
  const record = {
    email, plan,
    analyses_limit: limit,
    analyses_used: 0,
    reset_date: getNextMonthReset(),
    paddle_subscription_id: paddleSubId,
    price_id: priceId,
    paddle_status: status,
    updated_at: new Date().toISOString(),
  };
  if (userId) record.user_id = userId;
  const conflictCol = userId ? 'user_id' : 'email';
  const { error } = await supabase.from('subscriptions').upsert(record, { onConflict: conflictCol });
  if (error) console.error('Upsert error:', error);
  else console.log(`✅ ${email} → ${plan}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const signature = req.headers['paddle-signature'];
  if (!signature) return res.status(401).json({ error: 'No signature' });

  const rawBody = JSON.stringify(req.body);
  if (!verifyPaddleSignature(rawBody, signature, process.env.PADDLE_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const eventType = req.body?.event_type;
  const data      = req.body?.data;
  console.log(`Paddle event: ${eventType}`);

  // SUBSCRIPTION CREATED / UPDATED
  if (eventType === 'subscription.created' || eventType === 'subscription.updated') {
    const email   = data?.customer?.email || data?.custom_data?.email || '';
    const priceId = data?.items?.[0]?.price?.id || '';
    const subId   = data?.id || '';
    const status  = data?.status || '';
    const cfg     = PRICE_PLANS[priceId];
    if (!cfg) return res.status(200).json({ ok: true, note: 'unknown price' });
    const active  = status === 'active' || status === 'trialing';
    const user    = await resolveUser(email);
    await upsertSubscription({
      email, userId: user?.id || null,
      plan: active ? cfg.plan : 'free',
      limit: active ? cfg.analyses_limit : 3,
      paddleSubId: subId, priceId, status,
    });
  }

  // SUBSCRIPTION CANCELLED / PAUSED
  if (eventType === 'subscription.canceled' || eventType === 'subscription.paused') {
    const subId = data?.id || '';
    await supabase.from('subscriptions').update({
      plan: 'free', analyses_limit: 3,
      paddle_status: eventType.includes('canceled') ? 'canceled' : 'paused',
      updated_at: new Date().toISOString(),
    }).eq('paddle_subscription_id', subId);
  }

  // ONE-TIME TRANSACTION
  if (eventType === 'transaction.completed') {
    const email   = data?.customer?.email || '';
    const priceId = data?.items?.[0]?.price?.id || '';
    const cfg     = PRICE_PLANS[priceId];
    if (cfg) {
      const user = await resolveUser(email);
      await upsertSubscription({
        email, userId: user?.id || null,
        plan: cfg.plan, limit: cfg.analyses_limit,
        paddleSubId: data?.subscription_id || '',
        priceId, status: 'active',
      });
    }
  }

  return res.status(200).json({ received: true });
}

function getNextMonthReset() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1); d.setHours(0,0,0,0);
  return d.toISOString();
}
