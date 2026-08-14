'use strict';
const EventEmitter = require('events');

class ActivityLog extends EventEmitter {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  async add(category, message, actorUid = null) {
    const { rows } = await this.pool.query(
      'INSERT INTO activity_log (category, message, actor_uid) VALUES ($1, $2, $3) RETURNING *',
      [category, message, actorUid]
    );
    this.emit('add', rows[0]);
    return rows[0];
  }

  async list(limit = 50) {
    const { rows } = await this.pool.query(
      'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT $1', [limit]
    );
    return rows;
  }
}

module.exports = { ActivityLog };
