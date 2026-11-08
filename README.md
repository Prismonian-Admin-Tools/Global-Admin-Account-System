# Passport (formerly GAM / Global Admin Account System, formerly GUS)

Central identity provider for Prismonian's apps. Passport owns accounts,
passwords, and ranks (a built-in `trustedInstaller` / `systemAdministrator`
/ `elevatedStaff` / `staff`, plus any custom ranks a sysadmin creates — see
[Ranks](#ranks) below). Apps (Interstellar Console, PrismonianCasino admin,
etc.) call it to log users in, then keep their own fine-grained,
app-specific data keyed by the user's `uid`.

## Setup

```bash
npm install
createdb gus                      # or your provider's equivalent
cp config/config.yml.example config/config.yml   # edit db creds, secrets
npm run migrate
npm run bootstrap -- --username adrian --password "temp-password-123" --app console
```

The bootstrap command prints the new app's `appId` and **secret once** —
save it immediately, it can't be retrieved again (only regenerated,
which invalidates the old one).

```bash
npm start
```

## The app-facing contract (`/api/v1/*`)

Every request needs these headers, identifying the CALLING APPLICATION
(not the end user):

```
X-App-Id: <appId>
X-App-Secret: <appSecret>
```

### `POST /api/v1/login`
```json
{ "username": "adrian", "password": "..." }
```
Response `status` is always exactly one of:

| status | meaning |
|---|---|
| `good` | valid credentials, account in good standing |
| `good_change_pw` | valid credentials, but must change password before continuing |
| `bad` | wrong username or password (never reveals which) — also returned for every request against an app that isn't registered with the `gam` auth method, since this endpoint isn't that app's login contract |
| `disabled` | account exists and password is correct, but is disabled |
| `good-no-access` | valid credentials, but a sysadmin has blocked this specific user from this specific app (see [Per-app access control](#per-app-access-control)) |

`good` / `good_change_pw` responses also include a `token` (opaque
session token, scoped to this app) and `user` (full profile, minus
password). Malformed requests get `invalid_request` (400); bad app
credentials get `invalid_app` (401); too many attempts get
`rate_limited` (429, with `Retry-After`).

### `POST /api/v1/validate`
```json
{ "token": "tok_..." }
```
→ `{ "valid": true, "user": {...} }` or `{ "valid": false }`. Sliding
idle timeout — each successful validate extends the token's life, up to
the absolute TTL in `config.yml`.

### `POST /api/v1/logout`
```json
{ "token": "tok_..." }
```

### `POST /api/v1/change-password`
```json
{ "token": "tok_...", "currentPassword": "...", "newPassword": "...", "confirmPassword": "..." }
```
`currentPassword` is only required if the account is NOT under a forced
password change — that's the whole point of "forced."

## User object shape

```json
{
  "uid": "uuid",
  "username": "adrian",
  "role": "systemAdministrator",
  "email": null,
  "fullName": "",
  "description": "",
  "disabled": false,
  "mustChangePassword": false,
  "cannotChangePassword": false,
  "passwordNeverExpires": true,
  "passwordExpiresAt": null,
  "passwordExpired": false,
  "theme": "ember",
  "avatarExt": null,
  "lastLogin": "2026-08-14T...",
  "createdAt": "...",
  "updatedAt": "...",
  "rank": { "name": "systemAdministrator", "label": "Sysadmin", "color": "#ff8a3d", "permissionLevel": 200 }
}
```

`rank` is the full rank `role` refers to — its display label, badge
color, and permission level — so an app can render custom ranks with
their real name/color and slot them into its own access tiers without
hardcoding Passport's stock rank names. It's purely additive; `role` is
unchanged.

`uid` is the stable key — store your app's own fine-grained
data (per-app permissions, custom flags, whatever) keyed by `uid`, not
`username`. Usernames can be renamed by anyone with the `manageUsers`
capability; `uid` never changes.

### Data model

An "account" is really four tables, not one: `users` is a minimal
identity anchor (`uid`, `created_at`) — the thing every other table's
foreign key actually points to — with `usernames`, `passwords`, and
`userdata` each holding one focused slice, one row per `uid`:

| table | holds |
|---|---|
| `users` | `uid` (the stable identity), `created_at` |
| `usernames` | `username` |
| `passwords` | `password_hash`, `password_simhash`, `mustChangePassword`, `cannotChangePassword`, `passwordNeverExpires`, `passwordExpiresAt` |
| `userdata` | `role`, `fullName`, `description`, `email`, `disabled`, `theme`, `avatarExt`, `lastLogin` |

This is purely internal: `src/models/userStore.js` joins all four back
into the single shape shown above before anything else in the codebase
ever sees a "user," so no route, the CLI, or an app calling `/api/v1/*`
can tell the difference. It exists so a future account that doesn't have
a GAM password at all — one that only ever authenticates via an external
IdP — doesn't need a dummy row in a table full of password columns, and
so credentials, identity, and profile data can eventually carry different
access rules without restructuring everything else.

## Ranks

Global, not per-app. Every user has exactly one rank, and a rank is a
name plus a set of capabilities that gate GAM's own admin panel — what
that rank can actually *do* inside a given app is that app's own
business; GAM just tells the app which rank the user is in.

Four ranks are built in and always exist:

| rank | label | purpose |
|---|---|---|
| `trustedInstaller` | Provider | The rank `scripts/bootstrap.js` creates the first account under. Hardcoded to **every** capability, same as Sysadmin — a second full-access rank rather than a separate tier, so the first account created on a fresh install can actually administer it. Also skips the forced-password-change/onboarding flow every other new account gets, since it's meant to be provisioned with a password IT already intends to keep (bootstrap's own account is the one exception — see its `forcePasswordChange` flag). |
| `systemAdministrator` | Sysadmin | Replaces the old `owner` rank. Hardcoded to **every** capability — always full access, so a bad edit can never lock every sysadmin out of their own system. |
| `elevatedStaff` | ElevatedAdmins | Replaces the old `admin` rank. Starts with `manageUsers` and `viewActivity`; a sysadmin can grant it any other. |
| `staff` | StaffUsers | Replaces the old `moderator` rank, and is the default for new accounts. Starts with no capabilities; a sysadmin can grant it any. |

`trustedInstaller` and `systemAdministrator` are **locked**: their
capabilities can't be edited (the hardcoding above makes any edit moot
anyway) and none of the four built-ins can be deleted. Every rank,
including the two locked ones, has a `color` a sysadmin can customize
from the Ranks tab — only capabilities are locked, not appearance.
`elevatedStaff` and `staff` can have their capabilities changed freely.

Since two ranks now carry full capabilities, "at least one enabled
admin must always exist" means at least one enabled account in
`systemAdministrator` **or** `trustedInstaller` — enforced the same way
as before (a DB trigger plus an application-level check), just widened
to cover both.

A sysadmin (anyone with the `manageRanks` capability) can also create
entirely custom ranks with their own name, label, and capability set —
`POST /api/ranks`, or `ranks create <name> <label> [--<capability> ...]`
from the CLI.

### Capabilities

| capability | unlocks |
|---|---|
| `manageUsers` | Users tab — create/edit/disable/delete accounts, reset passwords, CSV import |
| `manageRanks` | Ranks tab — create/edit/delete custom ranks (also needed to change a rank's capabilities) |
| `manageApps` | Apps tab — register/regenerate/disable/delete apps, set an app's auth method, block/unblock a user's access to one app |
| `viewActivity` | Activity tab — the audit log and CSV export |
| `manageBranding` | Settings tab — site name and logo |
| `managePasswordPolicy` | Password Policy tab — add/edit/enable/disable the rules new self-service passwords must meet |
| `manageEmail` | Email tab — SMTP server settings and sending a test email |

Reading the rank list (`GET /api/ranks`, used to populate the role picker
in the Users tab) only needs `manageUsers` OR `manageRanks`; creating,
editing, or deleting a rank needs `manageRanks` specifically.

## Per-app access control

Disabling an app (`PATCH /api/apps/:appId`) blocks every user from it.
For a narrower cut, `manageApps` can also block one specific user from
one specific app without touching the app or the account as a whole:

```
POST   /api/apps/:appId/access/:uid/block
POST   /api/apps/:appId/access/:uid/unblock
GET    /api/apps/:appId/access          # currently blocked users
```

A blocked user's credentials still work everywhere else; against this
one app, `/api/v1/login` returns `good-no-access` instead of `good` /
`good_change_pw`, and any token they already held for it stops validating.

## App auth methods

Every registered app has an `authMethod`, defaulting to `gam` (this
service's own username/password + opaque token contract). Two values are
actually functional: `gam` and `oidc` (see
[Federated identity](#federated-identity-gam-as-an-openid-connect-provider)
below). `oauth` (bare OAuth2 without OIDC on top) and `saml` are accepted
values with no implementation behind them yet. `sssd` and `kerberos` are
a **dark release** for eventual domain-logon support: the column accepts
them so app records can be tagged ahead of time, but nothing in GAM
speaks either protocol.

Whatever the value, `/api/v1/login` is specifically the `gam` contract —
an app registered under any other method always gets `bad` back from it
(never a hint about which protocol it should be using instead, and never
a hint about whether the account needs a forced password change), since
that app isn't supposed to be calling this endpoint at all.

## Federated identity: GAM as an OpenID Connect Provider

Some apps can be taught the native `gam` contract above; others —
off-the-shelf software, anything that only knows how to integrate SSO
via a standard protocol — can't. For those, an app registered with
`authMethod: "oidc"` can point any standard OIDC client library at GAM
itself as the identity provider. Apps that *do* support the native
contract keep using `/api/v1/login` as before — this is a second, parallel
front door, not a replacement.

It's built entirely out of infrastructure GAM already has:

- **`client_id` / `client_secret` are an app's existing `appId` / app
  secret** — the same pair already used for `X-App-Id` / `X-App-Secret`.
  There's no separate OIDC credential type to register or lose track of.
- **The OIDC `access_token` IS the opaque `tok_...` token** the native
  protocol already issues via the same session store. An OIDC-
  authenticated sign-in shows up in "Active Sessions" and can be revoked
  ("sign out everywhere") exactly like a native one.
- Only the **`id_token`** is new: a short-lived (5 minute) RS256-signed
  JWT asserting who just authenticated, exactly as long as the initial
  code-for-token exchange, per spec — not meant for ongoing API calls.

Supported: authorization-code flow only (no implicit/hybrid). **PKCE
(S256) is mandatory** for every client, confidential or not, per current
best practice. Standard endpoints:

```
GET  /.well-known/openid-configuration
GET  /.well-known/jwks.json
GET  /oidc/authorize      (response_type=code, PKCE required)
POST /oidc/token          (grant_type=authorization_code)
GET  /oidc/userinfo       (Authorization: Bearer <access_token>)
```

Registering an OIDC app also needs `redirectUris` — an allow-list GAM
checks with an **exact string match** (never a prefix) before it will
send an authorization code anywhere, so a registered app can't be used
as an open redirect. Manage them from the Apps tab's "OIDC info" button,
`PUT /api/apps/:appId/redirect-uris`, or `apps set-redirect-uris` /
`apps oidc-info` in the CLI.

There's no consent screen: an app has to be registered by a sysadmin
before it can appear at `/oidc/authorize` at all, the same trust
boundary `/api/v1/login` already relies on. If the browser hitting
`/oidc/authorize` isn't signed into GAM (or has a forced password change
pending), it's redirected to `/?continue=<the original authorize URL>`;
GAM's frontend finishes login (or the forced change) and then navigates
the browser back to that URL as a real page load, so the OIDC route runs
again now-authenticated. GAM only *consumes* OIDC identity for its own
login — it doesn't offer signing into GAM itself via an external IdP.

`oidc_signing_keys` holds GAM's own RSA keypair for signing ID tokens,
generated once (at first boot) and reused for the life of the install;
`/.well-known/jwks.json` publishes only the public half. `oidc_auth_codes`
holds authorization codes, single-use and short-lived (60 seconds) —
consuming one is an atomic `UPDATE ... WHERE used = false`, so a code
can't be redeemed twice even under a race.

## Rally account sync

Connect Rally from the **Apps tab → RESTful API**: choose **Rally (WSAPI)**
in the App dropdown, paste an API key belonging to a Rally Subscription
Administrator, **Test connection**, then **Save**. Saving checks the key
with Rally first, stores it encrypted (`app_integrations`, migration 016;
only its last 4 characters are ever shown again) and turns the sync on
immediately — no restart; **Disconnect** turns it off the same way. Needs
the `manageApps` capability. A key in `config.yml` (`rally.enabled` +
`rally.apiKey`, or `RALLY_API_KEY`) still works as a fallback; a key saved on
the Apps tab takes precedence. Other Rally settings (base URL, delete
behaviour, retries, defaults, import rank map) stay in `config.yml`.

Once connected, Passport keeps a matching Rally user (via the Rally
WebService API v2.0) for each account it creates:

| Passport | Rally |
|---|---|
| account created | user created (`POST /user/create`) — or, if a Rally user with the same email already exists, **linked** to it instead of creating a duplicate |
| account disabled / re-enabled | user disabled / re-enabled (`POST /user/{ObjectID}` with `Disabled`) |
| account deleted | user **disabled** by default; permanently deleted (`DELETE /user/{ObjectID}`) only if `rally.onPassportDelete: delete` |

All three paths — admin panel, CLI and bootstrap — go through
`UserStore`, which is where the hooks live, so they all sync the same way.

**Rally being down never blocks Passport.** Each change records what
Passport *wants* the Rally user to look like (`rally_accounts`, migration
014) and then tries to apply it. If the call fails — including Rally's
habit of answering HTTP 200 with an `Errors` array — the Passport
operation still succeeds, the error is stored, and a background sweep
retries every `retryIntervalMinutes` up to `maxAttempts` times. Rows are
claimed before being worked, so the request path and the sweep can't
both create the same Rally user.

Rules worth knowing:

- **Rally requires an email address.** An account without one shows as
  "Waiting for an email address" and is created in Rally as soon as an
  email is set.
- **Linked users are never hard-deleted.** A Rally user Passport matched
  by email (rather than created) is only ever disabled, even with
  `onPassportDelete: delete`. Passport *is* the source of truth for its
  enabled/disabled state, though — re-enabling the Passport account
  re-enables it in Rally.
- **Only new accounts are synced automatically.** Accounts that existed
  before Rally sync was turned on are left alone until enrolled with
  `rally sync <username>`.
- Not synced: later email/name changes to an already-created Rally user,
  workspace/project permissions (new Rally users start with none), and
  per-app blocks.
- The API key must belong to a Rally **Subscription Administrator**. It's
  sent as the `ZSESSIONID` header, which (unlike Basic auth) needs no
  per-request security token. `RALLY_API_KEY` overrides `rally.apiKey`.
- Every Rally action and first/final failure is written to the activity
  log under the `rally` category.

```bash
npm run cli -- rally status            # every enrolled account's sync state
npm run cli -- rally status <username> # one account in detail (Rally ObjectID, last error)
npm run cli -- rally sync <username>   # enroll an existing account / restart a stuck one
npm run cli -- rally retry             # fresh attempts for everything that failed
```

### Importing existing Rally users

`rally import-list` reads every user in the Rally subscription and shows
what importing each would do; `rally import` does it for the users you
pick. Both are CLI-only.

```bash
npm run cli -- rally import-list                       # table
npm run cli -- rally import-list --csv rally-users.csv # also save a CSV to review/edit
npm run cli -- rally import-list --json                # machine-readable
npm run cli -- rally import ada@corp.com 12345678 --dry-run
npm run cli -- rally import --from rally-users.csv     # the rows you left in the CSV
npm run cli -- rally import --all                      # every importable user
```

For each Rally user the list says one of:

| Action | Meaning |
|---|---|
| `create` | a new Passport account, linked to the Rally user |
| `link` | a Passport account already matches — same email, or same username where the Passport account has no (or the same) email. Only the link is recorded; the Passport account's name, rank, password and status are left alone. If the two disagree on enabled/disabled, the **Rally** user is changed to match Passport (the note says so). |
| `skip` | with the reason: already linked, username taken by a Passport account with a different email, two Rally users that would get the same username, several Passport accounts sharing the email |

How new accounts are built:

- **Username** — the part of the Rally login name before the `@`
  (`ada.l@corp.com` → `ada.l`).
- **Rank** — from the Rally subscription permission: Subscription Admin →
  `systemAdministrator`, Workspace Admin → `elevatedStaff`, everyone else
  → `staff`. Change it under `rally.import.roleMap` in `config.yml`. The
  import output calls out every account it creates as a sysadmin.
- **Disabled in Rally** → created disabled in Passport.
- **Password** — Rally never exposes passwords, so each new account gets a
  random temporary password (forced change on first login). They are
  written only to a new CSV readable by you alone (`0600`; default
  `./rally-import-passwords-<timestamp>.csv`, or `--passwords-file`),
  never printed, and the file is never overwritten. Hand them out
  securely, then delete the file.

Rally users without an email are hidden unless `--include-no-email`.
Every imported or linked account is marked as a *linked* Rally user, so
it follows the normal sync above — and is never hard-deleted in Rally.
Re-running is safe: already-linked users show as `skip`.

## Multi-factor authentication (dormant)

A user can enroll in TOTP (authenticator-app codes) from My Account: a
real QR code, confirming with a live code before it's considered set up,
and one-time backup codes shown exactly once, same pattern as an app
secret. `mfaEnabled` is on every user profile, so admins can see who's
enrolled. **Nothing checks a code at login yet** — `/api/v1/login` and
`/session/login` don't ask for one, regardless of `mfaEnabled`. This is
groundwork: whichever future phase turns enforcement on will decide
things like which apps require it and what a partial-auth state looks
like across the token contract, without needing to touch the enrollment
UI, storage, or backup codes built here.

`passwords.mfa_secret` is encrypted at rest the same way the SMTP
password is (`src/utils/secretBox.js`) — GAM has to read a submitted
code's expected value back in plaintext to check it, so it can't be a
one-way hash, same tradeoff already noted for the SMTP password in
[Security notes](#security-notes).

## Password policy

Every self-service password change — the forced first-login change and a
voluntary later one, via either `PUT /api/account/password` or `/api/v1/
change-password` — is checked against two things before it's accepted.
**Neither check runs for a password an admin sets for someone else**,
whether through the Users tab, `PATCH /api/users/:uid`, or the CLI's
`users create` / `users reset-password` — those are always temporary,
and the account holder is forced to replace them on next login anyway.

**1. Configurable rules.** `password_policy_rules` holds rule *instances*
— a type, a label, enabled/disabled, and a JSON `params` blob — evaluated
by `src/utils/passwordPolicy.js`. The defaults:

| label | type | params |
|---|---|---|
| No years | `noYears` | `{minYear: 1900, maxYear: 2099}` — rejects any 4-digit run in that range |
| 2 symbols minimum | `minCount` | `{charset: "symbols", min: 2}` |
| 3 numbers minimum | `minCount` | `{charset: "numbers", min: 3}` |
| 5 letters minimum | `minCount` | `{charset: "letters", min: 5}` |
| 1 uppercase letter | `minCount` | `{charset: "uppercase", min: 1}` |
| No spaces | `noSpaces` | `{}` |
| Not 70% similar to "password" | `notSimilarTo` | `{values: ["password"], threshold: 0.7}` |

A sysadmin (`managePasswordPolicy`) can enable/disable, edit params, or
add new *instances* of these types from the Password Policy tab, `/api/
password-policy`, or the CLI's `password-policy` command group — no code
change needed. Adding a genuinely new rule *type* (something `minCount`/
`noYears`/`noSpaces`/`notSimilarTo` can't express) means adding one entry
to the `RULE_TYPES` registry in `src/utils/passwordPolicy.js`; every
existing rule instance, the admin UI, and the CLI pick it up automatically.

**2. Password history.** A new password can't be ≥70% similar to either
of the user's last two (now-retired) passwords. A password can't be
un-hashed to compare it letter-by-letter against a new one, so this
needs something bcrypt can't give us: alongside the bcrypt hash, GAM
stores a 64-bit **SimHash** of the password's character-frequency
histogram (`password_simhash` on `passwords`, and in `password_history`
for the two most recently retired passwords) — computed once, at set-time,
while the plaintext is still in memory, and never reversible back to the
original password. It's deliberately based on which characters (and how
many of each) appear rather than their order or position, so that e.g.
`GoRams753%!` and `RamsGo766!%` — same letters and symbols rearranged,
only the digits different — read as similar even though they share no
long substring. This is inherently an estimate on short strings, not a
certainty: treat a rejection as "please pick something more different,"
not a security guarantee, and see the comment above `simhash64()` for
the reasoning.

## Email notifications

GAM can send account-lifecycle emails via SMTP, configured at
`/api/email-settings` (Email tab, `manageEmail`) or `email set-smtp` /
`email enable` in the CLI. The SMTP password is encrypted at rest
(AES-256-GCM, keyed from `server.sessionSecret` — see
`src/utils/secretBox.js`) and only ever decrypted in memory to actually
send mail; it's never returned by any read endpoint. Sending is a
no-op (never an error toward the caller) whenever email is disabled,
unconfigured, or the recipient has no address on file — a login or
password change never fails because notification mail couldn't go out.

| email | sent when |
|---|---|
| Account created | a new user is created (`userStore.create`, any interface) |
| Password change required | an admin flips `mustChangePassword` on an *existing* account (not at creation — that gets "Account created" instead) |
| Password changed | any time a password is actually changed, self-service or admin/CLI |
| Password expired | the hourly sweep (`src/jobs/passwordExpirySweep.js`) finds an account past `passwordExpiresAt` |
| Password expiry soon! | the same sweep, once a password is within 7 days of expiring |
| Unknown logon point | a successful login from an IP GAM hasn't seen for that account before — tracked in `known_logins`; a brand-new account's very first login is never flagged, since there's nothing yet to compare it to |

Add an email address to an account from the Users tab, `PATCH /api/
users/:uid`, or `users set-email <username> <email>` in the CLI.

Every email carries the fixed banner `public/brand/email-banner.png`
(attached inline; replace the file to change it), a heading, a short
details section and a footer. Set **Organization name** and **Support
email address** under Settings (or `branding set-org-name` /
`branding set-support-email`): the organization appears in the
account-created email, and the support address is named in every footer
and used as the emails' Reply-To. `server.publicUrl` must be Passport's
real address — sign-in and reset links point at it.

**One-time links.** Password-expiry and change-required emails carry a
**Reset password** button; new-sign-in and password-changed emails carry
**Wasn't you? Sign this user out and change your password.** Each opens
`/reset-password#<token>`: single use, valid for `resetLinks.ttlHours`
(72), cancelled by any password change on the account, and only a hash of
the token is stored. The token is in the URL fragment, which browsers never
send to the server, and nothing happens until the person clicks a button on
the page, so email link scanners can't trigger anything. "Wasn't you?"
first signs out every app token *and* website session, then lets the user
set a new password without the old one; the password policy still applies.

**Unfamiliar sign-ins** show the IP address (from the request), city and
ISP, and warn when the address belongs to a VPN or proxy. City comes from
visitor-location headers when `ipLookup.trustLocationHeaders` is on
(e.g. Cloudflare's `cf-ipcity`; only enable it behind such a proxy);
anything missing — always ISP and VPN detection — comes from
proxycheck.io, which receives the sign-in's IP address. Set
`ipLookup.proxycheck.apiKey` (or `PROXYCHECK_API_KEY`) for 1,000
lookups/day; private addresses are never looked up, results are cached for
a day, and the email is sent in the background so a slow lookup never
delays the sign-in.

## Admin-panel features (GAM's own frontend)

- **Dashboard** — quick stats and a recent-activity feed, each tailored
  to whichever capabilities the signed-in rank actually has.
- **Users** — create, edit, bulk enable/disable/delete, CSV import (each
  imported row gets its own random temp password, downloadable as a CSV
  afterward), and full password-policy control per user (force change,
  can't-change, expiry date). Requires `manageUsers`.
- **Ranks** — see [Ranks](#ranks) above. Requires `manageRanks` to create,
  edit, or delete; the list itself is also visible to `manageUsers`.
- **Active Sessions** — every app currently holding a live token for a
  given account, with per-session or "sign out everywhere" revocation.
  Available both to a user for their own account (`/api/account/sessions`)
  and, with `manageUsers`, for anyone (`/api/users/:uid/sessions`).
- **Two-factor authentication** — TOTP enrollment (QR code, backup codes)
  from My Account for any signed-in user. See
  [Multi-factor authentication](#multi-factor-authentication-dormant) above
  for why it's dormant.
- **Apps** — register/regenerate/disable client applications, set an
  app's auth method, manage per-app user access, and (for `oidc` apps)
  view connection info and manage redirect URIs. Requires `manageApps`.
- **Activity** — filterable (category, actor, date range) audit log with
  CSV export at `/api/activity/export`. The acting username is stored
  denormalized on each entry, so it survives that account later being
  deleted — only the `actor_uid` foreign key goes null. Requires
  `viewActivity`.
- **Password Policy** — see [Password policy](#password-policy) above.
  Requires `managePasswordPolicy`.
- **Email** — SMTP settings and a test-send button; see
  [Email notifications](#email-notifications) above. Requires `manageEmail`.
- **Settings** — site name and logo shown on the login screen and header,
  stored in the database (not `config.yml`) so it takes effect without a
  restart. Requires `manageBranding`.

## CLI (no login required)

Everything above, plus `reset-attempts`, is also available from the
command line — it talks directly to the database using `config.yml`'s
credentials, the same way `bootstrap.js` and `reset-sysadmin-password.js`
already do. No HTTP, no session, works whether or not the server is
even running.

```bash
node scripts/gus-cli.js --help
# or: npm run cli -- --help
```

```
users list | show <username> | create <username> <role> [--password P] [--full-name N] [--description D] [--email E]
users set-role <username> <role> | set-email <username> <email> | reset-password <username> [--password P] [--keep-must-change]
users disable/enable <username> | rename <username> <new> | delete <username>

ranks list | create <name> <label> [--<capability> ...] | set-capability <name> <capability> <on|off> | delete <name>

apps list | create <slug> [--name N] [--auth-method M] [--redirect-uris uri1,uri2] | set-auth-method <slug> <M> | regenerate-secret <slug> | disable/enable/delete <slug>
apps set-redirect-uris <slug> <uri1,uri2,...> | oidc-info <slug>
apps block <slug> <username> | unblock <slug> <username>

sessions list <username> | revoke-all <username>

activity list [--category C] [--actor A] [--from ISO] [--to ISO] [--limit N]
activity export <file.csv> [--category C] [--actor A] [--from ISO] [--to ISO]

branding show | set-name <name> | remove-logo

password-policy list | create <type> <label> [--params '{...}'] | set-enabled <id> <on|off> | delete <id>

email show | set-smtp [--host H] [--port P] [--secure true|false] [--username U] [--password P] [--from-address A] [--from-name N]
email enable | disable | send-test <address>

reset-attempts <username>     # clear a login lockout for one account
reset-attempts --all          # clear every recorded attempt for everyone
```

Password requirements and history checks (see
[Password policy](#password-policy)) are enforced only on self-service
changes — `users create` / `users reset-password` bypass them entirely,
same as an admin reset through the web UI.

Passwords left out of `create`/`reset-password` are generated randomly
and printed once. Every account is forced to change its password on
first login after either — no flag turns that off.

## Security notes

- Nobody — including sysadmins — can ever retrieve a stored password.
  A sysadmin (or anyone with `manageUsers`) can only reset one.
- New accounts always start with `mustChangePassword: true`. No flag
  turns this off at creation.
- Session tokens are stored as SHA-256 hashes, scoped to `(uid, appId)`
  — a token issued to one app is meaningless to another, even if leaked.
- Failed-login lockout is keyed on `(username, ip)` together, so it
  can't be used to lock out a shared IP by spraying one account, or
  vice versa.
- Per-app request-rate limiting protects the service from one
  misbehaving/compromised app hammering it.
- The password-history similarity check (see [Password policy](#password-policy))
  is the one deliberate exception to "passwords are never recoverable":
  `password_simhash` stores a lossy fuzzy fingerprint of each password's
  character histogram — not reversible to the original password, but
  more information than a cryptographic hash reveals. That tradeoff is
  the unavoidable cost of the "70% similar to your last two passwords"
  feature; there is no way to detect near-duplicate passwords from
  one-way hashes alone.
- The one credential GAM does store reversibly is the SMTP password
  (`email_settings.encrypted_password`), because sending mail requires
  authenticating with it again on every send. It's encrypted (AES-256-GCM,
  keyed from `server.sessionSecret`), not plaintext, and never returned
  by any API response — but unlike a user's password or an app secret,
  someone with both database and `sessionSecret` access could recover it.
- The same reversible-encryption tradeoff applies to the dormant MFA
  secret (`passwords.mfa_secret`) — GAM has to check a submitted 6-digit
  code against it, which a one-way hash can't support.
- OIDC ID tokens are signed (RS256), not encrypted — they carry the same
  claims (username, name, email) an app already gets back from
  `/api/v1/login` or `/oidc/userinfo`, not anything more sensitive.
  GAM's private signing key never leaves the server; only its public half
  is ever published, at `/.well-known/jwks.json`.
- OIDC redirect URIs are matched exactly, never as a prefix — a
  registered app's callback URL can't be used to redirect an
  authorization code somewhere else by appending to it.


Note to developers and testers:

After a container restart, run the following commands:
```
sudo service postgresql start
npm start
```Int