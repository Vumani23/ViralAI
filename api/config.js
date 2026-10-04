import { json, methodNotAllowed } from '../lib/server.js';

export default function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  json(res, 200, {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    providers: {
      facebook: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),
      instagram: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),
      tiktok: Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET)
    }
  });
}