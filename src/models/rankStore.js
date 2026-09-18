'use strict';

// Every capability a rank can be granted. Adding a new one later is just
// adding a key here, a column in migrations, and a route-level
// requireCapability() check — nothing else has to change to support it.
const CAPABILITIES = ['manageUsers', 'manageRanks', 'manageApps', 'viewActivity', 'manageBranding', 'managePasswordPolicy', 'manageEmail'];

const CAPABILITY_COLUMNS = {
  manageUsers: 'manage_users',
  manageRanks: 'manage_ranks',
  manageApps: 'manage_apps',
  viewActivity: 'view_activity',
  manageBranding: 'manage_branding',
  managePasswordPolicy: 'manage_password_policy',
  manageEmail: 'manage_email',
};

// Both hardcoded rather than trusted from the database row, so neither
// can be lockable-out-of-its-own-purpose by a bad UPDATE: systemAdministrator
// must never lose a capability, and trustedInstaller ("Provider" — the
// account bootstrap.js creates) must always have every one, the same
// guarantee systemAdministrator gets. Their `ranks` rows exist so they
// show up normally in listings (and can still have their COLOR
// customized, see update() below), but capabilities are decided here.
const HARDCODED_CAPABILITIES = {
  systemAdministrator: CAPABILITIES.reduce((acc, c) => ({ ...acc, [c]: true }), {}),
  trustedInstaller: CAPABILITIES.reduce((acc, c) => ({ ...acc, [c]: true }), {}),
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function toRank(row) {
  if (!row) return null;
  const capabilities = {};
  for (const cap of CAPABILITIES) capabilities[cap] = row[CAPABILITY_COLUMNS[cap]];
  return {
    name: row.name,
    label: row.label,
    isBuiltin: row.is_builtin,
    locked: row.locked,
    color: row.color,
    capabilities: HARDCODED_CAPABILITIES[row.name] || capabilities,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class RankStore {
  constructor(pool) {
    this.pool = pool;
  }

  async list() {
    const { rows } = await this.pool.query('SELECT * FROM ranks ORDER BY is_builtin DESC, label ASC');
    return rows.map(toRank);
  }

  async findByName(name) {
    const { rows } = await this.pool.query('SELECT * FROM ranks WHERE name = $1', [name]);
    return toRank(rows[0]);
  }

  async exists(name) {
    const { rows } = await this.pool.query('SELECT 1 FROM ranks WHERE name = $1', [name]);
    return rows.length > 0;
  }

  /** Resolves a single capability for a rank name — the check every requireCapability() route uses. */
  async hasCapability(rankName, capability) {
    if (!CAPABILITIES.includes(capability)) throw new Error(`Unknown capability "${capability}"`);
    if (HARDCODED_CAPABILITIES[rankName]) return HARDCODED_CAPABILITIES[rankName][capability];
    const rank = await this.findByName(rankName);
    return rank ? rank.capabilities[capability] : false;
  }

  /** Full capability map for a rank — what the frontend uses to decide which tabs to show. */
  async capabilitiesFor(rankName) {
    if (HARDCODED_CAPABILITIES[rankName]) return { ...HARDCODED_CAPABILITIES[rankName] };
    const rank = await this.findByName(rankName);
    if (rank) return { ...rank.capabilities };
    return CAPABILITIES.reduce((acc, c) => ({ ...acc, [c]: false }), {});
  }

  async create({ name, label, capabilities = {}, color }) {
    if (!name || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
      throw new Error('Rank name must start with a letter and contain only letters and numbers');
    }
    if (!label || !label.trim()) throw new Error('Rank label is required');
    if (color !== undefined && !HEX_COLOR.test(color)) throw new Error('Color must be a hex value like #ff8a3d');
    if (await this.exists(name)) throw new Error('A rank with that name already exists');

    const columns = ['name', 'label'];
    const values = [name, label.trim()];
    for (const cap of CAPABILITIES) {
      columns.push(CAPABILITY_COLUMNS[cap]);
      values.push(!!capabilities[cap]);
    }
    if (color !== undefined) { columns.push('color'); values.push(color); }
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    const { rows } = await this.pool.query(
      `INSERT INTO ranks (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    return toRank(rows[0]);
  }

  /**
   * label/capabilities are refused on a locked rank (systemAdministrator,
   * trustedInstaller) — those are hardcoded in this file, so a DB edit
   * would just be lying about what the rank actually does. color is
   * cosmetic, not a capability, so it's exempt: a sysadmin can restyle
   * even a locked rank's badge.
   */
  async update(name, { label, capabilities, color }) {
    const rank = await this.findByName(name);
    if (!rank) throw new Error('No such rank');
    if (rank.locked && (label !== undefined || capabilities !== undefined)) {
      throw new Error(`"${rank.label}" is a protected rank and its capabilities can't be modified`);
    }

    const sets = [];
    const values = [];
    let i = 1;
    if (label !== undefined) {
      if (!label.trim()) throw new Error('Rank label is required');
      sets.push(`label = $${i++}`);
      values.push(label.trim());
    }
    if (capabilities !== undefined) {
      for (const cap of CAPABILITIES) {
        if (Object.prototype.hasOwnProperty.call(capabilities, cap)) {
          sets.push(`${CAPABILITY_COLUMNS[cap]} = $${i++}`);
          values.push(!!capabilities[cap]);
        }
      }
    }
    if (color !== undefined) {
      if (!HEX_COLOR.test(color)) throw new Error('Color must be a hex value like #ff8a3d');
      sets.push(`color = $${i++}`);
      values.push(color);
    }
    if (!sets.length) return rank;

    values.push(name);
    const { rows } = await this.pool.query(
      `UPDATE ranks SET ${sets.join(', ')}, updated_at = now() WHERE name = $${i} RETURNING *`, values
    );
    return toRank(rows[0]);
  }

  async remove(name) {
    const rank = await this.findByName(name);
    if (!rank) throw new Error('No such rank');
    if (rank.isBuiltin) throw new Error(`"${rank.label}" is a built-in rank and can't be deleted`);
    try {
      const { rowCount } = await this.pool.query('DELETE FROM ranks WHERE name = $1', [name]);
      if (!rowCount) throw new Error('No such rank');
    } catch (err) {
      if (err.code === '23503') throw new Error('This rank is still assigned to one or more users — reassign them first');
      throw err;
    }
  }
}

// The ranks with every capability hardcoded true — "at least one enabled
// account in one of these ranks must always exist" is the actual invariant
// behind "last remaining sysadmin" protections (userStore.countFullAdmins,
// the users.js routes, and the enforce_min_one_sysadmin DB trigger), now
// that trustedInstaller (Provider) is a second full-access rank alongside
// systemAdministrator.
const FULL_CAPABILITY_RANKS = Object.keys(HARDCODED_CAPABILITIES);

module.exports = { RankStore, CAPABILITIES, FULL_CAPABILITY_RANKS };
