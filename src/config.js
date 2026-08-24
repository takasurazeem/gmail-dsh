// Config defaults and normalization for gmail-dsh.
//
// DSH credentials doctrine: config carries references, never secrets. The
// Google OAuth client id/secret are resolved per operation from the
// credential store (or the process environment it layers over) using the
// ref names given by `clientIdEnv` / `clientSecretEnv`.

export const OWNER = 'gmail-dsh';

// `openid` (with `email`) must accompany the Gmail scope: the token exchange
// succeeds without them, but Google's userinfo endpoint
// (https://openidconnect.googleapis.com/v1/userinfo) rejects any access
// token lacking the `openid` scope with 401 "Invalid Credentials" — and
// that is where the account's email address is read.
export const DEFAULT_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
];

export const defaults = {
  clientIdEnv: 'GMAIL_OAUTH_CLIENT_ID',
  clientSecretEnv: 'GMAIL_OAUTH_CLIENT_SECRET',
  clientId: '',
  clientSecret: '',
  scopes: DEFAULT_SCOPES,
  callbackHost: '127.0.0.1',
  callbackPath: '/gmail/callback',
  defaultAccount: '',
  authTimeoutMs: 300_000,
  requireApproval: { send: true, labels: true },
  context: { enabled: true, order: 117 },
};

const str = (v, d) => (typeof v === 'string' ? v : d);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

function strArray(v, d) {
  if (Array.isArray(v)) {
    const out = v.filter((x) => typeof x === 'string' && x.length > 0);
    if (out.length) return out;
  }
  return d;
}

/**
 * Normalize arbitrary row config into the exact shape the plugin consumes.
 * Defensive on purpose: the loader may hand us a sparse or partially typed
 * object, and the patch layer replaces whole row configs, so every field is
 * restated explicitly here.
 */
export function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ra = r.requireApproval && typeof r.requireApproval === 'object' ? r.requireApproval : {};
  const cx = r.context && typeof r.context === 'object' ? r.context : {};
  return {
    clientIdEnv: str(r.clientIdEnv, defaults.clientIdEnv),
    clientSecretEnv: str(r.clientSecretEnv, defaults.clientSecretEnv),
    clientId: str(r.clientId, defaults.clientId),
    clientSecret: str(r.clientSecret, defaults.clientSecret),
    scopes: strArray(r.scopes, defaults.scopes),
    callbackHost: str(r.callbackHost, defaults.callbackHost),
    callbackPath: str(r.callbackPath, defaults.callbackPath),
    defaultAccount: str(r.defaultAccount, defaults.defaultAccount),
    authTimeoutMs: num(r.authTimeoutMs, defaults.authTimeoutMs),
    requireApproval: {
      send: bool(ra.send, defaults.requireApproval.send),
      labels: bool(ra.labels, defaults.requireApproval.labels),
    },
    context: {
      enabled: bool(cx.enabled, defaults.context.enabled),
      order: num(cx.order, defaults.context.order),
    },
  };
}

/**
 * The plugin `Config` export, matched to the real DSH contract:
 *   - the cordis runtime's `resolveConfig` calls
 *     `Config['~standard'].validate(raw)` synchronously and expects either
 *     `{value}` (the normalized config) or `{issues}` (a ValidationError is
 *     raised). It throws if the result is a promise.
 *   - the cordis loader reads the optional `Config.simplify` hook to
 *     normalize the row config before HMR write-back.
 * `normalizeConfig` is the source of truth for both.
 */
export const Config = {
  '~standard': {
    version: 1,
    validate(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'gmail-dsh config must be a plain object' }] };
      }
      return { value: normalizeConfig(value) };
    },
  },
  simplify: (value) => normalizeConfig(value),
  defaults,
};
