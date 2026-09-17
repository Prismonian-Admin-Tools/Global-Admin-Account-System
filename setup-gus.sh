#!/usr/bin/env bash
# =============================================================================
# GAM complete setup — installs Postgres (if missing), creates the gus
# database/user, writes config.yml, installs deps, runs migrations, creates
# your sysadmin account (you'll be prompted for username + password),
# registers Console as an app, then starts GAM.
#
# Run this FROM INSIDE the gus/ project directory:
#   chmod +x setup-gus.sh
#   ./setup-gus.sh
#
# Every step before "start the server" is safe to re-run — it checks
# whether it's already done before doing it again.
# =============================================================================
set -euo pipefail

# ---- sanity checks ---------------------------------------------------------
if [ ! -f "package.json" ] || [ ! -d "src" ] || [ ! -f "config/config.yml.example" ]; then
  echo "Run this from inside the gus/ project directory (the one with package.json, src/, config/)." >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
  echo "Need root or sudo to install packages. Re-run as root, or install sudo first." >&2
  exit 1
fi
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

# Fail fast, not halfway through, if sudo exists but can't actually
# authenticate (e.g. some container images give the default user an
# unset/unusable password — no string typed at a prompt will ever work).
# `-n` means "don't prompt, just tell me if it would work."
if [ -n "$SUDO" ] && ! sudo -n true 2>/dev/null; then
  echo "sudo can't authenticate non-interactively on this account (no usable password set)." >&2
  echo "Become root first, then re-run this script from inside that shell:" >&2
  echo "    sudo su -" >&2
  echo "    cd $(pwd)" >&2
  echo "    ./setup-gus.sh" >&2
  exit 1
fi

# Runs a psql command/query AS the postgres system user — works whether or
# not `sudo` is installed (root-only containers often don't have it).
pg_exec() {
  if command -v sudo >/dev/null 2>&1; then
    sudo -u postgres psql -tAc "$1"
  else
    su postgres -c "psql -tAc \"$1\""
  fi
}

# Sets a role's password via psql's \password meta-command rather than a
# literal ALTER USER ... WITH PASSWORD '<plaintext>' statement. \password
# hashes the password client-side and sends only the hash, so the
# plaintext never appears in any SQL statement — confirmed with
# log_statement=all: a literal ALTER USER ... PASSWORD '...' does get the
# plaintext written straight into Postgres's own server log, \password
# doesn't write it anywhere. Piped via a heredoc (not a CLI arg), so it
# never appears in `ps aux` either.
pg_set_password() {
  local role="$1" password="$2"
  if command -v sudo >/dev/null 2>&1; then
    sudo -u postgres psql -c "\\password ${role}" <<PWEOF
${password}
${password}
PWEOF
  else
    su postgres -c "psql -c '\\password ${role}'" <<PWEOF
${password}
${password}
PWEOF
  fi
}

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script only supports apt-based systems (Ubuntu/Debian)." >&2
  echo "If you're on a managed/containerized host without apt access, use a" >&2
  echo "managed Postgres provider instead and fill in config/config.yml by hand." >&2
  exit 1
fi

DB_NAME="${GUS_DB_NAME:-gus}"
DB_USER="${GUS_DB_USER:-gus}"
DB_PASSWORD="${GUS_DB_PASSWORD:-}"

# ---- 1. install postgres ---------------------------------------------------
if command -v psql >/dev/null 2>&1; then
  echo "==> PostgreSQL already installed, skipping install."
else
  echo "==> Installing PostgreSQL..."
  # Don't let an unrelated broken third-party repo (nodesource, docker's
  # apt source, etc.) hard-abort the whole script — we only actually need
  # the main Ubuntu archives to install postgresql.
  $SUDO apt-get update -qq || echo "    (some apt sources failed to refresh — continuing, since we only need the main Ubuntu repos here)" >&2
  $SUDO apt-get install -y postgresql postgresql-contrib
fi

$SUDO systemctl enable postgresql >/dev/null 2>&1 || true
$SUDO systemctl start postgresql >/dev/null 2>&1 || $SUDO service postgresql start >/dev/null 2>&1 || true

# Containers (Codespaces included) commonly block the package's own
# post-install hook from starting — or even creating — a cluster. Check
# for real, don't just assume the line above worked.
if ! command -v pg_lsclusters >/dev/null 2>&1; then
  echo "pg_lsclusters not found — postgresql-common didn't install correctly." >&2
  exit 1
fi

if [ -z "$(pg_lsclusters -h)" ]; then
  echo "==> No Postgres cluster exists yet — creating one (install alone didn't set it up)..."
  PG_VERSION="$(ls /usr/lib/postgresql/ 2>/dev/null | sort -V | tail -1)"
  if [ -z "$PG_VERSION" ]; then
    echo "Couldn't detect an installed Postgres version under /usr/lib/postgresql/." >&2
    exit 1
  fi
  $SUDO pg_createcluster "$PG_VERSION" main --start
else
  echo "==> Cluster exists — making sure it's started..."
  $SUDO service postgresql start >/dev/null 2>&1 || true
fi

# Wait for the socket to actually accept connections instead of racing
# ahead and hitting a confusing failure a few steps later.
READY=0
for i in $(seq 1 15); do
  if pg_exec "SELECT 1" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "Postgres still isn't accepting connections after 15s. Check: sudo service postgresql status" >&2
  exit 1
fi
echo "==> Postgres is up."

# ---- 2-4. database credentials + config.yml --------------------------------
# All tied to whether config.yml already exists — that file is the single
# source of truth for "what password does GUS actually use." If it exists,
# trust it completely and don't touch the role's password at all (that's
# what caused a real bug: regenerating a random password on every run and
# only syncing it to Postgres when the role was brand new, so a pre-existing
# role + a fresh config.yml ended up with two different passwords). If it
# doesn't exist yet, this run is the one deciding the password, so the role
# gets explicitly set (not just created) to match, whether it's new or was
# left over from an earlier, incomplete attempt.
if [ -f "config/config.yml" ]; then
  echo "==> config/config.yml already exists — verifying its credentials actually work..."
  # Pulls values out of the database: block with only the stdlib (no
  # pyyaml — can't assume that's installed on a fresh container).
  CFG_VALUES="$(python3 - <<'PYEOF'
import re
text = open("config/config.yml").read()
m = re.search(r'^database:\s*\n((?:[ \t]+.*\n?)*)', text, re.MULTILINE)
block = m.group(1) if m else ""
def get(key):
    mm = re.search(rf'^\s*{key}:\s*"?([^"\n]*?)"?\s*$', block, re.MULTILINE)
    return mm.group(1).strip() if mm else ""
for k in ("host", "port", "name", "user", "password"):
    print(get(k))
PYEOF
)"
  CFG_DB_HOST=$(sed -n '1p' <<< "$CFG_VALUES")
  CFG_DB_PORT=$(sed -n '2p' <<< "$CFG_VALUES")
  CFG_DB_NAME=$(sed -n '3p' <<< "$CFG_VALUES")
  CFG_DB_USER=$(sed -n '4p' <<< "$CFG_VALUES")
  CFG_DB_PASSWORD=$(sed -n '5p' <<< "$CFG_VALUES")

  if [ -z "$CFG_DB_HOST" ] || [ -z "$CFG_DB_USER" ]; then
    echo "Couldn't parse the database: block out of config/config.yml — check it hasn't been malformed by hand-editing." >&2
    exit 1
  fi

  if PGPASSWORD="$CFG_DB_PASSWORD" psql -h "$CFG_DB_HOST" -p "$CFG_DB_PORT" -U "$CFG_DB_USER" -d "$CFG_DB_NAME" -tAc "SELECT 1" >/dev/null 2>&1; then
    echo "==> Credentials check out — leaving config.yml alone."
  else
    echo "==> config.yml's password does NOT match the real database role — syncing the role to match config.yml (not touching the file, since you may have edited other settings in it)..."
    pg_set_password "${CFG_DB_USER}" "${CFG_DB_PASSWORD}"
    if PGPASSWORD="$CFG_DB_PASSWORD" psql -h "$CFG_DB_HOST" -p "$CFG_DB_PORT" -U "$CFG_DB_USER" -d "$CFG_DB_NAME" -tAc "SELECT 1" >/dev/null 2>&1; then
      echo "==> Fixed — role password now matches config.yml."
    else
      echo "Still can't authenticate as \"${CFG_DB_USER}\" against database \"${CFG_DB_NAME}\" after syncing the password." >&2
      echo "Check that database \"${CFG_DB_NAME}\" and role \"${CFG_DB_USER}\" actually exist: sudo -u postgres psql -c '\du' -c '\l'" >&2
      exit 1
    fi
  fi
else
  if [ -z "$DB_PASSWORD" ]; then
    DB_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)"
    echo "==> Generated a random database password."
  fi

  ROLE_EXISTS=$(pg_exec "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'")
  if [ "$ROLE_EXISTS" = "1" ]; then
    echo "==> Role \"${DB_USER}\" already exists — syncing its password to the one going into config.yml..."
  else
    echo "==> Creating role \"${DB_USER}\"..."
    pg_exec "CREATE USER ${DB_USER};"
  fi
  pg_set_password "${DB_USER}" "${DB_PASSWORD}"

  DB_EXISTS=$(pg_exec "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")
  if [ "$DB_EXISTS" = "1" ]; then
    echo "==> Database \"${DB_NAME}\" already exists, skipping create."
  else
    echo "==> Creating database \"${DB_NAME}\" (owner: ${DB_USER})..."
    pg_exec "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
  fi

  echo "==> Creating config/config.yml from the example..."
  cp config/config.yml.example config/config.yml
  SESSION_SECRET="$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
  ENCRYPTION_KEY="$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
  python3 - "$DB_NAME" "$DB_USER" "$DB_PASSWORD" "$SESSION_SECRET" "$ENCRYPTION_KEY" <<'PYEOF'
import sys
db_name, db_user, db_password, session_secret, encryption_key = sys.argv[1:6]
path = "config/config.yml"
with open(path) as f:
    text = f.read()
text = text.replace('name: "gus"', f'name: "{db_name}"')
text = text.replace('user: "gus"', f'user: "{db_user}"')
text = text.replace('password: "CHANGE_ME"', f'password: "{db_password}"')
text = text.replace('sessionSecret: "CHANGE_ME_TO_A_RANDOM_STRING"', f'sessionSecret: "{session_secret}"')
text = text.replace('encryptionKey: "CHANGE_ME_TO_A_DIFFERENT_RANDOM_STRING"', f'encryptionKey: "{encryption_key}"')
with open(path, "w") as f:
    f.write(text)
PYEOF
  echo "    Wrote database credentials, a random session secret, and a random encryption key."
  echo "    Edit config/config.yml later to set server.publicUrl once you know your domain."
fi

# ---- 5. npm install + migrate ----------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 18+ before continuing (this script doesn't install it)." >&2
  exit 1
fi

echo "==> Installing npm dependencies..."
npm install --silent

echo "==> Running database migrations..."
npm run migrate

# ---- 6. sysadmin account — always prompted, no yes/no gate -----------------
echo
echo "==> Create your sysadmin account."
read -r -p "    Sysadmin username: " SYSADMIN_USERNAME
while [ -z "$SYSADMIN_USERNAME" ]; do
  read -r -p "    Username can't be blank. Sysadmin username: " SYSADMIN_USERNAME
done

SYSADMIN_PASSWORD=""
while [ "${#SYSADMIN_PASSWORD}" -lt 8 ]; do
  read -r -s -p "    Temporary password (min 8 characters, you'll be forced to change it on first login): " SYSADMIN_PASSWORD
  echo
  if [ "${#SYSADMIN_PASSWORD}" -lt 8 ]; then
    echo "    Too short — needs to be at least 8 characters."
  fi
done

read -r -p "    App slug to register alongside this account [console]: " APP_SLUG
APP_SLUG="${APP_SLUG:-console}"

echo
if npm run bootstrap -- --username "$SYSADMIN_USERNAME" --password "$SYSADMIN_PASSWORD" --app "$APP_SLUG"; then
  echo "==> Sysadmin account created. If an app secret was printed above, copy it into that app's config now — it will not be shown again."
else
  echo "==> Bootstrap step failed or was already done (e.g. that username/app already exists)." >&2
  echo "    Continuing on to start the server anyway." >&2
fi

# ---- 7. start the server ----------------------------------------------------
echo
echo "==> Starting GAM..."
npm start
