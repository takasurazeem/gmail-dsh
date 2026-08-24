// The five native Gmail tools, each a dsh-tools `defineTool` registration:
// typed parameters, an explicit canonical output schema, a text render for
// the model, and a pure approval-decision helper used by the pre-execute
// gate in index.js.
//
// Reads (search / read / status) never prompt. `gmail_send` and
// `gmail_labels` return {kind:'ask'} from `tools/pre-execute`, which the
// approval service turns into a user prompt (degrading to deny when no
// approval service is mounted).

import {
  buildRawMessage,
  flattenMessagePayload,
  messageHeaders,
} from './gmail.js';

// The dsh runtime provides @deepseek-ai/dsh-tools; a bare-repo test run can
// import this module without it, so the import is tolerant and every use
// site fails loudly with an actionable message when it is actually needed.
let dshTools;
try {
  dshTools = await import('@deepseek-ai/dsh-tools');
} catch {
  dshTools = null;
}

const dt = (def) => {
  if (!dshTools) throw new Error('@deepseek-ai/dsh-tools is not available in this runtime');
  return dshTools.defineTool(def);
};

const text = (s) => [{ type: 'text', text: String(s) }];

function messageLine(m) {
  const who = m.from || 'unknown sender';
  const subject = m.subject || '(no subject)';
  const labels = m.labels && m.labels.length ? `  [${m.labels.join(', ')}]` : '';
  const thread = m.threadId ? `  (thread ${m.threadId})` : '';
  return `${m.id}  ${m.date || 'unknown date'}  ${who}  ${subject}${labels}${thread}`;
}

/**
 * Register the five Gmail tools on the tool runtime.
 *
 * @param {object} ctx cordis context (must provide `tools`).
 * @param {object} deps plugin-owned helpers:
 *   config — normalized row config
 *   creds  — the credentials provider
 *   gmail  — client from createGmailClient()
 *   resolveAccount(arg) — tool `account` param -> authorized email
 *   listAccounts()      -> string[] of authorized emails
 *   checkClient()       -> {complete, missing}
 */
export function registerTools(ctx, deps) {
  const { config, creds, gmail, resolveAccount, listAccounts, checkClient } = deps;

  ctx.tools.register(dt({
    name: 'gmail_status',
    description:
      'Gmail authorization status for this harness: the authorized accounts, the default account, the OAuth scopes in use, and whether the Google OAuth client is configured. Call it first when unsure whether Gmail is set up.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          authorized: { type: 'boolean', required: true },
          accounts: { type: 'array', items: { type: 'string' }, required: true },
          defaultAccount: { type: 'string', required: true },
          scopes: { type: 'array', items: { type: 'string' }, required: true },
          clientConfigured: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, v) =>
        text(
          v.authorized
            ? `Gmail authorized: ${v.accounts.join(', ')}${v.defaultAccount ? ` (default ${v.defaultAccount})` : ''}. Scopes: ${v.scopes.join(', ')}.`
            : `Gmail is not authorized. The user should run /gmail auth${v.clientConfigured ? '' : ' after configuring the Google OAuth client'}.`,
        ),
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute() {
      const accounts = await listAccounts();
      const defaultAccount = config.defaultAccount || (accounts.length === 1 ? accounts[0] : '');
      const client = await checkClient();
      return {
        authorized: accounts.length > 0,
        accounts,
        defaultAccount,
        scopes: config.scopes,
        clientConfigured: client.complete,
      };
    },
  }));

  ctx.tools.register(dt({
    name: 'gmail_search',
    description:
      'Search the authorized Gmail mailbox with Gmail query syntax, newest first (e.g. "is:unread", "from:boss@example.com", "has:attachment newer_than:1w", "older_than:7d is:starred"). If the result carries a non-empty pageToken, pass it back with the same q to continue.',
    parameters: {
      q: { type: 'string', required: true, description: 'Gmail search query' },
      maxResults: { type: 'integer', description: 'Page size, 1–100 (default 20)' },
      pageToken: { type: 'string', description: 'Token from a previous page, to continue' },
      account: { type: 'string', description: 'Specific authorized account (email); omit for the default' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          account: { type: 'string', required: true },
          pageToken: { type: 'string', required: true },
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                threadId: { type: 'string' },
                from: { type: 'string' },
                to: { type: 'array', items: { type: 'string' } },
                subject: { type: 'string' },
                date: { type: 'string' },
                snippet: { type: 'string' },
                labels: { type: 'array', items: { type: 'string' } },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, v) =>
        text(
          v.messages.length
            ? `Gmail results for ${v.account} (newest first):\n${v.messages.map(messageLine).join('\n')}`
            : `No messages matched "${v.q}" for ${v.account}.`,
        ),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const acct = await resolveAccount(args.account);
      const maxResults = Math.min(100, Math.max(1, Number(args.maxResults ?? 20)));
      const res = await gmail.searchMessages(args.q, {
        maxResults,
        pageToken: args.pageToken,
        account: acct,
        signal: exec.signal,
      });
      const messages = (res.messages ?? []).map((m) => {
        const headers = m.payload?.headers ?? [];
        const first = (name) => {
          const h = headers.find((x) => x.name && x.name.toLowerCase() === name);
          return h?.value ?? '';
        };
        return {
          id: m.id,
          threadId: m.threadId ?? '',
          from: first('from'),
          to: headers.filter((x) => x.name && x.name.toLowerCase() === 'to').map((x) => x.value),
          subject: first('subject'),
          date: first('date'),
          snippet: m.snippet ?? '',
          labels: m.labelIds ?? [],
        };
      });
      return {
        account: acct,
        pageToken: res.nextPageToken ?? '',
        messages,
      };
    },
  }));

  ctx.tools.register(dt({
    name: 'gmail_read',
    description:
      'Read one Gmail message in full: plain-text body (the HTML part only when includeHtml is true), headers, attachments, and labels. Pass a message id from gmail_search.',
    parameters: {
      messageId: { type: 'string', required: true, description: 'Message id from gmail_search' },
      includeHtml: { type: 'boolean', description: 'Also return the HTML part when present (default false)' },
      account: { type: 'string', description: 'Specific authorized account (email); omit for the default' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          account: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
          threadId: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'array', items: { type: 'string' }, required: true },
          cc: { type: 'array', items: { type: 'string' }, required: true },
          subject: { type: 'string', required: true },
          date: { type: 'string', required: true },
          inReplyTo: { type: 'string', required: true },
          labelIds: { type: 'array', items: { type: 'string' }, required: true },
          text: { type: 'string', required: true },
          html: { type: 'string', required: true },
          hasHtml: { type: 'boolean', required: true },
          attachments: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                filename: { type: 'string' },
                mimeType: { type: 'string' },
                size: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, v) => {
        const lines = [
          `From: ${v.from || 'unknown'}`,
          `To: ${v.to.join(', ')}`,
          ...(v.cc.length ? [`Cc: ${v.cc.join(', ')}`] : []),
          `Date: ${v.date || 'unknown'}`,
          `Subject: ${v.subject || '(no subject)'}`,
          '',
        ];
        let body = v.text || '(no plain-text body)';
        const cap = 24_000;
        if (body.length > cap) {
          body = `${body.slice(0, cap)}\n… [truncated in the model view; the full text is in the stored result]`;
        }
        // Regression 2026-08-24: this body used to reference `args` (the
        // parameter is `_args`), so reading any message with an HTML part
        // threw "args is not defined".
        if (v.hasHtml && !_args.includeHtml) {
          body = `${body}\n\n[The message also has an HTML part — re-run with includeHtml=true to include it.]`;
        }
        if (v.html && _args.includeHtml) {
          body = `${body}\n\n[HTML part]\n${v.html}`;
        }
        const attach = v.attachments.length
          ? `\n\nAttachments:\n${v.attachments.map((a) => `  ${a.filename} (${a.mimeType}, ${a.size} bytes)`).join('\n')}`
          : '';
        return text(lines.join('\n') + body + attach);
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const acct = await resolveAccount(args.account);
      const m = await gmail.getMessage(args.messageId, { account: acct, signal: exec.signal });
      const h = messageHeaders(m.payload);
      const flat = flattenMessagePayload(m.payload);
      return {
        account: acct,
        messageId: m.id,
        threadId: m.threadId ?? '',
        from: h.from,
        to: h.to,
        cc: h.cc,
        subject: h.subject,
        date: h.date,
        inReplyTo: h.inReplyTo,
        labelIds: m.labelIds ?? [],
        text: flat.text,
        html: args.includeHtml ? flat.html : '',
        hasHtml: flat.html !== '',
        attachments: flat.attachments,
      };
    },
  }));

  ctx.tools.register(dt({
    name: 'gmail_send',
    description:
      'Send a plain-text email from the authorized Gmail account. Requires user approval before it runs. To reply inside an existing thread, pass replyTo (a message id from gmail_search or gmail_read); the reply is threaded automatically.',
    parameters: {
      to: { type: 'string', required: true, description: 'Recipient address or comma-separated addresses' },
      cc: { type: 'string', description: 'Optional Cc, comma-separated' },
      subject: { type: 'string', required: true },
      body: { type: 'string', required: true, description: 'Plain-text UTF-8 body' },
      replyTo: { type: 'string', description: 'Message id to reply to (threads the reply)' },
      account: { type: 'string', description: 'Specific authorized account (email); omit for the default' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          account: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
          threadId: { type: 'string', required: true },
          to: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          repliedTo: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, v) =>
        text(
          `Sent from ${v.account} to ${v.to}: "${v.subject}" (message ${v.messageId}${v.threadId ? `, thread ${v.threadId}` : ''}${v.repliedTo ? `, reply to ${v.repliedTo}` : ''}).`,
        ),
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const acct = await resolveAccount(args.account);
      if (args.replyTo) {
        const orig = await gmail.getMessage(args.replyTo, { account: acct, signal: exec.signal });
        const oh = messageHeaders(orig.payload);
        const references = [...oh.references, oh.messageId].filter(Boolean).join(' ');
        const raw = buildRawMessage({
          from: acct,
          to: args.to,
          cc: args.cc,
          subject: args.subject,
          body: args.body,
          inReplyTo: oh.messageId || args.replyTo,
          references,
        });
        const m = await gmail.reply(args.replyTo, raw, { account: acct, signal: exec.signal });
        return {
          account: acct,
          messageId: m.id,
          threadId: m.threadId ?? '',
          to: args.to,
          subject: args.subject,
          repliedTo: args.replyTo,
        };
      }
      const raw = buildRawMessage({
        from: acct,
        to: args.to,
        cc: args.cc,
        subject: args.subject,
        body: args.body,
      });
      const m = await gmail.send(raw, { account: acct, signal: exec.signal });
      return {
        account: acct,
        messageId: m.id,
        threadId: m.threadId ?? '',
        to: args.to,
        subject: args.subject,
      };
    },
  }));

  ctx.tools.register(dt({
    name: 'gmail_labels',
    description:
      'Add and/or remove Gmail labels on one message, or on every message in a thread. Requires user approval before it runs. System label ids include INBOX, STARRED, UNREAD, SENT, TRASH, DRAFT; user label ids appear in gmail_read results.',
    parameters: {
      messageId: { type: 'string', description: 'A message id (provide this or threadId, not both)' },
      threadId: { type: 'string', description: 'A thread id — applies to every message in it' },
      add: { type: 'array', items: { type: 'string' }, description: 'Label ids to add' },
      remove: { type: 'array', items: { type: 'string' }, description: 'Label ids to remove' },
      account: { type: 'string', description: 'Specific authorized account (email); omit for the default' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          account: { type: 'string', required: true },
          target: { type: 'string', required: true },
          added: { type: 'array', items: { type: 'string' }, required: true },
          removed: { type: 'array', items: { type: 'string' }, required: true },
        },
        additionalProperties: false,
      },
      render: (_args, v) =>
        text(
          `Labels updated on ${v.target} for ${v.account}: added [${v.added.join(', ')}], removed [${v.removed.join(', ')}].`,
        ),
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const hasMessage = Boolean(args.messageId);
      const hasThread = Boolean(args.threadId);
      if (hasMessage === hasThread) {
        throw new dshTools.ToolArgsError('gmail_labels requires exactly one of messageId or threadId.');
      }
      const add = Array.isArray(args.add) ? args.add : [];
      const remove = Array.isArray(args.remove) ? args.remove : [];
      if (add.length === 0 && remove.length === 0) {
        throw new dshTools.ToolArgsError('gmail_labels requires at least one of add or remove.');
      }
      const acct = await resolveAccount(args.account);
      const changes = { addLabelIds: add, removeLabelIds: remove };
      const m = hasMessage
        ? await gmail.modifyMessage(args.messageId, changes, { account: acct, signal: exec.signal })
        : await gmail.modifyThread(args.threadId, changes, { account: acct, signal: exec.signal });
      return {
        account: acct,
        target: hasMessage ? `message ${m.id ?? args.messageId}` : `thread ${args.threadId}`,
        added: add,
        removed: remove,
      };
    },
  }));
}

/**
 * Pure pre-execute approval decision: which Gmail tools must ask the user,
 * and with what one-line reason. Read-only tools return null (pass through).
 */
export function approvalDecision({ name, arguments: args, config }) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'gmail_send' && config.requireApproval.send) {
    const subject = typeof a.subject === 'string' && a.subject ? ` — "${a.subject}"` : '';
    return { kind: 'ask', reason: `Gmail: send email to ${a.to ?? '?'}${subject}` };
  }
  if (name === 'gmail_labels' && config.requireApproval.labels) {
    const bits = [];
    if (Array.isArray(a.add) && a.add.length) bits.push(`add ${a.add.join(', ')}`);
    if (Array.isArray(a.remove) && a.remove.length) bits.push(`remove ${a.remove.join(', ')}`);
    const target = a.messageId ? `message ${a.messageId}` : a.threadId ? `thread ${a.threadId}` : '?';
    return { kind: 'ask', reason: `Gmail: ${bits.join(' and ') || 'change labels'} on ${target}` };
  }
  return null;
}
