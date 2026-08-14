# GUS — Global User System

Central identity provider for Prismonian's apps. GUS owns accounts,
passwords, and the three global roles (`owner` / `admin` / `moderator`).
Apps (Interstellar Console, PrismonianCasino admin, etc.) call it to log
users in, then keep their own fine-grained, app-specific data keyed by
the user's `uid`.

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
| `bad` | wrong username or password (never reveals which) |
| `disabled` | account exists and password is correct, but is disabled |

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
  "role": "owner",
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
`username`. Usernames can be renamed by an owner; `uid` never changes.

## Roles

Global, not per-app: `owner`, `admin`, `moderator`. Only owners can
create/manage other accounts, and only via the GUS's own frontend — no
account creation happens through the app API. What each role can
actually *do* inside a given app is that app's own business; GUS just
tells the app which of the three buckets the user is in.

## Security notes

- Nobody — including owners — can ever retrieve a stored password.
  Owners can only reset one.
- New accounts always start with `mustChangePassword: true`. No flag
  turns this off at creation.
- Session tokens are stored as SHA-256 hashes, scoped to `(uid, appId)`
  — a token issued to one app is meaningless to another, even if leaked.
- Failed-login lockout is keyed on `(username, ip)` together, so it
  can't be used to lock out a shared IP by spraying one account, or
  vice versa.
- Per-app request-rate limiting protects the service from one
  misbehaving/compromised app hammering it.
