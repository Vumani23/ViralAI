import {
  appUrl,
  callbackUrl,
  encryptSecret,
  fetchJson,
  getAdminClient,
  json,
  methodNotAllowed,
  oauthCookie,
  parseCookies,
  PROVIDERS,
  requiredEnv,
  requireUser,
  safeMessage,
  saveConnection,
  signState,
  verifyState
} from '../lib/server.js';
import { randomBytes } from 'node:crypto';

const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish'
].join(',');

function redirectPage(res, provider, outcome, message = '') {
  const origin = JSON.stringify(appUrl());
  const payload = JSON.stringify({ type: 'viralai-oauth-result', provider, outcome, message });
  const returnUrl = new URL('/', appUrl());
  returnUrl.searchParams.set('social_status', outcome);
  returnUrl.searchParams.set('provider', provider);
  if (message) returnUrl.searchParams.set('message', message);
  const fallback = JSON.stringify(returnUrl.toString());
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><meta charset="utf-8"><title>ViralAI connection</title><p>Returning to ViralAI...</p><script>if(window.opener){window.opener.postMessage(${payload},${origin});window.close()}else{window.location.replace(${fallback})}</script>`);
}

function buildAuthorizationUrl(provider, state) {
  const redirect = callbackUrl(provider);
  if (provider === 'tiktok') {
    requiredEnv(['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET']);
    const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
    url.searchParams.set('client_key', process.env.TIKTOK_CLIENT_KEY);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'user.info.basic,video.publish');
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.set('state', state);
    return url.toString();
  }
  requiredEnv(['META_APP_ID', 'META_APP_SECRET']);
  const url = new URL(`https://www.facebook.com/${process.env.META_GRAPH_VERSION || 'v22.0'}/dialog/oauth`);
  url.searchParams.set('client_id', process.env.META_APP_ID);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', META_SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

async function beginOAuth(req, res, provider) {
  if (!PROVIDERS.has(provider)) return json(res, 400, { error: 'Choose Facebook, Instagram, or TikTok.' });
  const { user } = await requireUser(req);
  const state = signState({
    provider,
    userId: user.id,
    nonce: randomBytes(24).toString('base64url'),
    issuedAt: Date.now()
  });
  res.setHeader('Set-Cookie', oauthCookie(provider, state));
  json(res, 200, { authorizationUrl: buildAuthorizationUrl(provider, state) });
}

async function exchangeMetaCode(code, redirect) {
  requiredEnv(['META_APP_ID', 'META_APP_SECRET']);
  const version = process.env.META_GRAPH_VERSION || 'v22.0';
  const shortUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  shortUrl.searchParams.set('client_id', process.env.META_APP_ID);
  shortUrl.searchParams.set('client_secret', process.env.META_APP_SECRET);
  shortUrl.searchParams.set('redirect_uri', redirect);
  shortUrl.searchParams.set('code', code);
  const shortToken = await fetchJson(shortUrl);
  const longUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  longUrl.searchParams.set('grant_type', 'fb_exchange_token');
  longUrl.searchParams.set('client_id', process.env.META_APP_ID);
  longUrl.searchParams.set('client_secret', process.env.META_APP_SECRET);
  longUrl.searchParams.set('fb_exchange_token', shortToken.access_token);
  try { return await fetchJson(longUrl); }
  catch { return shortToken; }
}

async function saveMetaAccounts(userId, userToken, requestedProvider) {
  const version = process.env.META_GRAPH_VERSION || 'v22.0';
  const accountsUrl = new URL(`https://graph.facebook.com/${version}/me/accounts`);
  accountsUrl.searchParams.set('fields', 'id,name,access_token,instagram_business_account{id,username}');
  accountsUrl.searchParams.set('limit', '100');
  accountsUrl.searchParams.set('access_token', userToken);
  const pagePayload = await fetchJson(accountsUrl);
  const pages = pagePayload.data || [];
  if (!pages.length) {
    throw new Error('No Facebook Pages were found. Add a Page and grant ViralAI page permissions, then connect again.');
  }

  const page = requestedProvider === 'instagram'
    ? pages.find(candidate => candidate.instagram_business_account?.id)
    : pages[0];
  if (!page) {
    throw new Error('No Instagram professional account is linked to the Facebook Pages you granted. Link an Instagram Business or Creator account to a Page and try again.');
  }
  const pageToken = page.access_token || userToken;
  await saveConnection(userId, 'facebook', {
    access_token_enc: encryptSecret(pageToken),
    refresh_token_enc: null,
    account_id: page.id,
    page_id: page.id,
    account_name: page.name || 'Facebook Page',
    expires_at: null,
    metadata: {}
  });
  const ig = page.instagram_business_account;
  if (ig?.id) {
    await saveConnection(userId, 'instagram', {
      access_token_enc: encryptSecret(pageToken),
      refresh_token_enc: null,
      account_id: ig.id,
      page_id: page.id,
      account_name: ig.username ? `@${ig.username}` : 'Instagram professional account',
      expires_at: null,
      metadata: {}
    });
  }
}

async function finishMetaOAuth(state, code) {
  const token = await exchangeMetaCode(code, callbackUrl(state.provider));
  await saveMetaAccounts(state.userId, token.access_token, state.provider);
}

async function finishTikTokOAuth(state, code) {
  requiredEnv(['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET']);
  const response = await fetchJson('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: callbackUrl('tiktok')
    })
  });
  const data = response.data || response;
  if (!data.access_token || !data.open_id) throw new Error('TikTok did not return an access token and account ID.');
  await saveConnection(state.userId, 'tiktok', {
    access_token_enc: encryptSecret(data.access_token),
    refresh_token_enc: data.refresh_token ? encryptSecret(data.refresh_token) : null,
    account_id: data.open_id,
    page_id: null,
    account_name: 'TikTok account',
    expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
    metadata: { refresh_expires_in: data.refresh_expires_in || null }
  });
}

async function finishOAuth(req, res) {
  const query = new URL(req.url, 'https://viralai.invalid').searchParams;
  const stateToken = query.get('state');
  const state = verifyState(stateToken);
  if (!PROVIDERS.has(state.provider)) throw new Error('OAuth provider was invalid.');
  const cookie = parseCookies(req)[`viralai_oauth_${state.provider}`];
  if (!cookie || cookie !== stateToken) throw new Error('OAuth state cookie did not match. Start the connection again.');
  res.setHeader('Set-Cookie', oauthCookie(state.provider, '', 0));
  if (query.has('error')) throw new Error(query.get('error_description') || 'The provider did not authorize ViralAI.');
  const code = query.get('code');
  if (!code) throw new Error('The provider did not return an authorization code.');
  if (state.provider === 'tiktok') await finishTikTokOAuth(state, code);
  else await finishMetaOAuth(state, code);
  redirectPage(res, state.provider, 'connected');
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    const query = new URL(req.url, 'https://viralai.invalid').searchParams;
    if (query.get('action') === 'start') return await beginOAuth(req, res, query.get('provider'));
    if (query.has('code') || query.has('state') || query.has('error')) return await finishOAuth(req, res);
    return json(res, 400, { error: 'Specify action=start and a provider to begin OAuth.' });
  } catch (error) {
    const query = new URL(req.url, 'https://viralai.invalid').searchParams;
    if (query.has('state')) {
      try {
        const state = verifyState(query.get('state'));
        return redirectPage(res, state.provider, 'error', safeMessage(error));
      } catch { /* Invalid state cannot be trusted for a postMessage target. */ }
    }
    return json(res, error.status || 500, { error: safeMessage(error) });
  }
}