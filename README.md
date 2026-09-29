# gmail-dsh

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent your Gmail: search and read the mailbox, send mail (thread-aware replies included), and manage labels — with a browser-based Google OAuth flow, per-account grants in the DSH credential store, and approval prompts on every mutating operation.

MIT-licensed. Sister plugin: [websearch-dsh](https://github.com/takasurazeem/websearch-dsh).

No MCP server, no third-party runtime dependencies: it registers directly on the harness tool runtime, credential store, command system, and system prompt.

## What you get

| Surface | What it does |
| --- | --- |
| `gmail_search` | Gmail query search (`is:unread`, `from:x`, `newer_than:1w`, …), newest first, paged |
| `gmail_read` | Full message: plain text (HTML optional), headers, attachments, labels, thread |
| `gmail_send` | Send plain-text mail; `replyTo` threads the reply under an existing message — **asks the user first** |
| `gmail_labels` | Add/remove labels on one message or a whole thread — **asks the user first** |
| `gmail_status` | Authorization state: accounts, default account, scopes, OAuth-client status |
| `/gmail` command | `/gmail status`, `/gmail auth [email]`, `/gmail unauth [email]` |
| system-prompt section | One paragraph telling the model Gmail is connected (zero tokens until an account is authorized) |

Approval semantics: reads never prompt. `gmail_send` and `gmail_labels` return an `ask` decision from the tool pre-execute hook, which the harness approval service turns into a user prompt (recipient + subject / label change + target). If no approval service is mounted, `ask` degrades to deny, so the plugin is read-only in that deployment — it never sends without a user who can say yes.

## How it works

```
/gmail auth
  └─ PKCE (S256) + state → browser → accounts.google.com
       └─ callback to http://127.0.0.1:<ephemeral port>/gmail/callback
            └─ code → https://oauth2.googleapis.com/token  (+client secret)
                 └─ refresh_token ── stored ──▶ credential store
                                          ~/.dsh/.credentials.yaml
                                          records: gmail-dsh/<slug of email>
            └─ access tokens: in-process cache only, refreshed on 401
```

- **OAuth** uses Google's Desktop (installed-app) client type, which accepts any `http://127.0.0.1:<port>` redirect — the plugin opens a loopback server on a random free port for the duration of one authorization. Only the short-lived authorization code crosses that server; it is closed immediately after. The `access_type=offline&prompt=consent` parameters make Google return a refresh token.
- **Secrets** live only in the DSH credential store: the OAuth *client* id/secret as references (`GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET`), and each account's *refresh token* as a grant record under the plugin's own scope (`gmail-dsh/<slugified-email>`; the canonical email is in the record payload). `modifyRecord` is the sole write path, which serializes refresh-token rotation across processes.
- **Multiple accounts**: authorize as many as you like; tools take an optional `account` parameter, which defaults to the single account (or to `defaultAccount` when several).

## Setup

### 1. Google Cloud project

1. In [Google Cloud Console](https://console.cloud.google.com): create (or pick) a project.
2. **APIs & Services → Enable APIs and Services** → enable the **Gmail API**.
3. **OAuth consent screen**: choose **External** (or Internal if you have Google Workspace), fill in the app name, and add your account to the test-users list while the screen is in *Testing* status.
4. **Credentials → Create Credentials → OAuth client ID → Desktop application**. Download the JSON; you need `client_id` and `client_secret`.

### 2. Store the client credentials

Either in the credential store (recommended — the web GUI's credentials screen writes these) or by hand in `~/.dsh/.credentials.yaml`:

```yaml
version: 1
refs:
  GMAIL_OAUTH_CLIENT_ID: <your-client-id>
  GMAIL_OAUTH_CLIENT_SECRET: <your-client-secret>
```

or as process environment variables of the same names. (Literal `clientId`/`clientSecret` config values also work but are discouraged; refs win when both are present.)

### 3. Install into a profile

From this directory (e.g. after `git clone https://github.com/takasurazeem/gmail-dsh`):

```sh
dsh plugin --profile web add file:$PWD
```

and add the bundle to the profile's `package.json` under `~/.dsh/profiles/web`:

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "yolo-mode",
      "gmail-dsh"
    ]
  }
}
```

Restart `dsh web` (or let the profile HMR pick it up while the dev watcher runs). The plugin contributes its own `cordis.patch.yml` row, so nothing else in the profile needs editing.

> **Note for `file:` installs from a dev checkout:** Node resolves a package's `import "@deepseek-ai/…"` specifiers from the package's *real* path, so the checkout needs a `node_modules` it can walk up to. This repo ships a `node_modules/@deepseek-ai` symlink into the dsh installation's own package set (it's git-ignored; recreate with `mkdir -p node_modules && ln -s "$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai" node_modules/@deepseek-ai` if missing). Packages installed into a profile's own `node_modules` (the usual case) never need this.
>
> **Updating the plugin later:** pnpm *copies* a `file:` package into the profile's `node_modules` at install time, so the installed copy is a **frozen snapshot** — later edits to the checkout won't reach a running app (and re-running the same `pnpm add` may not refresh it). To develop live, replace the copy with a symlink to the checkout and restart `dsh web`:
>
> ```sh
> cd ~/.dsh/profiles/web
> rm -rf node_modules/gmail-dsh
> ln -s /path/to/this/checkout node_modules/gmail-dsh
> ```
>
> Every subsequent restart then runs the checkout as it is on disk.

### 4. Authorize

In a session, run:

```
/gmail auth
```

Your browser opens Google's consent screen (or the command prints the URL). After you approve, the one-shot loopback server receives the code, exchanges it, verifies your email via the OIDC userinfo endpoint, and stores the refresh token. `/gmail status` confirms. To remove an account: `/gmail unauth [email]` (revoke on Google's side too at <https://myaccount.google.com/permissions> if you want to reclaim the grant).

## Configuration

Row config for the `gmail` row (full row replacement semantics — patches restate every field):

| Field | Default | Meaning |
| --- | --- | --- |
| `clientIdEnv` | `GMAIL_OAUTH_CLIENT_ID` | Credential-store ref / env name for the client id |
| `clientSecretEnv` | `GMAIL_OAUTH_CLIENT_SECRET` | Credential-store ref / env name for the client secret |
| `clientId` | `''` | Literal fallback when no ref is set (discouraged) |
| `clientSecret` | `''` | Literal fallback (discouraged) |
| `scopes` | `[openid, email, gmail.modify]` | OAuth scopes; `https://www.googleapis.com/auth/gmail.modify` covers read + send + labels. The `openid`/`email` scopes are required — the token exchange works without them, but Google's userinfo endpoint (where the account email is read) rejects tokens lacking `openid` with 401 "Invalid Credentials". Narrower scopes (`gmail.readonly`) work for the read tools; sending requires the `modify` scope. **Source of truth is `DEFAULT_SCOPES` in `src/config.js`** — the bundle's own patch layer deliberately omits this key (an explicit patch value overrides the defaults, and a stale restated list once silently defeated an openid fix on every restart); override it in your own profile patch layer if you need to |
| `callbackHost` | `127.0.0.1` | Loopback callback host (Desktop clients accept any local port) |
| `callbackPath` | `/gmail/callback` | Callback path |
| `defaultAccount` | `''` | Account used when a tool omits `account` (auto-resolved when exactly one account is authorized) |
| `authTimeoutMs` | `300000` | How long `/gmail auth` waits for the browser callback |
| `requireApproval.send` | `true` | Ask the user before `gmail_send` |
| `requireApproval.labels` | `true` | Ask the user before `gmail_labels` |
| `context.enabled` | `true` | Emit the model-context section once authorized |
| `context.order` | `117` | Section order in the system prompt (kept clear of stock bundles) |

## Security notes

- The callback server is **loopback-only** and lives for one authorization; tokens never appear in URLs, logs, or config.
- The durable secret is the refresh token, stored in your `~/.dsh/.credentials.yaml` under the `gmail-dsh/` record scope (the credential store file's usual protections apply).
- The OAuth scope is your boundary: `gmail.modify` lets the agent send as you and move messages between labels — it cannot export the mailbox in bulk any faster than the API's quotas allow, and every send still needs your explicit approval.
- If your deployment has no approval service, mutating tools fail closed (denied) rather than running silently.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/gmail auth` says the client is not configured | Set `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET` (credential store or env) and check `/gmail status` again |
| "no refresh token" after a successful consent | Your browser already holds a non-interactive token for this app: revoke it at <https://myaccount.google.com/permissions> (or authorize in a private window) and retry |
| `invalid_grant` on a later refresh | The refresh token is dead. Two causes: (a) the consent was revoked or the app's access removed at <https://myaccount.google.com/permissions>; (b) **the OAuth consent screen is External + Publishing status "Testing", which expires refresh tokens after 7 days** — the usual cause when a connection dies about a week after authorizing. Fix (b) permanently by setting the consent screen to **In production** (no verification review is needed to stop the expiry; only the unverified-app warning changes). Either way, re-authorize with `/gmail auth`. `/gmail status` now performs a live token check and reports `no longer works` instead of a bare "authorized" |
| `/gmail status` says "Stored authorization … no longer works" | The live token check failed; the message carries Google's reason. Re-authorize with `/gmail auth`, and if it recurs every ~7 days see the `invalid_grant` row above |
| `403 … quota` from the Gmail API | Project-level API quota; see [Gmail API quotas](https://developers.google.com/gmail/api/v1/reference/quota) |
| "Multiple Gmail accounts are authorized" from a tool | Pass `account` to the tool or set `defaultAccount` |
| Checkout edits don't take effect (e.g. an old error persists after a restart) | The profile's `node_modules/gmail-dsh` is a snapshot copy from install time — replace it with a symlink to the checkout (Setup §3 note) and restart |
| `/gmail auth` consent passes but `userinfo request failed (401) "Invalid Credentials"` | The running code requests scopes without `openid`; the token Google issues can't call the userinfo endpoint. Make sure the checkout's `src/config.js` scopes (`openid`, `email`, `gmail.modify`) are what the app actually loaded — a stale snapshot copy will fail exactly like this |
| A read tool fails with `credential key segment "" must match ...` | Plugin build predates `0.1.2`: the tools resolved the account but never forwarded it to the token fetch, so the credential key came out empty. Update the checkout and restart |

## Tests

```sh
node test.mjs
```

Plain Node, no framework, no network (the OAuth token endpoints are stubbed; the loopback callback tests use a real ephemeral port). The suite adapts to its environment: from a bare checkout it runs the pure-logic tests and skips the dsh-runtime-dependent ones; from a directory that can resolve the `@deepseek-ai/*` packages (a profile's `node_modules`, or the `node_modules` farm this repo symlinks in) it additionally validates all five tool definitions against the real `defineTool` and executes them against fakes.

For a full composition check against a real profile layout:

```sh
DSH_HOME=$PWD/.dsh-home dsh --profile gmail-dev --dump-config   # composed tree
DSH_HOME=$PWD/.dsh-home dsh --profile gmail-dev "…"             # headless boot (create a scratch profile under .dsh-home/)
```

## Development notes

- **Zero runtime dependencies.** Only `peerDependencies` on the harness packages (`@deepseek-ai/cordis`, `dsh-credentials`, `dsh-tools`), so `pnpm add` of this package never fetches anything; the import sites are lazy and degrade with actionable errors outside a dsh runtime.
- **Config contract.** The cordis runtime calls `Config['~standard'].validate(raw)` **synchronously** (it rejects promises) and expects `{value}` or `{issues}`; the loader separately reads `Config.simplify` for HMR write-back. Both delegate to `normalizeConfig`.
- **Tool schema DSL.** The value-schema DSL marks required fields per property (`required: true` on the property) — there is no root-level `required` array. The runtime validates every tool result against the compiled output schema and throws `ToolOutputError` on violation, so `required` marks must match what `execute` actually returns.
- **Credential key grammar.** `credentialKey` segments match `^[a-z][a-z0-9-]*$`, so email addresses are slugified (`me@gmail.com` → `gmail-dsh/me-gmail-com`); the canonical email lives in the record payload, and `listAccounts` matches on it.
- **No custom session events** (avoids the ignorable-trap), and the commands service is accessed opportunistically so a composition without it never leaves the plugin pending.

## Uninstall

```sh
dsh plugin --profile web remove gmail-dsh
```

remove `"gmail-dsh"` from the profile's `dsh.profile.bundles`, restart, and `/gmail unauth` each account (or delete the `gmail-dsh/…` records from `~/.dsh/.credentials.yaml`).

## License

MIT — see [LICENSE](LICENSE).
