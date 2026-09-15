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

// These two ranks are hardcoded rather than trusted from the database
// row: systemAdministrator must never be lockable-out-of-its-own-system
// by a bad UPDATE, and trustedInstaller must never be able to pick up
// account-management capabilities, since "cannot manage accounts" is the
// entire point of that rank. Their `ranks` rows exist so they show up
// normally in listings, but their capabilities are decided here.
const HARDCODED_CAPABILITIES = {
  systemAdministrator: CAPABILITIES.reduce((acc, c) => ({ ...acc, [c]: true }), {}),
  trustedInstaller: CAPABILITIES.reduce((acc, c) => ({ ...acc, [c]: false }), {}),
};

function toRank(row) {
  if (!row) return null;
  const capabilities = {};
  for (const cap of CAPABILITIES) capabilities[cap] = row[CAPABILITY_COLUMNS[cap]];
  return {
    name: row.name,
    label: row.label,
    isBuiltin: row.is_builtin,
    locked: row.locked,
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

  async create({ name, label, capabilities = {} }) {
    if (!name || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
      throw new Error('Rank name must start with a letter and contain only letters and numbers');
    }
    if (!label || !label.trim()) throw new Error('Rank label is required');
    if (await this.exists(name)) throw new Error('A rank with that name already exists');

    const columns = ['name', 'label'];
    const values = [name, label.trim()];
    for (const cap of CAPABILITIES) {
      columns.push(CAPABILITY_COLUMNS[cap]);
      values.push(!!capabilities[cap]);
    }
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    const { rows } = await this.pool.query(
      `INSERT INTO ranks (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    return toRank(rows[0]);
  }

  async update(name, { label, capabilities }) {
    const rank = await this.findByName(name);
    if (!rank) throw new Error('No such rank');
    if (rank.locked) throw new Error(`"${rank.label}" is a protected rank and can't be modified`);

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

module.exports = { RankStore, CAPABILITIES };
