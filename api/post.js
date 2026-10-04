import {
  decryptSecret,
  encryptSecret,
  fetchJson,
  getAdminClient,
  getConnection,
  graphVersion,
  json,
  methodNotAllowed,
  PROVIDERS,
  requireUser,
  safeMessage
} from '../lib/server.js';

function validateImageUrl(value) {
  if (!value) return '';
  let parsed;
  try { parsed = new URL(value); }
  catch { throw Object.assign(new Error('A public image URL is required for this platform.'), { status: 400 }); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw Object.assign(new Error('The image must use a public HTTPS URL. Data URLs and private links cannot be posted.'), { status: 400 });
  }
  return parsed.toString();
}

async function publishFacebook(connection, caption, imageUrl) {
  const version = graphVersion();
  const endpoint = imageUrl
    ? `https://graph.facebook.com/${version}/${connection.page_id}/photos`
    : `https://graph.facebook.com/${version}/${connection.page_id}/feed`;
  const body = new URLSearchParams({
    access_token: decryptSecret(connection.access_token_enc),
    message: caption
  });
  if (imageUrl) body.set('url', imageUrl);
  const result = await fetchJson(endpoint, { method: 'POST', body });
  return { id: result.post_id || result.id, url: result.post_id ? `https://www.facebook.com/${result.post_id}` : null };
}

async function publishInstagram(connection, caption, imageUrl) {
  if (!imageUrl) {
    throw Object.assign(new Error('Instagram Graph API publishing requires a generated image. Generate an image first, then post again.'), { status: 422 });
  }
  const version = graphVersion();
  const token = decryptSecret(connection.access_token_enc);
  const creation = await fetchJson(`https://graph.facebook.com/${version}/${connection.account_id}/media`, {
    method: 'POST',
    body: new URLSearchParams({ image_url: imageUrl, caption, access_token: token })
  });
  const published = await fetchJson(`https://graph.facebook.com/${version}/${connection.account_id}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: creation.id, access_token: token })
  });
  return { id: published.id, url: null };
}

async function getTikTokAccessToken(connection, userId) {
  const expiresAt = connection.expires_at ? Date.parse(connection.expires_at) : 0;
  if (!expiresAt || expiresAt > Date.now() + 5 * 60 * 1000) return decryptSecret(connection.access_token_enc);
  if (!connection.refresh_token_enc) {
    throw Object.assign(new Error('TikTok authorization expired. Reconnect the TikTok account.'), { status: 401 });
  }
  const response = await fetchJson('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: decryptSecret(connection.refresh_token_enc)
    })
  });
  const data = response.data || response;
  if (!data.access_token) throw new Error('TikTok token refresh returned no access token. Reconnect the account.');
  const admin = getAdminClient();
  const { error } = await admin.from('social_connections').update({
    access_token_enc: encryptSecret(data.access_token),
    refresh_token_enc: data.refresh_token ? encryptSecret(data.refresh_token) : connection.refresh_token_enc,
    expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
    updated_at: new Date().toISOString()
  }).eq('user_id', userId).eq('provider', 'tiktok');
  if (error) throw new Error(`TikTok token refresh could not be saved: ${error.message}`);
  return data.access_token;
}

async function publishTikTok(connection, caption, imageUrl, userId) {
  if (!imageUrl) {
    throw Object.assign(new Error('TikTok direct posting needs a photo. A script cannot be published as a video without a video file, so use the TikTok upload fallback.'), { status: 422, code: 'media_required' });
  }
  const token = await getTikTokAccessToken(connection, userId);
  const creatorInfo = await fetchJson('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: '{}'
  });
  const creator = creatorInfo.data || {};
  const privacy = creator.privacy_level_options?.[0];
  if (!privacy) throw Object.assign(new Error('TikTok did not return an available privacy setting for this account.'), { status: 422 });
  const result = await fetchJson('https://open.tiktokapis.com/v2/post/publish/content/init/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      post_info: {
        title: caption.slice(0, 2200),
        privacy_level: privacy,
        disable_comment: false,
        auto_add_music: true
      },
      source_info: { source: 'PULL_FROM_URL', photo_images: [imageUrl], photo_cover_index: 0 },
      post_mode: 'DIRECT_POST',
      media_type: 'PHOTO'
    })
  });
  return { id: result.data?.publish_id || null, url: null, status: 'processing' };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    const { user } = await requireUser(req);
    const { provider, caption, imageUrl: rawImageUrl = '' } = req.body || {};
    if (!PROVIDERS.has(provider)) return json(res, 400, { error: 'Choose Facebook, Instagram, or TikTok.' });
    if (typeof caption !== 'string' || !caption.trim()) return json(res, 400, { error: 'Generated caption or post text is required.' });
    if (caption.length > 5000) return json(res, 413, { error: 'Post text exceeds the supported length.' });
    const imageUrl = validateImageUrl(rawImageUrl);
    const connection = await getConnection(user.id, provider);
    if (!connection) return json(res, 409, { error: `${provider} is not connected. Connect the account first.`, code: 'not_connected' });

    const published = provider === 'facebook'
      ? await publishFacebook(connection, caption.trim(), imageUrl)
      : provider === 'instagram'
        ? await publishInstagram(connection, caption.trim(), imageUrl)
        : await publishTikTok(connection, caption.trim(), imageUrl, user.id);
    return json(res, 200, { ok: true, provider, ...published });
  } catch (error) {
    return json(res, error.status || 500, {
      error: safeMessage(error),
      ...(error.code ? { code: error.code } : {})
    });
  }
}