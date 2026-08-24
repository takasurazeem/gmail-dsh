// Google OAuth 2.0 for desktop (installed-app) clients: PKCE, an ephemeral
// loopback callback server, token exchange/refresh, and grant storage in
// the DSH credential store. No third-party dependencies.
//
// The server bound here is loopback-only and lives for one authorization.
// Only the short-lived authorization code crosses it — never a token — and
// it is closed as soon as the callback (or the timeout) arrives.

import { randomBytes, createHash } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';

import { OWNER } from './config.js';

// The dsh runtime provides these packages; a bare-repo test run can import
// this module without them, so the import is tolerant and every use site
// fails loudly with an actionable message when one is actually needed.
let dshCredentials;
try {
  dshCredentials = await import('@deepseek-ai/dsh-credentials');
} catch {
  dshCredentials = null;
}

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

// Same grammar as dsh-credentials' REF_PATTERN, so a misnamed ref degrades
// to "unset" (with a clear downstream error) instead of throwing here.
const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function truncate(value, limit = 300) {
  const s = String(value ?? '');
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/** PKCE pair (S256). The verifier is 43 base64url chars — inside RFC 7636 bounds. */
export function generatePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function generateState() {
  return randomBytes(16).toString('base64url');
}

export function buildAuthUrl({ clientId, redirectUri, scopes, state, challenge, prompt = 'consent' }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: Array.isArray(scopes) ? scopes.join(' ') : String(scopes),
    state,
    access_type: 'offline',
    prompt,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_ENDPOINT}?${q.toString()}`;
}

/**
 * Ephemeral loopback server for the OAuth callback. Google's Desktop
 * client type accepts http://127.0.0.1:<any port> redirects, so no fixed
 * port or pre-registered redirect URI is required.
 *
 * @returns {Promise<{port: number, redirectUri: string, wait: Promise<{code: string, state: string}>, close: () => void}>}
 * `wait` resolves with the callback's code/state, or rejects on an OAuth
 * error, a malformed callback, the timeout, or abort.
 */
export function startCallbackServer({ host, path, timeoutMs = 300_000, signal }) {
  const deferred = {};
  const wait = new Promise((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  // Never leave `wait` rejected-unobserved (Node crashes on unhandled
  // rejections); awaiters still receive the rejection through their own
  // handler.
  wait.catch(() => {});
  let done = false;
  let timer = null;
  let onAbort = null;

  const finish = (fn, value) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    if (server.listening) server.close();
    fn(value);
  };

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (req.method !== 'GET' || url.pathname !== path) {
      res.writeHead(404);
      res.end();
      return;
    }
    const page = (status, message) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body><p>${message} You can close this window.</p></body></html>`);
    };
    const error = url.searchParams.get('error');
    if (error) {
      const detail = url.searchParams.get('error_description') ? ` — ${url.searchParams.get('error_description')}` : '';
      page(400, `Gmail authorization failed: ${error}${detail}.`);
      finish(deferred.reject, new Error(`Google returned an OAuth error: ${error}${detail}`));
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      page(400, 'Gmail authorization failed: the callback is missing code or state.');
      finish(deferred.reject, new Error('OAuth callback is missing code or state'));
      return;
    }
    // Deliberately not "authorized": the code has arrived, but the flow can
    // still fail after this point (token exchange, userinfo). The chat
    // message from /gmail auth is the word of record.
    page(200, 'Gmail authorization code received — check the DeepSeek Harness chat for the final result. You can close this window.');
    finish(deferred.resolve, { code, state });
  });

  timer = setTimeout(
    () => finish(deferred.reject, new Error(`OAuth callback timed out after ${Math.round(timeoutMs / 1000)}s without a response`)),
    timeoutMs,
  );
  timer.unref?.();
  if (signal) {
    onAbort = () => finish(deferred.reject, new Error('authorization aborted'));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('authorization aborted'));
      return;
    }
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      resolve({
        port,
        redirectUri: `http://${host}:${port}${path}`,
        wait,
        close: () => {
          if (server.listening) server.close();
        },
      });
    });
  });
}

async function postForm(url, params, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const detail = json?.error_description || json?.error || text;
    throw new Error(`OAuth request to ${url} failed (${res.status}): ${truncate(detail, 300)}`);
  }
  return json ?? {};
}

/** Exchange an authorization code for tokens (PKCE verifier + client secret). */
export function exchangeCode({ code, clientId, clientSecret, redirectUri, verifier, signal }) {
  return postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: verifier,
  }, signal);
}

/** Refresh a stored refresh token into a fresh access token. */
export function refreshAccessToken({ refreshToken, clientId, clientSecret, signal }) {
  return postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }, signal);
}

/** Verified email/name for an access token (OIDC userinfo endpoint). */
export async function fetchUserInfo(accessToken, signal) {
  const res = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`userinfo request failed (${res.status}): ${truncate(text, 200)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('userinfo response was not JSON');
  }
  if (!json.email) throw new Error('Google userinfo did not include an email address');
  return {
    email: String(json.email),
    name: json.name ? String(json.name) : '',
    sub: json.sub ? String(json.sub) : '',
  };
}

/** Best-effort open of the default browser; returns whether it started. */
export function tryOpenBrowser(url) {
  try {
    if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsVerbatimArguments: true }).unref();
    else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the OAuth client id/secret: the credential store first (which
 * itself layers over the process environment), then literal config values
 * as a discouraged fallback.
 */
export async function resolveClient(creds, config) {
  const ref = (name) => {
    if (typeof name !== 'string' || !REF_NAME.test(name)) return undefined;
    return dshCredentials ? dshCredentials.credentialRef(name) : name;
  };
  const fromRef = async (name) => {
    const r = ref(name);
    if (!r) return undefined;
    const hit = await creds.resolve(r);
    return hit && hit.value ? { value: hit.value, source: hit.source } : undefined;
  };
  const id = (await fromRef(config.clientIdEnv)) ?? (config.clientId ? { value: config.clientId, source: 'config' } : undefined);
  const secret = (await fromRef(config.clientSecretEnv)) ?? (config.clientSecret ? { value: config.clientSecret, source: 'config' } : undefined);
  return {
    clientId: id?.value,
    clientSecret: secret?.value,
    source: id?.source,
    complete: Boolean(id?.value && secret?.value),
  };
}

/**
 * Stable credential-store id for an email address. Key segments are limited
 * to lowercase identifiers, so dots and @ are slugified; the canonical
 * address stays in the record payload, and tools match on it. (Two emails
 * that slugify identically share one record — the later authorization
 * wins; in practice this collision is negligible.)
 */
export function accountSlug(email) {
  return String(email ?? '').trim().toLowerCase().replace(/[.@]/g, '-');
}

export function accountKey(email) {
  if (!dshCredentials) throw new Error('@deepseek-ai/dsh-credentials is not available in this runtime');
  return dshCredentials.credentialKey(OWNER, accountSlug(email));
}

/** All authorized Gmail accounts: the payload emails of this plugin's grant records. */
export async function listAccounts(creds) {
  const entries = await creds.listRecords();
  const keys = entries
    .map((e) => String(e.key))
    .filter((k) => k.startsWith(`${OWNER}/`))
    .map((k) => k.slice(OWNER.length + 1));
  const emails = new Set();
  for (const k of keys) {
    const rec = await creds.readRecord(`${OWNER}/${k}`);
    const email = rec && rec.payload ? rec.payload.email : undefined;
    if (typeof email === 'string' && email) emails.add(email.toLowerCase());
  }
  return [...emails].sort();
}
