import { createClient } from '@supabase/supabase-js';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

export const PROVIDERS = new Set(['facebook', 'instagram', 'tiktok']);

export function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  json(res, 405, { error: 'Method not allowed.' });
}

export function requiredEnv(names) {
  const missing = names.filter(name => !process.env[name]);
  if (missing.length) throw new Error(`Server is missing configuration: ${missing.join(', ')}`);
}

export function getAdminClient() {
  requiredEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export async function requireUser(req) {
  requiredEnv(['SUPABASE_URL', 'SUPABASE_ANON_KEY']);
  const authorization = req.headers.authorization || '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    const error = new Error('Sign in before connecting or publishing.');
    error.status = 401;
    throw error;
  }
  const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data, error: authError } = await authClient.auth.getUser(token);
  if (authError || !data.user) {
    const error = new Error('Your session expired. Refresh the app and try again.');
    error.status = 401;
    throw error;
  }
  return { user: data.user, accessToken: token };
}

export function appUrl() {
  requiredEnv(['APP_URL']);
  return process.env.APP_URL.replace(/\/$/, '');
}

export function callbackUrl(provider) {
  const configured = provider === 'tiktok' ? process.env.TIKTOK_REDIRECT_URI : process.env.META_REDIRECT_URI;
  return configured || `${appUrl()}/api/oauth`;
}

function encryptionKey() {
  const key = process.env.TOKEN_ENCRYPTION_KEY || '';
  if (!/^[a-f\d]{64}$/i.test(key)) throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.');
  return Buffer.from(key, 'hex');
}

export function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(value) {
  const [version, iv, tag, encrypted] = String(value || '').split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Stored credential has an invalid format.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

function stateSecret() {
  requiredEnv(['OAUTH_STATE_SECRET']);
  if (process.env.OAUTH_STATE_SECRET.length < 32) throw new Error('OAUTH_STATE_SECRET must be at least 32 characters.');
  return process.env.OAUTH_STATE_SECRET;
}

export function signState(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', stateSecret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyState(value) {
  const [encoded, signature] = String(value || '').split('.');
  if (!encoded || !signature) throw new Error('OAuth state is missing or invalid.');
  const expected = createHmac('sha256', stateSecret()).update(encoded).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('OAuth state signature did not match.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!payload.issuedAt || Date.now() - payload.issuedAt > 10 * 60 * 1000) throw new Error('OAuth request expired. Start again.');
  return payload;
}

export function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
    const separator = part.indexOf('=');
    if (separator < 0) return ['', ''];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([name]) => name));
}

export function oauthCookie(provider, value, maxAge = 600) {
  return `viralai_oauth_${provider}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth; Max-Age=${maxAge}`;
}

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error?.message || payload.error_description || payload.message || `Provider request failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status >= 500 ? 502 : 400;
    throw error;
  }
  return payload;
}

export async function saveConnection(userId, provider, values) {
  const admin = getAdminClient();
  const { error } = await admin.from('social_connections').upsert({
    user_id: userId,
    provider,
    ...values,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,provider' });
  if (error) throw new Error(`Could not save ${provider} connection: ${error.message}`);
}

export async function getConnection(userId, provider) {
  const admin = getAdminClient();
  const { data, error } = await admin.from('social_connections')
    .select('*').eq('user_id', userId).eq('provider', provider).maybeSingle();
  if (error) throw new Error(`Could not load ${provider} connection: ${error.message}`);
  return data;
}

export function publicConnection(row) {
  return {
    provider: row.provider,
    accountName: row.account_name || null,
    connectedAt: row.created_at
  };
}

export function graphVersion() {
  return process.env.META_GRAPH_VERSION || 'v22.0';
}

export function safeMessage(error) {
  return error?.status ? error.message : 'The server could not complete this request. Check the deployment configuration and try again.';
}