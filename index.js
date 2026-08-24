// gmail-dsh — a native Gmail plugin for the DeepSeek Harness.
//
// On activation this wires up:
//   1. Five tools on the tool runtime: gmail_search, gmail_read,
//      gmail_send, gmail_labels, gmail_status.
//   2. A `tools/pre-execute` approval gate: gmail_send and gmail_labels ask
//      the user (configurable); reads never do.
//   3. The /gmail command (status | auth | unauth) when a commands service
//      is present.
//   4. A `gmail:status` model-context section — empty until an account is
//      authorized, so it costs zero tokens while idle.
//
// Secrets never live in config: the OAuth client id/secret are resolved
// from the credential store per operation, and the Google refresh token is
// stored as a grant record owned by this plugin. `modifyRecord` is the only
// write path, which serializes cross-process refresh-token rotation.

import { OWNER, normalizeConfig, Config } from './src/config.js';
import {
  generatePkce,
  generateState,
  buildAuthUrl,
  startCallbackServer,
  exchangeCode,
  refreshAccessToken,
  fetchUserInfo,
  resolveClient,
  tryOpenBrowser,
  accountKey,
  listAccounts,
} from './src/oauth.js';
import { createGmailClient } from './src/gmail.js';
import { registerTools, approvalDecision } from './src/tools.js';

export const name = 'gmail-dsh';

// All present in the standard web and headless compositions. If a custom
// composition lacks one, the plugin stays pending instead of failing the
// composition.
export const inject = ['tools', 'credentials', 'systemPrompt'];

export { Config };

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const creds = ctx.credentials;

  // In-process access-token cache. Access tokens are derived and short
  // lived; only the refresh token is stored durably.
  const tokenCache = new Map();

  // Synchronous snapshot for the context section (its text provider may
  // not await).
  const authState = { accounts: [] };
  let stateReady = Promise.resolve();
  function refreshAuthState() {
    stateReady = stateReady.then(async () => {
      try {
        authState.accounts = await listAccounts(creds);
      } catch {
        // Keep the last known state on a transient store failure.
      }
    });
    return stateReady;
  }
  refreshAuthState();

  // Keep the snapshot fresh when the store changes externally as well.
  ctx.on('credentials/record-updated', (key) => {
    if (String(key).startsWith(`${OWNER}/`)) refreshAuthState();
  });

  async function getAccessToken({ account, force = false, signal } = {}) {
    const rec = await creds.readRecord(accountKey(account));
    const refreshToken = rec?.payload?.refreshToken;
    if (!refreshToken) {
      throw new Error(`Gmail is not authorized for ${account}. Ask the user to run: /gmail auth`);
    }
    const cached = tokenCache.get(account);
    if (!force && cached && Date.now() < cached.expAt - 60_000) return cached.token;
    const client = await resolveClient(creds, config);
    if (!client.complete) {
      throw new Error(
        `Gmail OAuth client is not configured: set ${config.clientIdEnv} and ${config.clientSecretEnv} in the credential store or process environment (a Desktop-type Google OAuth client id and secret).`,
      );
    }
    const t = await refreshAccessToken({
      refreshToken,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      signal,
    });
    const entry = { token: t.access_token, expAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
    tokenCache.set(account, entry);
    return entry.token;
  }

  const gmail = createGmailClient({ getAccessToken });

  async function resolveAccount(arg) {
    const wanted = String(arg ?? '').trim().toLowerCase() || config.defaultAccount.trim().toLowerCase();
    const accounts = await listAccounts(creds);
    if (wanted) {
      if (!accounts.includes(wanted)) {
        throw new Error(
          `No Gmail authorization for ${wanted}. Authorized: ${accounts.join(', ') || 'none — run /gmail auth'}.`,
        );
      }
      return wanted;
    }
    if (accounts.length === 1) return accounts[0];
    if (accounts.length === 0) throw new Error('Gmail is not authorized. Ask the user to run: /gmail auth');
    throw new Error(`Multiple Gmail accounts are authorized (${accounts.join(', ')}); specify "account".`);
  }

  async function checkClient() {
    const client = await resolveClient(creds, config);
    return {
      complete: client.complete,
      missing: [
        !client.clientId ? config.clientIdEnv : '',
        !client.clientSecret ? config.clientSecretEnv : '',
      ]
        .filter(Boolean)
        .join(' and '),
    };
  }

  registerTools(ctx, {
    config,
    creds,
    gmail,
    resolveAccount,
    listAccounts: () => listAccounts(creds),
    checkClient,
  });

  // Approval gate: mutating tools ask; reads pass through. The session
  // approval policy decides what the user sees; when no approval service is
  // mounted, `ask` degrades to deny (reads are unaffected).
  ctx.on('tools/pre-execute', (exec, next) => {
    const decision = approvalDecision({ name: exec.name, arguments: exec.arguments, config });
    return decision ?? next();
  }, { prepend: true });

  // /gmail command (opportunistic: a composition without a commands service
  // simply does not get the command).
  const commands = ctx.get('commands');
  if (commands) {
    commands.register({
      name: 'gmail',
      description: 'Gmail: /gmail status | /gmail auth [email] | /gmail unauth [email]',
      input: { hint: 'status | auth [email] | unauth [email]' },
      handler: (invocation) => commandHandler(invocation),
    });
  }

  async function commandHandler(invocation) {
    const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean).map((s) => s.toLowerCase());
    const sub = parts[0] || 'status';
    const target = parts.slice(1).join(' ');
    try {
      switch (sub) {
        case 'status': {
          await refreshAuthState();
          const accounts = authState.accounts;
          const client = await checkClient();
          const defaultAccount = config.defaultAccount || (accounts.length === 1 ? accounts[0] : '');
          return {
            kind: 'success',
            text: [
              accounts.length
                ? `Authorized: ${accounts.join(', ')}${defaultAccount ? ` (default: ${defaultAccount})` : ''}`
                : 'Not authorized — run /gmail auth.',
              client.complete ? 'OAuth client: configured.' : `OAuth client: NOT configured — set ${client.missing}.`,
              `Scopes: ${config.scopes.join(', ')}`,
              config.requireApproval.send || config.requireApproval.labels
                ? 'Sending and label changes require your approval; reads never do.'
                : 'Approval gating: disabled (send/labels run without a prompt).',
            ].join('\n'),
          };
        }
        case 'auth':
          return runAuth(invocation.signal, target || undefined);
        case 'unauth':
          return runUnauth(target || undefined);
        default:
          return {
            kind: 'error',
            text: 'Usage: /gmail status | /gmail auth [email] | /gmail unauth [email]',
          };
      }
    } catch (err) {
      return { kind: 'error', text: err?.message || String(err) };
    }
  }

  async function runAuth(signal, forcedEmail) {
    const client = await resolveClient(creds, config);
    if (!client.complete) {
      return {
        kind: 'error',
        text: `Gmail OAuth client is not configured. Store your Google Cloud OAuth client id and secret (Desktop app type) as ${config.clientIdEnv} and ${config.clientSecretEnv} (credential store or environment), then run /gmail auth again.`,
      };
    }
    const { verifier, challenge } = generatePkce();
    const state = generateState();
    const server = await startCallbackServer({
      host: config.callbackHost,
      path: config.callbackPath,
      timeoutMs: config.authTimeoutMs,
      signal,
    });
    const url = buildAuthUrl({
      clientId: client.clientId,
      redirectUri: server.redirectUri,
      scopes: config.scopes,
      state,
      challenge,
    });
    const opened = tryOpenBrowser(url);
    try {
      const cb = await server.wait;
      if (cb.state !== state) {
        throw new Error('OAuth state mismatch (possible CSRF) — authorization aborted.');
      }
      const token = await exchangeCode({
        code: cb.code,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUri: server.redirectUri,
        verifier,
        signal,
      });
      if (!token.refresh_token) {
        throw new Error(
          'Google did not return a refresh token — this happens when the browser session already holds a non-interactive token for this app. Revoke the app at https://myaccount.google.com/permissions (or authorize in a private window) and run /gmail auth again.',
        );
      }
      const user = await fetchUserInfo(token.access_token, signal);
      const email = (forcedEmail || user.email).toLowerCase();
      await creds.modifyRecord(accountKey(email), () => ({
        kind: 'grant',
        payload: {
          email,
          refreshToken: token.refresh_token,
          scopes: config.scopes,
          since: new Date().toISOString(),
        },
      }));
      await refreshAuthState();
      return {
        kind: 'success',
        text: [
          `Gmail authorized for ${email}.`,
          `Scopes: ${config.scopes.join(', ')}`,
          opened ? 'Authorized via the browser I opened.' : 'Authorized via the URL you opened.',
          `Authorization URL (already consumed): ${url}`,
        ].join('\n'),
      };
    } catch (err) {
      return {
        kind: 'error',
        text: `Gmail authorization did not complete: ${err?.message || err}`,
      };
    } finally {
      server.close();
    }
  }

  async function runUnauth(email) {
    const wanted = (email || '').trim().toLowerCase() || config.defaultAccount.trim().toLowerCase();
    const accounts = await listAccounts(creds);
    const target = wanted || (accounts.length === 1 ? accounts[0] : '');
    if (!target) {
      if (accounts.length === 0) {
        return { kind: 'error', text: 'No Gmail accounts are authorized.' };
      }
      return {
        kind: 'error',
        text: `Multiple accounts are authorized (${accounts.join(', ')}). Specify one: /gmail unauth <email>`,
      };
    }
    if (!accounts.includes(target)) {
      return {
        kind: 'error',
        text: `No Gmail authorization found for ${target}. Authorized: ${accounts.join(', ')}`,
      };
    }
    await creds.deleteRecord(accountKey(target));
    tokenCache.delete(target);
    await refreshAuthState();
    return { kind: 'success', text: `Gmail authorization removed for ${target}.` };
  }

  // Model-facing context: zero tokens while idle, one stable paragraph once
  // an account is authorized.
  if (config.context.enabled) {
    ctx.systemPrompt.context({
      name: 'gmail:status',
      order: config.context.order,
      text: () => {
        const accounts = authState.accounts;
        if (accounts.length === 0) return '';
        const who =
          config.defaultAccount && accounts.includes(config.defaultAccount)
            ? config.defaultAccount
            : accounts.join(', ');
        return [
          `Gmail is connected for ${who} (scopes: ${config.scopes.join(', ')}).`,
          'Use gmail_search to find messages (Gmail query syntax, newest first), gmail_read for full text, gmail_send for outgoing mail, gmail_labels for label changes, and gmail_status for the setup state.',
          config.requireApproval.send || config.requireApproval.labels
            ? 'gmail_send and gmail_labels request user approval before running; the read tools never do.'
            : 'gmail_send and gmail_labels are not approval-gated in this deployment.',
        ].join(' ');
      },
    });
  }
}
