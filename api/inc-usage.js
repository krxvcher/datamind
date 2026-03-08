// api/inc-usage.js — увеличивает счётчик после каждого анализа
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
    let query = supabase.from('subscriptions').select('*');
    if (user_id) query = query.eq('user_id', user_id);
    else query = query.eq('email', email);
    const { data: sub } = await query.maybeSingle();

    if (!sub) {
      // Первый анализ — создаём запись бесплатного плана
      const record = {
        email, plan: 'free',
        analyses_limit: 3, analyses_used: 1,
        reset_date: getNextMonthReset(),
      };
      if (user_id) record.user_id = user_id;
      await supabase.from('subscriptions').insert(record);
      return res.status(200).json({ ok: true, analyses_used: 1 });
    }

    // Про — не считаем (безлимит), просто возвращаем ok
    if (sub.plan === 'pro') {
      return res.status(200).json({ ok: true, analyses_used: sub.analyses_used });
    }

    const newUsed = (sub.analyses_used || 0) + 1;
    await supabase.from('subscriptions')
      .update({ analyses_used: newUsed, updated_at: new Date().toISOString() })
      .eq('id', sub.id);

    return res.status(200).json({ ok: true, analyses_used: newUsed });

  } catch (err) {
    console.error('inc-usage error:', err);
    return res.status(200).json({ ok: true }); // не блокируем при ошибке
  }
}

function getNextMonthReset() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1); d.setHours(0,0,0,0);
  return d.toISOString();
}
