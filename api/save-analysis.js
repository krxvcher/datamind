import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { niche, niche_label, type, type_label, currency, region, input_data, result_text } = req.body;
  if (!result_text) return res.status(400).json({ error: 'Missing result_text' });

  // Get user from Authorization header (JWT from Supabase)
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No auth token' });
  const token = authHeader.replace('Bearer ', '');

  try {
    // Use service key to bypass RLS, but verify user token first
    const sbAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Verify the user token and get user
    const sbUser = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );
    const { data: { user }, error: authErr } = await sbUser.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

    // Insert analysis
    const { data, error } = await sbAdmin
      .from('analyses')
      .insert({
        user_id: user.id,
        niche,
        niche_label,
        type,
        type_label,
        currency: currency || 'USD',
        region: region || '',
        input_data: input_data || {},
        result_text,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(200).json({ success: true, id: data.id });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
