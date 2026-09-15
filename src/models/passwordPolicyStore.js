'use strict';
const { RULE_TYPES } = require('../utils/passwordPolicy');

function toRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    enabled: row.enabled,
    params: row.params,
    sortOrder: row.sort_order,
  };
}

class PasswordPolicyStore {
  constructor(pool) {
    this.pool = pool;
  }

  async list() {
    const { rows } = await this.pool.query('SELECT * FROM password_policy_rules ORDER BY sort_order ASC, created_at ASC');
    return rows.map(toRule);
  }

  async listEnabled() {
    return (await this.list()).filter((r) => r.enabled);
  }

  async create({ type, label, params = {}, enabled = true }) {
    if (!RULE_TYPES[type]) throw new Error(`Unknown rule type "${type}". Available: ${Object.keys(RULE_TYPES).join(', ')}`);
    if (!label || !label.trim()) throw new Error('Rule label is required');
    const { rows } = await this.pool.query(
      `INSERT INTO password_policy_rules (type, label, enabled, params, sort_order)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM password_policy_rules))
       RETURNING *`,
      [type, label.trim(), !!enabled, JSON.stringify(params)]
    );
    return toRule(rows[0]);
  }

  async update(id, { label, enabled, params }) {
    const sets = [];
    const values = [];
    let i = 1;
    if (label !== undefined) { sets.push(`label = $${i++}`); values.push(label.trim()); }
    if (enabled !== undefined) { sets.push(`enabled = $${i++}`); values.push(!!enabled); }
    if (params !== undefined) { sets.push(`params = $${i++}`); values.push(JSON.stringify(params)); }
    if (!sets.length) {
      const { rows } = await this.pool.query('SELECT * FROM password_policy_rules WHERE id = $1', [id]);
      if (!rows[0]) throw new Error('No such rule');
      return toRule(rows[0]);
    }
    values.push(id);
    const { rows } = await this.pool.query(
      `UPDATE password_policy_rules SET ${sets.join(', ')}, updated_at = now() WHERE id = $${i} RETURNING *`, values
    );
    if (!rows[0]) throw new Error('No such rule');
    return toRule(rows[0]);
  }

  async remove(id) {
    const { rowCount } = await this.pool.query('DELETE FROM password_policy_rules WHERE id = $1', [id]);
    if (!rowCount) throw new Error('No such rule');
  }
}

module.exports = { PasswordPolicyStore };
