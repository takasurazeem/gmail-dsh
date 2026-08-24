#!/usr/bin/env node
// gmail-dsh test suite — plain Node, no test framework.
//
// Runs from the source checkout (the dsh runtime packages are optional here;
// credential/tool-validation tests skip or run depending on resolvability)
// and from the installed copy in a profile's node_modules, where the real
// packages resolve and everything runs.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { normalizeConfig, Config, defaults } from './src/config.js';
import {
  generatePkce,
  generateState,
  buildAuthUrl,
  startCallbackServer,
  exchangeCode,
  refreshAccessToken,
  fetchUserInfo,
  resolveClient,
  accountSlug,
  accountKey,
  listAccounts,
  TOKEN_URL,
  USERINFO_URL,
} from './src/oauth.js';
import {
  b64urlEncode,
  b64urlDecode,
  rfc2047,
  buildRawMessage,
  flattenMessagePayload,
  messageHeaders,
  createGmailClient,
  generateMessageId,
  GMAIL_API_BASE,
} from './src/gmail.js';
import { approvalDecision } from './src/tools.js';

let dshTools = null;
let dshCredentials = null;
try {
  dshTools = await import('@deepseek-ai/dsh-tools');
} catch {
  // bare checkout outside a dsh profile — fine, the tests below adapt
}
try {
  dshCredentials = await import('@deepseek-ai/dsh-credentials');
} catch {
  // same
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['pass', name]);
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push(['fail', name]);
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function stubFetch(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  return () => {
    globalThis.fetch = real;
  };
}

function fakeCreds(records = {}) {
  return {
    records,
    async resolve() {
      return undefined;
    },
    async listRecords() {
      return Object.keys(records).map((k) => ({ key: k, kind: 'grant' }));
    },
    async readRecord(key) {
      return records[String(key)];
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records[String(key)]);
      records[String(key)] = next;
      return next;
    },
    async deleteRecord(key) {
      delete records[String(key)];
    },
  };
}

function fakeGmail() {
  const base = {
    async searchMessages() {
      return {
        messages: [
          {
            id: 'm1',
            threadId: 't1',
            labelIds: ['INBOX', 'UNREAD'],
            snippet: 'hi',
            payload: {
              headers: [
                { name: 'From', value: 'jane@example.com' },
                { name: 'To', value: 'me@x.com' },
                { name: 'Subject', value: 'Hello' },
                { name: 'Date', value: 'Wed, 1 Jul 2026 10:00:00 GMT' },
              ],
            },
          },
        ],
        nextPageToken: 'pg2',
      };
    },
    async getMessage(id) {
      if (id === 'm-html') {
        return {
          id,
          threadId: 't1',
          labelIds: ['INBOX'],
          payload: {
            headers: [
              { name: 'From', value: 'jane@example.com' },
              { name: 'Subject', value: 'Html' },
              { name: 'Date', value: 'Wed, 1 Jul 2026 10:00:00 GMT' },
            ],
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: b64urlEncode('plain body'), size: 12 } },
              { mimeType: 'text/html', body: { data: b64urlEncode('<b>html body</b>'), size: 17 } },
            ],
          },
        };
      }
      return {
        id,
        threadId: 't1',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'jane@example.com' },
            { name: 'To', value: 'me@x.com' },
            { name: 'Subject', value: 'Hello' },
            { name: 'Date', value: 'Wed, 1 Jul 2026 10:00:00 GMT' },
            { name: 'Message-ID', value: '<orig@x.com>' },
          ],
          mimeType: 'text/plain',
          body: { data: b64urlEncode('Hello world'), size: 11 },
        },
      };
    },
    async send() {
      return { id: 'new-msg', threadId: 't2' };
    },
    async reply(id) {
      return { id: 'new-reply', threadId: id };
    },
    async modifyMessage(id, changes) {
      return { id, ...changes };
    },
    async modifyThread(id, changes) {
      return { id, ...changes };
    },
    async listLabels() {
      return { labels: [{ id: 'INBOX' }] };
    },
  };
  // Record [method, account] for every call: regression for 2026-08-24, when
  // the tools resolved the account but never forwarded it to the client, so
  // getAccessToken got account=undefined and the credential key came out
  // invalid ("credential key segment '' must match ...").
  const calls = [];
  const wrapped = { calls };
  for (const [name, fn] of Object.entries(base)) {
    wrapped[name] = async (...args) => {
      calls.push([name, args.at(-1)?.account]);
      return fn(...args);
    };
  }
  return wrapped;
}

// ---------------------------------------------------------------- config

console.log('config');

await test('normalizeConfig: undefined gives defaults', () => {
  assert.deepEqual(normalizeConfig(undefined), defaults);
});

await test('normalizeConfig: partial and junk input is sanitized', () => {
  const c = normalizeConfig({
    clientId: 42,
    authTimeoutMs: 'soon',
    scopes: ['a', 7, 'b'],
    requireApproval: { send: false },
    context: { order: 5 },
  });
  assert.equal(c.clientId, '');
  assert.equal(c.authTimeoutMs, 300_000);
  assert.deepEqual(c.scopes, ['a', 'b']);
  assert.equal(c.requireApproval.send, false);
  assert.equal(c.requireApproval.labels, true);
  assert.equal(c.context.enabled, true);
  assert.equal(c.context.order, 5);
});

await test('Config.validate: cordis standard-schema accepts objects, reports issues otherwise', () => {
  const ok = Config['~standard'].validate({});
  assert.equal(ok.issues, undefined);
  assert.deepEqual(ok.value, defaults);
  const bad = Config['~standard'].validate('nope');
  assert.ok(bad.issues && bad.issues.length >= 1);
});

await test('Config.simplify normalizes for HMR write-back', () => {
  assert.deepEqual(Config.simplify({ scopes: [] }), defaults);
});

await test('default scopes include the OIDC scopes userinfo requires', () => {
  // Regression: without `openid`, the token exchange succeeds but Google's
  // userinfo endpoint rejects the access token (401 "Invalid Credentials"),
  // so the auth flow never stored a grant.
  for (const s of ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify']) {
    assert.ok(defaults.scopes.includes(s), `default scopes missing ${s}`);
  }
});

await test('bundle patch layer does not restate scopes (regression: stale patch pinned pre-oidc scopes)', () => {
  // The bundle's cordis.patch.yml is applied over the code defaults, so any
  // explicit `scopes` key in it silently wins over DEFAULT_SCOPES. On
  // 2026-08-24 a stale one-scope list there defeated the openid fix on
  // every restart until it was removed. The list must live in exactly one
  // place: src/config.js.
  const patch = readFileSync(fileURLToPath(new URL('./cordis.patch.yml', import.meta.url)), 'utf8');
  const lines = patch.split('\n').filter((l) => !/^\s*(#|$)/.test(l));
  assert.ok(
    !lines.some((l) => /^\s*scopes:\s*$/m.test(l) || /^\s*scopes:\s*['"\w]/m.test(l)),
    'cordis.patch.yml must not define a `scopes` key; DEFAULT_SCOPES in src/config.js is the source of truth',
  );
});

// ----------------------------------------------------------------- oauth

console.log('oauth');

await test('pkce: challenge is S256 of the verifier', () => {
  const { verifier, challenge } = generatePkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(generateState(), generateState());
});

await test('buildAuthUrl carries every required parameter', () => {
  const url = buildAuthUrl({
    clientId: 'cid',
    redirectUri: 'http://127.0.0.1:8765/cb',
    scopes: ['s1', 's2'],
    state: 'st',
    challenge: 'ch',
  });
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:8765/cb');
  assert.equal(u.searchParams.get('scope'), 's1 s2');
  assert.equal(u.searchParams.get('state'), 'st');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('code_challenge'), 'ch');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
});

await test('callback server: success callback resolves code+state and closes', async () => {
  const srv = await startCallbackServer({ host: '127.0.0.1', path: '/gmail/callback', timeoutMs: 5000 });
  assert.match(srv.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/gmail\/callback$/);
  const res = await fetch(`${srv.redirectUri}?code=4%2Fabc&state=xyz`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /authorization code received/);
  assert.deepEqual(await srv.wait, { code: '4/abc', state: 'xyz' });
  srv.close();
});

await test('callback server: Google error callback rejects with the error', async () => {
  const srv = await startCallbackServer({ host: '127.0.0.1', path: '/cb', timeoutMs: 5000 });
  const waitResult = assert.rejects(srv.wait, /access_denied/);
  const res = await fetch(`${srv.redirectUri}?error=access_denied&error_description=denied`);
  assert.equal(res.status, 400);
  await waitResult;
  srv.close();
});

await test('callback server: malformed callback rejects', async () => {
  const srv = await startCallbackServer({ host: '127.0.0.1', path: '/cb', timeoutMs: 5000 });
  const waitResult = assert.rejects(srv.wait, /missing code or state/);
  await fetch(srv.redirectUri);
  await waitResult;
  srv.close();
});

await test('callback server: timeout rejects', async () => {
  const srv = await startCallbackServer({ host: '127.0.0.1', path: '/cb', timeoutMs: 200 });
  await assert.rejects(srv.wait, /timed out/);
});

await test('callback server: aborted signal rejects without listening', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    startCallbackServer({ host: '127.0.0.1', path: '/cb', timeoutMs: 5000, signal: ac.signal }),
    /aborted/,
  );
});

await test('exchangeCode posts the authorization_code form with PKCE', async () => {
  const unstub = stubFetch(async (url, init) => {
    assert.equal(url, TOKEN_URL);
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), '4/slashcode');
    assert.equal(body.get('code_verifier'), 'verifier-x');
    assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:9/cb');
    assert.equal(body.get('client_id'), 'id');
    assert.equal(body.get('client_secret'), 'sec');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3500 }),
    };
  });
  try {
    const t = await exchangeCode({
      code: '4/slashcode',
      clientId: 'id',
      clientSecret: 'sec',
      redirectUri: 'http://127.0.0.1:9/cb',
      verifier: 'verifier-x',
    });
    assert.equal(t.refresh_token, 'rt');
    assert.equal(t.expires_in, 3500);
  } finally {
    unstub();
  }
});

await test('refreshAccessToken surfaces Google error details', async () => {
  const unstub = stubFetch(async () => ({
    ok: false,
    status: 400,
    text: async () => '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
  }));
  try {
    await assert.rejects(
      refreshAccessToken({ refreshToken: 'rt', clientId: 'id', clientSecret: 'sec' }),
      /Token has been expired or revoked/,
    );
  } finally {
    unstub();
  }
});

await test('fetchUserInfo returns email/name/sub', async () => {
  const unstub = stubFetch(async (url, init) => {
    assert.equal(url, USERINFO_URL);
    assert.equal(init.headers.authorization, 'Bearer AT');
    return {
      ok: true,
      status: 200,
      text: async () => '{"email":"Me@Gmail.com","name":"Me","sub":"123"}',
    };
  });
  try {
    const u = await fetchUserInfo('AT');
    assert.equal(u.email, 'Me@Gmail.com');
    assert.equal(u.name, 'Me');
    assert.equal(u.sub, '123');
  } finally {
    unstub();
  }
});

await test('resolveClient: credential refs win over literal config', async () => {
  const creds = fakeCreds();
  creds.resolve = async (ref) => {
    const r = String(ref);
    if (r === 'GMAIL_OAUTH_CLIENT_ID') return { value: 'ref-id', source: 'env' };
    if (r === 'GMAIL_OAUTH_CLIENT_SECRET') return { value: 'ref-sec', source: 'env' };
    return undefined;
  };
  const c = await resolveClient(creds, normalizeConfig({ clientId: 'literal' }));
  assert.equal(c.clientId, 'ref-id');
  assert.equal(c.clientSecret, 'ref-sec');
  assert.equal(c.complete, true);
});

await test('resolveClient: literal config values are a fallback', async () => {
  const creds = fakeCreds();
  const c = await resolveClient(creds, normalizeConfig({ clientId: 'lit-id', clientSecret: 'lit-sec' }));
  assert.equal(c.clientId, 'lit-id');
  assert.equal(c.clientSecret, 'lit-sec');
  assert.equal(c.complete, true);
});

await test('resolveClient: unset refs and no literals report incomplete', async () => {
  const creds = fakeCreds();
  const c = await resolveClient(creds, normalizeConfig({}));
  assert.equal(c.complete, false);
  assert.equal(c.clientId, undefined);
});

await test('resolveClient: a misnamed ref degrades to unset instead of throwing', async () => {
  const creds = fakeCreds();
  const c = await resolveClient(creds, normalizeConfig({ clientIdEnv: 'bad name!' }));
  assert.equal(c.complete, false);
});

await test('accountSlug: dots and @ become hyphens, lowercased', () => {
  assert.equal(accountSlug('Me@Gmail.com'), 'me-gmail-com');
  assert.equal(accountSlug('  A.B@X.Y  '), 'a-b-x-y');
});

if (dshCredentials) {
  await test('accountKey: brand key gmail-dsh/<slug>', () => {
    assert.equal(String(accountKey('Me@Gmail.com')), 'gmail-dsh/me-gmail-com');
  });
} else {
  await test('accountKey: skipped (dsh-credentials not resolvable in this checkout)', () => {});
}

await test('listAccounts: owner-scoped, payload emails, deduped and sorted', async () => {
  const creds = fakeCreds({
    'gmail-dsh/a-b-com': { kind: 'grant', payload: { email: 'a@b.com' } },
    'gmail-dsh/z-c-com': { kind: 'grant', payload: { email: 'z@c.com' } },
    'other-plugin/thing': { kind: 'grant', payload: { email: 'x@y.com' } },
  });
  assert.deepEqual(await listAccounts(creds), ['a@b.com', 'z@c.com']);
});

// ----------------------------------------------------------------- gmail

console.log('gmail');

await test('b64url: roundtrips, drops padding, keeps all four padding classes', () => {
  for (const s of ['abc', 'a b c', 'héllo wörld', '']) {
    const enc = b64urlEncode(s);
    assert.doesNotMatch(enc, /[+/=]/);
    assert.equal(b64urlDecode(enc), s);
  }
  assert.equal(b64urlEncode('a'), 'YQ');
  assert.equal(b64urlEncode('ab'), 'YWI');
  assert.equal(b64urlEncode('abc'), 'YWJj');
  assert.equal(b64urlEncode('abcd'), 'YWJjZA');
});

await test('rfc2047: ascii passthrough, non-ascii B-encoded', () => {
  assert.equal(rfc2047('Hello'), 'Hello');
  const enc = rfc2047('Héllo');
  assert.match(enc, /^=\?UTF-8\?B\?/);
  const b64 = enc.slice('=?UTF-8?B?'.length, -'?='.length);
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'Héllo');
});

await test('generateMessageId: unique and domain-matched', () => {
  const a = generateMessageId('me@gmail.com');
  const b = generateMessageId('me@gmail.com');
  assert.notEqual(a, b);
  assert.match(a, /@gmail\.com$/);
  assert.ok(generateMessageId('no-at-sign').endsWith('@gmail.com'));
});

await test('buildRawMessage: plain send with cc and non-ascii subject', () => {
  const raw = buildRawMessage({
    from: 'me@gmail.com',
    to: 'you@x.com',
    cc: 'cc@x.com',
    subject: 'Héllo',
    body: 'line1\nline2',
  });
  const msg = b64urlDecode(raw);
  const [head, bodyText] = msg.split('\r\n\r\n');
  assert.equal(bodyText, 'line1\nline2');
  assert.ok(head.startsWith('From: me@gmail.com\r\n'));
  assert.match(head, /To: you@x\.com/);
  assert.match(head, /Cc: cc@x\.com/);
  assert.match(head, /Subject: =\?UTF-8\?B\?/);
  assert.match(head, /MIME-Version: 1\.0/);
  assert.match(head, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(head, /Message-ID: <[0-9a-f]{16}[0-9a-z]+@gmail\.com>/);
  assert.doesNotMatch(head, /In-Reply-To/);
});

await test('buildRawMessage: reply carries In-Reply-To and References', () => {
  const raw = buildRawMessage({
    from: 'me@gmail.com',
    to: 'you@x.com',
    subject: 'Re: hi',
    body: 'b',
    inReplyTo: '<orig@x.com>',
    references: '<a@x> <orig@x>',
  });
  const msg = b64urlDecode(raw);
  assert.match(msg, /In-Reply-To: <orig@x\.com>/);
  assert.match(msg, /References: <a@x> <orig@x>/);
});

await test('flattenMessagePayload: plain text leaf', () => {
  const p = { mimeType: 'text/plain', body: { data: b64urlEncode('plain body'), size: 10 } };
  assert.deepEqual(flattenMessagePayload(p), { text: 'plain body', html: '', attachments: [] });
});

await test('flattenMessagePayload: multipart/alternative keeps both parts', () => {
  const p = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: b64urlEncode('plain') } },
      { mimeType: 'text/html', body: { data: b64urlEncode('<b>html</b>') } },
    ],
  };
  const f = flattenMessagePayload(p);
  assert.equal(f.text, 'plain');
  assert.equal(f.html, '<b>html</b>');
  assert.equal(f.attachments.length, 0);
});

await test('flattenMessagePayload: multipart/mixed lists attachments', () => {
  const p = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: b64urlEncode('body text') } },
      { mimeType: 'application/pdf', filename: 'doc.pdf', body: { data: b64urlEncode('%PDF-1.4 fake'), size: 16 } },
    ],
  };
  const f = flattenMessagePayload(p);
  assert.equal(f.text, 'body text');
  assert.equal(f.attachments.length, 1);
  assert.equal(f.attachments[0].filename, 'doc.pdf');
  assert.equal(f.attachments[0].size, 16);
});

await test('messageHeaders: collects the common set, case-insensitively', () => {
  const h = messageHeaders({
    headers: [
      { name: 'From', value: 'a@b.c' },
      { name: 'to', value: 'd@e.f' },
      { name: 'To', value: 'g@h.i' },
      { name: 'Subject', value: ' S ' },
      { name: 'Date', value: 'W, 1 Jan 2026' },
      { name: 'Message-Id', value: '<m@x>' },
      { name: 'In-Reply-To', value: '<n@x>' },
      { name: 'References', value: '<a> <b>' },
      { name: 'X-Weird', value: 'ignore' },
    ],
  });
  assert.equal(h.from, 'a@b.c');
  assert.deepEqual(h.to, ['d@e.f', 'g@h.i']);
  assert.equal(h.subject, 'S');
  assert.equal(h.date, 'W, 1 Jan 2026');
  assert.equal(h.messageId, '<m@x>');
  assert.equal(h.inReplyTo, '<n@x>');
  assert.deepEqual(h.references, ['<a> <b>']);
  assert.equal(messageHeaders(undefined).from, '');
});

await test('client: 200 returns parsed json and the token is sent', async () => {
  const tokens = [];
  const gmail = createGmailClient({
    getAccessToken: async () => {
      tokens.push('tok-1');
      return 'tok-1';
    },
  });
  const unstub = stubFetch(async (url, init) => {
    assert.match(url, /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\?q=new&maxResults=5/);
    assert.equal(init.headers.authorization, 'Bearer tok-1');
    return {
      ok: true,
      status: 200,
      text: async () => '{"messages":[{"id":"m1"}],"nextPageToken":"p2"}',
    };
  });
  try {
    const res = await gmail.searchMessages('new', { maxResults: 5 });
    assert.equal(res.messages[0].id, 'm1');
    assert.equal(res.nextPageToken, 'p2');
    assert.deepEqual(tokens, ['tok-1']);
  } finally {
    unstub();
  }
});

await test('client: account is forwarded to getAccessToken on every method (regression: empty credential segment)', async () => {
  const seen = [];
  const gmail = createGmailClient({
    getAccessToken: async (o) => {
      seen.push(o.account);
      return 'tok';
    },
  });
  const unstub = stubFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }));
  try {
    const A = 'me@example.com';
    await gmail.searchMessages('new', { account: A });
    await gmail.getMessage('m1', { account: A });
    await gmail.send('raw', { account: A });
    await gmail.reply('m1', 'raw', { account: A });
    await gmail.modifyMessage('m1', { addLabelIds: ['X'] }, { account: A });
    await gmail.modifyThread('t1', { addLabelIds: ['X'] }, { account: A });
    await gmail.listLabels({ account: A });
    assert.deepEqual(seen, [A, A, A, A, A, A, A], 'getAccessToken must receive the account for every call');
  } finally {
    unstub();
  }
});

await test('client: 401 forces a refresh and retries exactly once', async () => {
  const calls = [];
  const gmail = createGmailClient({
    getAccessToken: async ({ force }) => {
      calls.push(Boolean(force));
      return force ? 'fresh' : 'stale';
    },
  });
  let n = 0;
  const unstub = stubFetch(async (_url, init) => {
    n += 1;
    if (n === 1) {
      assert.equal(init.headers.authorization, 'Bearer stale');
      return { ok: false, status: 401, text: async () => 'invalid_grant' };
    }
    assert.equal(init.headers.authorization, 'Bearer fresh');
    return { ok: true, status: 200, text: async () => '{"labels":[]}' };
  });
  try {
    const res = await gmail.listLabels();
    assert.deepEqual(res.labels, []);
    assert.deepEqual(calls, [false, true]);
    assert.equal(n, 2);
  } finally {
    unstub();
  }
});

await test('client: non-401 errors surface with the API detail', async () => {
  const gmail = createGmailClient({ getAccessToken: async () => 't' });
  const unstub = stubFetch(async () => ({
    ok: false,
    status: 403,
    text: async () => '{"error":"quota exceeded"}',
  }));
  try {
    await assert.rejects(gmail.listLabels(), /403.*quota exceeded/s);
  } finally {
    unstub();
  }
});

await test('client: send posts the raw json body', async () => {
  const gmail = createGmailClient({ getAccessToken: async () => 't' });
  const unstub = stubFetch(async (url, init) => {
    assert.equal(url, `${GMAIL_API_BASE}/users/me/messages/send`);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { raw: 'aW5kZWg=' });
    return { ok: true, status: 200, text: async () => '{"id":"m9","threadId":"t9"}' };
  });
  try {
    const m = await gmail.send('aW5kZWg=');
    assert.equal(m.id, 'm9');
  } finally {
    unstub();
  }
});

await test('client: reply targets the message reply endpoint', async () => {
  const gmail = createGmailClient({ getAccessToken: async () => 't' });
  const unstub = stubFetch(async (url, init) => {
    assert.equal(url, `${GMAIL_API_BASE}/users/me/messages/m%201/reply`);
    assert.deepEqual(JSON.parse(init.body), { raw: 'r', isDraft: false });
    return { ok: true, status: 200, text: async () => '{"id":"r1","threadId":"t1"}' };
  });
  try {
    const m = await gmail.reply('m 1', 'r');
    assert.equal(m.id, 'r1');
  } finally {
    unstub();
  }
});

// ----------------------------------------------------------------- tools

console.log('tools');

await test('approvalDecision: gmail_send asks, naming recipient and subject', () => {
  const c = normalizeConfig({});
  const d = approvalDecision({ name: 'gmail_send', arguments: { to: 'x@y.com', subject: 'Hi' }, config: c });
  assert.deepEqual(d, { kind: 'ask', reason: 'Gmail: send email to x@y.com — "Hi"' });
});

await test('approvalDecision: gmail_labels asks, naming the change and target', () => {
  const c = normalizeConfig({});
  const d = approvalDecision({
    name: 'gmail_labels',
    arguments: { threadId: 't1', add: ['A'], remove: ['B'] },
    config: c,
  });
  assert.deepEqual(d, { kind: 'ask', reason: 'Gmail: add A and remove B on thread t1' });
});

await test('approvalDecision: read tools pass through', () => {
  const c = normalizeConfig({});
  for (const n of ['gmail_search', 'gmail_read', 'gmail_status']) {
    assert.equal(approvalDecision({ name: n, arguments: {}, config: c }), null);
  }
});

await test('approvalDecision: disabled gating passes through', () => {
  const c = normalizeConfig({ requireApproval: { send: false, labels: false } });
  assert.equal(approvalDecision({ name: 'gmail_send', arguments: { to: 'x' }, config: c }), null);
  assert.equal(approvalDecision({ name: 'gmail_labels', arguments: { messageId: 'm' }, config: c }), null);
});

// ------------------------------------------------------------ tool wiring

if (dshTools) {
  await test('registerTools: five definitions pass defineTool validation and execute', async () => {
    const { registerTools } = await import('./src/tools.js');
    const registered = [];
    const ctx = { tools: { register: (def) => registered.push(def) } };
    const gmail = fakeGmail();
    const gmailCalls = gmail.calls;
    registerTools(ctx, {
      config: normalizeConfig({}),
      creds: fakeCreds({ 'gmail-dsh/a-b-com': { kind: 'grant', payload: { email: 'a@b.com' } } }),
      gmail,
      resolveAccount: async () => 'a@b.com',
      listAccounts: async () => ['a@b.com'],
      checkClient: async () => ({ complete: true }),
    });
    assert.equal(registered.length, 5);
    assert.deepEqual(
      registered.map((d) => d.name).sort(),
      ['gmail_labels', 'gmail_read', 'gmail_search', 'gmail_send', 'gmail_status'],
    );
    const exec = { signal: new AbortController().signal };
    const byName = Object.fromEntries(registered.map((d) => [d.name, d]));

    const status = await byName.gmail_status.execute({}, exec);
    assert.equal(status.authorized, true);
    assert.deepEqual(status.accounts, ['a@b.com']);
    assert.equal(status.clientConfigured, true);

    const search = await byName.gmail_search.execute({ q: 'new' }, exec);
    assert.equal(search.account, 'a@b.com');
    assert.equal(search.pageToken, 'pg2');
    assert.equal(search.messages[0].subject, 'Hello');
    assert.equal(search.messages[0].from, 'jane@example.com');

    const read = await byName.gmail_read.execute({ messageId: 'm1' }, exec);
    assert.equal(read.text, 'Hello world');
    assert.equal(read.hasHtml, false);
    assert.equal(read.from, 'jane@example.com');

    // Regression 2026-08-24: the render referenced `args` (the parameter is
    // `_args`), so reading any message with an HTML part threw
    // "args is not defined" — 29 of 30 real reads crashed. The runtime
    // invokes output.render(args, value) right after execute; mirror it.
    const readHtml = await byName.gmail_read.execute({ messageId: 'm-html' }, exec);
    assert.equal(readHtml.hasHtml, true);
    assert.equal(readHtml.text, 'plain body');
    assert.equal(readHtml.html, ''); // html part is excluded unless includeHtml
    const rendered = byName.gmail_read.output.render({ messageId: 'm-html' }, readHtml);
    const renderedText = rendered.map((p) => p.text).join('');
    assert.match(renderedText, /re-run with includeHtml=true/);
    const readHtmlFull = await byName.gmail_read.execute({ messageId: 'm-html', includeHtml: true }, exec);
    assert.equal(readHtmlFull.hasHtml, true);
    assert.match(readHtmlFull.html, /html body/);
    const renderedFull = byName.gmail_read.output.render({ messageId: 'm-html', includeHtml: true }, readHtmlFull);
    assert.match(renderedFull.map((p) => p.text).join(''), /HTML part/);

    const sent = await byName.gmail_send.execute({ to: 'x@y.com', subject: 'Hi', body: 'there' }, exec);
    assert.equal(sent.messageId, 'new-msg');
    assert.equal(sent.account, 'a@b.com');
    assert.equal(sent.repliedTo, undefined);

    const replied = await byName.gmail_send.execute(
      { to: 'jane@example.com', subject: 'Re: Hello', body: 'yo', replyTo: 'm1' },
      exec,
    );
    assert.equal(replied.messageId, 'new-reply');
    assert.equal(replied.repliedTo, 'm1');

    const labeled = await byName.gmail_labels.execute({ messageId: 'm1', add: ['STARRED'] }, exec);
    assert.deepEqual(labeled.added, ['STARRED']);
    assert.match(labeled.target, /^message m1/);

    // Every client call must have carried the resolved account (never undefined).
    assert.ok(gmailCalls.length >= 5, 'expected several client calls');
    for (const [method, account] of gmailCalls) {
      assert.equal(account, 'a@b.com', `client ${method} called without the resolved account`);
    }
  });
} else {
  await test('registerTools: skipped (dsh-tools not resolvable in this checkout)', () => {});
}

// ------------------------------------------------------------------ index

await test('index.js: exports the plugin shape', async () => {
  const mod = await import('./index.js');
  assert.equal(mod.name, 'gmail-dsh');
  assert.deepEqual(mod.inject, ['tools', 'credentials', 'systemPrompt']);
  assert.equal(typeof mod.apply, 'function');
  assert.ok(mod.Config);
});

// ---------------------------------------------------------------- summary

const failed = results.filter(([s]) => s === 'fail').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
