'use strict';
const { RallyError, isQuerySafeEmail } = require('./rallyClient');

/**
 * Keeps one Rally user per enrolled Passport account: created when the
 * Passport account is created, disabled/re-enabled with it, and disabled
 * (or deleted — config.rally.onPassportDelete) when it's deleted.
 *
 * Works as a reconciler rather than a fire-once hook: every Passport-side
 * change only records the DESIRED state in rally_accounts (migration 014)
 * and then tries to apply it. If Rally is down, slow, or rejects the call,
 * Passport's own operation still succeeds, the row stays out of sync with
 * the error recorded, and the background sweep (server.js) retries it.
 * Nothing here ever throws into the caller — Rally being unavailable must
 * never block creating, disabling or deleting a Passport account.
 */

const LOCK_SECONDS = 300;
const MAX_STEPS_PER_RECONCILE = 4;
const WAITING_FOR_EMAIL = 'Waiting for an email address (Rally requires one)';

const DEFAULT_OPTIONS = {
  onPassportDelete: 'disable',
  maxAttempts: 10,
  userDefaults: { Language: 'US English', Locale: 'US English', sessionTimeout: 3600 },
};

class RallySync {
  constructor({ pool, client, userStore, activityLog = null, options = {} }) {
    this.pool = pool;
    this.client = client;
    this.userStore = userStore;
    this.activityLog = activityLog;
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      userDefaults: { ...DEFAULT_OPTIONS.userDefaults, ...(options.userDefaults || {}) },
    };
    if (!['disable', 'delete'].includes(this.options.onPassportDelete)) {
      throw new Error(`rally.onPassportDelete must be "disable" or "delete", got "${this.options.onPassportDelete}"`);
    }
  }

  /* ---------------- Passport lifecycle hooks (called by UserStore) ---------------- */

  async onUserCreated(profile) {
    await this.enroll(profile);
  }

  /** Only reacts to the two changes that matter to Rally: disabled flipping, or an email arriving for a not-yet-created Rally user. */
  async onUserUpdated(before, after) {
    const row = await this.get(after.uid);
    if (!row) return;
    const desired = after.disabled ? 'disabled' : 'active';
    const emailArrived = !row.rally_object_id && after.email && after.email !== (before && before.email);
    if (desired === row.desired_state && !emailArrived) return;
    await this.pool.query(
      `UPDATE rally_accounts SET desired_state = $2, username = $3, in_sync = false, attempts = 0, last_error = NULL, updated_at = now()
       WHERE uid = $1`,
      [after.uid, desired, after.username]
    );
    await this.reconcile(after.uid);
  }

  async onUserDeleted({ uid }) {
    const { rowCount } = await this.pool.query(
      `UPDATE rally_accounts SET desired_state = 'deleted', in_sync = false, attempts = 0, last_error = NULL, updated_at = now()
       WHERE uid = $1`,
      [uid]
    );
    if (rowCount) await this.reconcile(uid);
  }

  /**
   * Starts syncing a Passport account to Rally (or restarts a stuck one —
   * resets the attempt counter). Used on create, and by `rally sync` in the
   * CLI for accounts that existed before Rally sync was turned on.
   */
  async enroll(profile) {
    const desired = profile.disabled ? 'disabled' : 'active';
    await this.pool.query(
      `INSERT INTO rally_accounts (uid, username, desired_state) VALUES ($1, $2, $3)
       ON CONFLICT (uid) DO UPDATE SET username = EXCLUDED.username, desired_state = EXCLUDED.desired_state,
         in_sync = false, attempts = 0, last_error = NULL, updated_at = now()`,
      [profile.uid, profile.username, desired]
    );
    return this.reconcile(profile.uid);
  }

  /**
   * Records that a Passport account IS an existing Rally user (the Rally
   * import), without searching Rally or creating anything. Marked
   * linked_existing, so Passport will never hard-delete that Rally user.
   * If the two disagree on enabled/disabled, Passport wins: the row is
   * left out of sync and reconciled, which updates the Rally user.
   * Refuses (returns null) if the Passport account is already linked to
   * a different Rally user, or that Rally user to a different account.
   * An enrolled account that never got a Rally user yet (rally_object_id
   * NULL — e.g. Rally was down when it was created, or it has no email)
   * isn't linked to anything, so it can be linked here.
   */
  async link(profile, rallyUser) {
    const desired = profile.disabled ? 'disabled' : 'active';
    const rallyState = rallyUser.Disabled ? 'disabled' : 'active';
    const { rows } = await this.pool.query(
      `INSERT INTO rally_accounts (uid, username, desired_state, rally_state, rally_object_id, rally_object_uuid, rally_email, linked_existing, in_sync)
       SELECT $1, $2, $3, $4, $5, $6, $7, true, $3 = $4
       WHERE NOT EXISTS (SELECT 1 FROM rally_accounts WHERE rally_object_id = $5 AND uid <> $1 AND desired_state <> 'deleted')
       ON CONFLICT (uid) DO UPDATE SET
         username = EXCLUDED.username, desired_state = EXCLUDED.desired_state, rally_state = EXCLUDED.rally_state,
         rally_object_id = EXCLUDED.rally_object_id, rally_object_uuid = EXCLUDED.rally_object_uuid,
         rally_email = EXCLUDED.rally_email, linked_existing = true, in_sync = EXCLUDED.in_sync,
         attempts = 0, last_error = NULL, updated_at = now()
       WHERE rally_accounts.rally_object_id IS NULL AND rally_accounts.desired_state <> 'deleted'
       RETURNING *`,
      [profile.uid, profile.username, desired, rallyState, rallyUser.ObjectID, rallyUser.ObjectUUID || null, rallyUser.EmailAddress || null]
    );
    if (!rows.length) return null;
    await this.log(`Rally: linked "${profile.username}" to existing Rally user ${rallyUser.UserName || rallyUser.EmailAddress} (ObjectID ${rallyUser.ObjectID})`);
    return rows[0].in_sync ? rows[0] : this.reconcile(profile.uid);
  }

  /** Every live link between a Passport account and an actual Rally user, for the import planner. */
  async activeLinks() {
    const { rows } = await this.pool.query(
      `SELECT * FROM rally_accounts WHERE desired_state <> 'deleted' AND rally_object_id IS NOT NULL`
    );
    return rows;
  }

  /* ---------------- Reconciliation ---------------- */

  /** Brings one row in line with its desired state. Returns the row afterward. Never throws. */
  async reconcile(uid) {
    try {
      const claimed = await this.claim(uid);
      if (!claimed) return this.get(uid); // someone else is working it right now
      try {
        for (let step = 0; step < MAX_STEPS_PER_RECONCILE; step++) {
          const row = await this.get(uid);
          if (!row || row.in_sync) break;
          const progressed = await this.step(row);
          if (!progressed) break;
        }
      } finally {
        await this.pool.query('UPDATE rally_accounts SET locked_until = NULL WHERE uid = $1', [uid]);
      }
      return this.get(uid);
    } catch (err) {
      console.error(`Rally sync for ${uid} failed unexpectedly:`, err);
      return null;
    }
  }

  /** Runs every out-of-sync row that hasn't used up its attempts. For the periodic sweep in server.js. */
  async sweep({ limit = 100 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT uid FROM rally_accounts
       WHERE in_sync = false AND attempts < $1 AND (locked_until IS NULL OR locked_until < now())
       ORDER BY updated_at ASC LIMIT $2`,
      [this.options.maxAttempts, limit]
    );
    for (const { uid } of rows) await this.reconcile(uid);
    return rows.length;
  }

  /** Gives every failed row a fresh set of attempts. */
  async resetFailed() {
    const { rowCount } = await this.pool.query(
      `UPDATE rally_accounts SET attempts = 0, updated_at = now() WHERE in_sync = false AND attempts > 0`
    );
    return rowCount;
  }

  /**
   * One action toward the desired state. Returns true if it changed
   * something (so the caller should look again), false if there's nothing
   * more to do right now (in sync, waiting on an email, or failed).
   */
  async step(row) {
    const action = await this.nextAction(row);
    if (action.type === 'done') {
      await this.save(row.uid, { in_sync: true, attempts: 0, last_error: null });
      return false;
    }
    if (action.type === 'wait') {
      await this.save(row.uid, { in_sync: false, last_error: action.reason });
      return false;
    }

    try {
      const changes = await this.perform(row, action);
      await this.save(row.uid, { ...changes, attempts: 0, last_error: null, last_attempt_at: new Date() });
      return true;
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = err instanceof RallyError ? err.message : `Unexpected error: ${err.message}`;
      await this.save(row.uid, { in_sync: false, attempts, last_error: message, last_attempt_at: new Date() });
      if (attempts === 1 || attempts === this.options.maxAttempts) {
        const suffix = attempts === this.options.maxAttempts ? ' — giving up until retried (CLI: rally retry)' : ' — will retry';
        await this.log(`Rally ${action.type} for "${row.username}" failed: ${message}${suffix}`);
      }
      return false;
    }
  }

  async nextAction(row) {
    if (row.desired_state === 'deleted') {
      if (!row.rally_object_id || row.rally_state === 'deleted') return { type: 'done' };
      // Never hard-delete a Rally user Passport didn't create — linking was
      // just "this person already had a Rally account", not ownership.
      const hardDelete = this.options.onPassportDelete === 'delete' && !row.linked_existing;
      if (hardDelete) return { type: 'delete' };
      return row.rally_state === 'disabled' ? { type: 'done' } : { type: 'disable' };
    }

    if (!row.rally_object_id) {
      const profile = await this.userStore.getProfile(row.uid);
      if (!profile) return { type: 'wait', reason: 'Passport account not found' };
      if (!profile.email) return { type: 'wait', reason: WAITING_FOR_EMAIL };
      return { type: 'create', profile };
    }

    if (row.rally_state !== row.desired_state) {
      return { type: row.desired_state === 'disabled' ? 'disable' : 'enable' };
    }
    return { type: 'done' };
  }

  async perform(row, action) {
    switch (action.type) {
      case 'create': {
        const { profile } = action;
        if (!isQuerySafeEmail(profile.email)) throw new RallyError(`Email address "${profile.email}" isn't usable with Rally`);
        const existing = await this.client.findUserByEmail(profile.email);
        if (existing) {
          await this.log(`Rally: linked "${profile.username}" to existing Rally user ${existing.UserName || existing.EmailAddress} (ObjectID ${existing.ObjectID})`);
          return {
            rally_object_id: existing.ObjectID, rally_object_uuid: existing.ObjectUUID || null,
            rally_email: existing.EmailAddress || profile.email, linked_existing: true,
            rally_state: existing.Disabled ? 'disabled' : 'active',
          };
        }
        const created = await this.client.createUser(this.buildUserFields(profile, row.desired_state === 'disabled'));
        await this.log(`Rally: created Rally user for "${profile.username}" (ObjectID ${created.ObjectID})`);
        return {
          rally_object_id: created.ObjectID, rally_object_uuid: created.ObjectUUID || null,
          rally_email: created.EmailAddress || profile.email, linked_existing: false,
          rally_state: row.desired_state === 'disabled' ? 'disabled' : 'active',
        };
      }
      case 'disable':
      case 'enable': {
        const disabled = action.type === 'disable';
        await this.client.setUserDisabled(row.rally_object_id, disabled);
        await this.log(`Rally: ${disabled ? 'disabled' : 're-enabled'} Rally user for "${row.username}" (ObjectID ${row.rally_object_id})`);
        return { rally_state: disabled ? 'disabled' : 'active' };
      }
      case 'delete': {
        await this.client.deleteUser(row.rally_object_id);
        await this.log(`Rally: deleted Rally user for "${row.username}" (ObjectID ${row.rally_object_id})`);
        return { rally_state: 'deleted' };
      }
      default:
        throw new Error(`Unknown Rally sync action ${action.type}`);
    }
  }

  buildUserFields(profile, disabled) {
    const d = this.options.userDefaults;
    const fullName = (profile.fullName || '').trim();
    const [first, ...rest] = fullName.split(/\s+/).filter(Boolean);
    const fields = {
      EmailAddress: profile.email,
      Language: d.Language,
      Locale: d.Locale,
      sessionTimeout: Number(d.sessionTimeout),
      DisplayName: (fullName || profile.username).slice(0, 254),
    };
    if (first) fields.FirstName = first.slice(0, 128);
    if (rest.length) fields.LastName = rest.join(' ').slice(0, 128);
    if (disabled) fields.Disabled = true;
    return fields;
  }

  /* ---------------- Storage helpers ---------------- */

  async claim(uid) {
    const { rowCount } = await this.pool.query(
      `UPDATE rally_accounts SET locked_until = now() + make_interval(secs => $2)
       WHERE uid = $1 AND (locked_until IS NULL OR locked_until < now())`,
      [uid, LOCK_SECONDS]
    );
    return rowCount === 1;
  }

  async get(uid) {
    const { rows } = await this.pool.query('SELECT * FROM rally_accounts WHERE uid = $1', [uid]);
    return rows[0] || null;
  }

  async list() {
    const { rows } = await this.pool.query('SELECT * FROM rally_accounts ORDER BY lower(username) ASC');
    return rows;
  }

  async save(uid, fields) {
    const allowed = [
      'rally_state', 'rally_object_id', 'rally_object_uuid', 'rally_email', 'linked_existing',
      'in_sync', 'attempts', 'last_error', 'last_attempt_at',
    ];
    const sets = []; const values = [uid];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) { values.push(fields[key]); sets.push(`${key} = $${values.length}`); }
    }
    if (!sets.length) return;
    await this.pool.query(`UPDATE rally_accounts SET ${sets.join(', ')}, updated_at = now() WHERE uid = $1`, values);
  }

  async log(message) {
    if (!this.activityLog) { console.log(message); return; }
    try { await this.activityLog.add('rally', message); } catch (err) { console.error('Could not write Rally activity entry:', err.message); }
  }
}

module.exports = { RallySync, WAITING_FOR_EMAIL };
