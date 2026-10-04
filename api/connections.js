import {
  getAdminClient,
  json,
  methodNotAllowed,
  publicConnection,
  PROVIDERS,
  requireUser,
  safeMessage
} from '../lib/server.js';

export default async function handler(req, res) {
  try {
    const { user } = await requireUser(req);
    const admin = getAdminClient();
    if (req.method === 'GET') {
      const { data, error } = await admin.from('social_connections')
        .select('provider,account_name,created_at').eq('user_id', user.id);
      if (error) throw error;
      return json(res, 200, { connections: (data || []).map(publicConnection) });
    }
    if (req.method === 'DELETE') {
      const provider = new URL(req.url, 'https://viralai.invalid').searchParams.get('provider');
      if (!PROVIDERS.has(provider)) return json(res, 400, { error: 'Choose Facebook, Instagram, or TikTok.' });
      const { error } = await admin.from('social_connections').delete()
        .eq('user_id', user.id).eq('provider', provider);
      if (error) throw error;
      return json(res, 200, { disconnected: provider });
    }
    return methodNotAllowed(res, ['GET', 'DELETE']);
  } catch (error) {
    return json(res, error.status || 500, { error: safeMessage(error) });
  }
}