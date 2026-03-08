// api/check-limit.js — проверяет план пользователя перед каждым анализом
// Vercel env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { user_id, email } = req.body || {};
  if (!user_id && !email) return res.status(400).json({ error: 'user_id or email required' });

  try {
    // Ищем подписку
    let query = supabase.from('subscriptions').select('*');
    if (user_id) query = query.eq('user_id', user_id);
    else query = query.eq('email', email);
    const { data: sub } = await query.maybeSingle();

    // Нет записи → бесплатный план
    if (!sub) {
      return res.status(200).json({
        plan: 'free', analyses_limit: 3,
        analyses_used: 0, analyses_remaining: 3, can_analyze: true,
      });
    }

    // Проверяем сброс счётчика (1-е число каждого месяца)
    if (sub.plan !== 'free' && new Date() >= new Date(sub.reset_date)) {
      const nextReset = getNextMonthReset();
      await supabase.from('subscriptions')
        .update({ analyses_used: 0, reset_date: nextReset })
        .eq('id', sub.id);
      sub.analyses_used = 0;
    }

    const remaining = Math.max(0, sub.analyses_limit - sub.analyses_used);

    return res.status(200).json({
      plan: sub.plan,
      analyses_limit: sub.analyses_limit,
      analyses_used: sub.analyses_used,
      analyses_remaining: remaining,
      can_analyze: remaining > 0,
      reset_date: sub.reset_date,
      paddle_status: sub.paddle_status || null,
    });

  } catch (err) {
    console.error('check-limit error:', err);
    // При ошибке не блокируем пользователя
    return res.status(200).json({
      plan: 'free', analyses_limit: 3,
      analyses_used: 0, analyses_remaining: 3, can_analyze: true,
    });
  }
}

function getNextMonthReset() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1); d.setHours(0,0,0,0);
  return d.toISOString();
}
