'use strict';
const EventEmitter = require('events');

class ActivityLog extends EventEmitter {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  /**
   * actorUsername is stored alongside actor_uid (denormalized) so the
   * audit trail still reads correctly even after that user's account is
   * later deleted — actor_uid alone would go NULL and silently erase who
   * did it.
   */
  async add(category, message, actorUid = null, actorUsername = null) {
    const { rows } = await this.pool.query(
      'INSERT INTO activity_log (category, message, actor_uid, actor_username) VALUES ($1, $2, $3, $4) RETURNING *',
      [category, message, actorUid, actorUsername]
    );
    this.emit('add', rows[0]);
    return rows[0];
  }

  /**
   * Filterable + paginated for the Activity tab's filter controls and
   * CSV export. All filters are optional and combine with AND.
   */
  async list({ limit = 50, category = null, actor = null, from = null, to = null } = {}) {
    const clauses = [];
    const values = [];
    let i = 1;

    if (category) { clauses.push(`category = $${i++}`); values.push(category); }
    if (actor) { clauses.push(`actor_username ILIKE $${i++}`); values.push(`%${actor}%`); }
    if (from) { clauses.push(`created_at >= $${i++}`); values.push(from); }
    if (to) { clauses.push(`created_at <= $${i++}`); values.push(to); }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    values.push(Math.min(Number(limit) || 50, 1000));
    const { rows } = await this.pool.query(
      `SELECT * FROM activity_log ${where} ORDER BY created_at DESC LIMIT $${i}`, values
    );
    return rows;
  }

  /** Distinct categories seen so far, to populate the filter dropdown. */
  async categories() {
    const { rows } = await this.pool.query('SELECT DISTINCT category FROM activity_log ORDER BY category');
    return rows.map((r) => r.category);
  }
}

module.exports = { ActivityLog };
