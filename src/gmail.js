// Minimal Gmail API v1 REST client plus MIME helpers. Pure functions and a
// small client over fetch; no third-party dependencies.

import { randomBytes } from 'node:crypto';
import { truncate } from './oauth.js';

export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

/** base64url without padding (Gmail's wire format for message `raw`). */
export function b64urlEncode(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(input) {
  if (!input) return '';
  let b64 = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  if (pad) b64 += '='.repeat(pad);
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** RFC 2047 B-encoding for header values that are not plain ASCII. */
export function rfc2047(value) {
  const s = String(value ?? '');
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** A unique, well-formed Message-ID for an outgoing message. */
export function generateMessageId(from) {
  const domain = typeof from === 'string' && from.includes('@') ? from.split('@').pop() : 'gmail.com';
  return `${randomBytes(8).toString('hex')}${Date.now().toString(36)}@${domain}`;
}

/**
 * Build the base64url RFC 822 payload for `messages.send` / `messages.reply`.
 * `from` must be the verified email of the account whose token signs the
 * request — Gmail rejects unverified From senders.
 */
export function buildRawMessage({ from, to, cc = '', bcc = '', subject = '', body = '', inReplyTo, references }) {
  const lines = [`From: ${from}`, `To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${rfc2047(subject)}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push(`Message-ID: <${generateMessageId(from)}>`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  return b64urlEncode(lines.join('\r\n') + '\r\n\r\n' + body);
}

/**
 * Flatten a Gmail message payload tree into { text, html, attachments }.
 * `text` joins every non-attachment text/plain leaf in document order,
 * `html` likewise for text/html, and attachments are leaf parts that carry
 * a filename.
 */
export function flattenMessagePayload(payload) {
  const textParts = [];
  const htmlParts = [];
  const attachments = [];
  const walk = (node) => {
    if (node && Array.isArray(node.parts) && node.parts.length > 0) {
      for (const part of node.parts) walk(part);
      return;
    }
    const type = String(node?.mimeType || 'text/plain').toLowerCase();
    const data = node?.body?.data ? b64urlDecode(node.body.data) : '';
    if (node?.filename) {
      attachments.push({
        filename: String(node.filename),
        mimeType: type,
        size: typeof node?.body?.size === 'number' ? node.body.size : Buffer.byteLength(data),
      });
      return;
    }
    if (type === 'text/plain') textParts.push(data);
    else if (type === 'text/html') htmlParts.push(data);
  };
  walk(payload);
  return { text: textParts.join('\r\n'), html: htmlParts.join('\r\n'), attachments };
}

/** The common headers a Gmail message needs, in a single pass. */
export function messageHeaders(payload) {
  const out = {
    from: '',
    to: [],
    cc: [],
    subject: '',
    date: '',
    messageId: '',
    inReplyTo: '',
    references: [],
  };
  for (const h of payload?.headers ?? []) {
    const k = String(h?.name || '').toLowerCase();
    const v = String(h?.value || '').trim();
    if (!v) continue;
    if (k === 'from') out.from = v;
    else if (k === 'to') out.to.push(v);
    else if (k === 'cc') out.cc.push(v);
    else if (k === 'subject') out.subject = v;
    else if (k === 'date') out.date = v;
    else if (k === 'message-id') out.messageId = v;
    else if (k === 'in-reply-to') out.inReplyTo = v;
    else if (k === 'references') out.references.push(v);
  }
  return out;
}

/**
 * A small Gmail REST client. `getAccessToken({account, force, signal})` is
 * supplied by the plugin (it owns the credential store and the in-process
 * token cache); a 401 triggers one forced refresh and a single retry.
 *
 * `account` is threaded through every call: the plugin resolves the tool's
 * `account` param (or the single/default account) and passes it here, so the
 * token is fetched for the right credential record. It must NOT be optional
 * in practice — an empty account yields an invalid credential key.
 */
export function createGmailClient({ getAccessToken }) {
  const request = async (path, { method = 'GET', query, body, signal, forceRefresh = false, account } = {}) => {
    const doFetch = async (force) => {
      const token = await getAccessToken({ account, force, signal });
      const params = query
        ? Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
        : [];
      // Array values must repeat the key (metadataHeaders=From&metadataHeaders=To).
      // `new URLSearchParams(Object.entries(...))` flattens an array to one
      // comma-joined value, which Gmail silently ignores — the bug that made
      // every search row render without a sender or subject.
      const search = new URLSearchParams();
      for (const [k, v] of params) {
        if (Array.isArray(v)) for (const item of v) search.append(k, item);
        else search.append(k, v);
      }
      const qs = search.toString();
      const url = GMAIL_API_BASE + path + (qs ? `?${qs}` : '');
      return fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    };
    let res = await doFetch(forceRefresh);
    if (!res.ok && !forceRefresh) {
      const detail = await res.text();
      // A 401 is an expired access token. A 403 `insufficientPermissions` is
      // a *stale* one: the cached access token was minted before the user
      // granted a new scope (e.g. gmail.modify added to the consent screen),
      // so it carries the old scope set and every call fails until the token
      // is re-minted. Both clear on a forced refresh; a genuine 403 quota
      // error must not be retried, so the body decides.
      const retryable =
        res.status === 401 || /insufficient|PERMISSION_DENIED|ACCESS_TOKEN_SCOPE/i.test(detail);
      if (retryable) {
        res = await doFetch(true);
        if (!res.ok) {
          const retryDetail = await res.text();
          throw new Error(`Gmail API ${method} ${path} failed (${res.status}): ${truncate(retryDetail, 400)}`);
        }
      } else {
        throw new Error(`Gmail API ${method} ${path} failed (${res.status}): ${truncate(detail, 400)}`);
      }
    } else if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Gmail API ${method} ${path} failed (${res.status}): ${truncate(detail, 400)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  };

  // `messages.list` returns ONLY { id, threadId } — it has no format or
  // metadataHeaders parameter (those belong to `messages.get`), so asking
  // for them on the list call is silently ignored. Headers must therefore
  // be hydrated with one `messages.get?format=metadata` per hit; without
  // this every search row rendered as "unknown date / unknown sender".
  const HEADER_NAMES = ['From', 'To', 'Subject', 'Date'];

  async function hydrateMetadata(ids, opts) {
    const out = new Array(ids.length);
    const CONCURRENCY = 8;
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        try {
          out[i] = await request(`/users/me/messages/${encodeURIComponent(ids[i])}`, {
            query: { format: 'metadata', metadataHeaders: HEADER_NAMES },
            signal: opts.signal,
            account: opts.account,
          });
        } catch {
          // A single unreadable message must not fail the whole search;
          // leave it as a bare id so the row still renders.
          out[i] = { id: ids[i] };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    return out;
  }

  return {
    searchMessages: async (q, opts = {}) => {
      const page = await request('/users/me/messages', {
        query: { q, maxResults: opts.maxResults ?? 20, pageToken: opts.pageToken },
        signal: opts.signal,
        account: opts.account,
      });
      const ids = (page.messages ?? []).map((m) => m.id).filter(Boolean);
      if (!ids.length) return page;
      const full = await hydrateMetadata(ids, opts);
      return { ...page, messages: full };
    },
    getMessage: (messageId, opts = {}) =>
      request(`/users/me/messages/${encodeURIComponent(messageId)}`, {
        signal: opts.signal,
        account: opts.account,
      }),
    send: (raw, opts = {}) =>
      request('/users/me/messages/send', {
        method: 'POST',
        body: { raw },
        signal: opts.signal,
        account: opts.account,
      }),
    reply: (messageId, raw, opts = {}) =>
      request(`/users/me/messages/${encodeURIComponent(messageId)}/reply`, {
        method: 'POST',
        body: { raw, isDraft: false },
        signal: opts.signal,
        account: opts.account,
      }),
    modifyMessage: (messageId, changes, opts = {}) =>
      request(`/users/me/messages/${encodeURIComponent(messageId)}/modify`, {
        method: 'POST',
        body: changes,
        signal: opts.signal,
        account: opts.account,
      }),
    modifyThread: (threadId, changes, opts = {}) =>
      request(`/users/me/threads/${encodeURIComponent(threadId)}/modify`, {
        method: 'POST',
        body: changes,
        signal: opts.signal,
        account: opts.account,
      }),
    listLabels: (opts = {}) => request('/users/me/labels', { signal: opts.signal, account: opts.account }),
  };
}
