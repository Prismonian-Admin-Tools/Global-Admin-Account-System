# GAM — Global Admin Account System (formerly GUS)

Central identity provider for Prismonian's apps. GAM owns accounts,
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
  "updatedAt": "..."
}
```

`uid` is the stable key — store your app's own fine-grained
data (per-app permissions, custom flags, whatever) keyed by `uid`, not
`username`. Usernames can be renamed by anyone with the `manageUsers`
capability; `uid` never changes.

## Ranks

Global, not per-app. Every user has exactly one rank, and a rank is a
name plus a set of capabilities that gate GAM's own admin panel — what
that rank can actually *do* inside a given app is that app's own
business; GAM just tells the app which rank the user is in.

Four ranks are built in and always exist:

| rank | label | purpose |
|---|---|---|
| `trustedInstaller` | Provider | The account assigned to a Prismonian Enterprise customer's install engineer, used to help install software on their servers. Hardcoded to **zero** capabilities — it can never manage accounts, ranks, apps, activity, or branding, no matter what its `ranks` row says. |
| `systemAdministrator` | Sysadmin | Replaces the old `owner` rank. Hardcoded to **every** capability — always full access, so a bad edit can never lock every sysadmin out of their own system. |
| `elevatedStaff` | ElevatedAdmins | Replaces the old `admin` rank. Starts with no capabilities, same as before; a sysadmin can grant it any. |
| `staff` | StaffUsers | Replaces the old `moderator` rank, and is the default for new accounts. Starts with no capabilities; a sysadmin can grant it any. |

`trustedInstaller` and `systemAdministrator` are **locked**: their
capabilities can't be edited (the hardcoding above makes any edit moot
anyway) and none of the four built-ins can be deleted. `elevatedStaff`
and `staff` can have their capabilities changed freely.

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
service's own username/password + opaque token contract — the only one
that's actually wired up right now). `oauth`, `saml`, and `oidc` are
accepted values reserved for upcoming protocol support. `sssd` and
`kerberos` are a **dark release** for eventual domain-logon support: the
column accepts them so app records can be tagged ahead of time, but
nothing in GAM speaks either protocol yet.

Whatever the value, `/api/v1/login` is specifically the `gam` contract —
an app registered under any other method always gets `bad` back from it
(never a hint about which protocol it should be using instead, and never
a hint about whether the account needs a forced password change), since
that app isn't supposed to be calling this endpoint at all.

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
histogram (`password_simhash` on `users`, and in `password_history` for
the two most recently retired passwords) — computed once, at set-time,
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
- **Apps** — register/regenerate/disable client applications, set an
  app's auth method, and manage per-app user access. Requires `manageApps`.
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

apps list | create <slug> [--name N] [--auth-method M] | set-auth-method <slug> <M> | regenerate-secret <slug> | disable/enable/delete <slug>
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


Note to developers and testers:

After a container restart, run the following commands:
```
sudo service postgresql start
npm start
```Int