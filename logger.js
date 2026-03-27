// PRJX LP Manager — SQLite Logger
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'lp_manager.db'));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT    NOT NULL DEFAULT (datetime('now')),
    position_id INTEGER NOT NULL,
    action      TEXT    NOT NULL,  -- 'claim_fees' | 'rebalance' | 'remove' | 'add'
    pool        TEXT,
    token0      TEXT,
    token1      TEXT,
    amount0     TEXT,
    amount1     TEXT,
    usd_value   REAL,
    tx_hash     TEXT,
    notes       TEXT
  );

  CREATE TABLE IF NOT EXISTS position_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT    NOT NULL DEFAULT (datetime('now')),
    position_id INTEGER NOT NULL,
    tick_lower  INTEGER,
    tick_upper  INTEGER,
    current_tick INTEGER,
    in_range    INTEGER,  -- 0 or 1
    liquidity   TEXT,
    fees0_usd   REAL,
    fees1_usd   REAL,
    total_fees_usd REAL
  );
`);

const log = {
  action(positionId, action, data = {}) {
    const stmt = db.prepare(`
      INSERT INTO actions (position_id, action, pool, token0, token1, amount0, amount1, usd_value, tx_hash, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      positionId, action,
      data.pool || null, data.token0 || null, data.token1 || null,
      data.amount0 || null, data.amount1 || null,
      data.usdValue || null, data.txHash || null, data.notes || null
    );
    console.log(`[${new Date().toISOString()}] [#${positionId}] ${action.toUpperCase()}${data.usdValue ? ` $${data.usdValue.toFixed(2)}` : ''}${data.txHash ? ` tx:${data.txHash.slice(0, 10)}...` : ''}`);
  },

  snapshot(positionId, data) {
    const stmt = db.prepare(`
      INSERT INTO position_snapshots (position_id, tick_lower, tick_upper, current_tick, in_range, liquidity, fees0_usd, fees1_usd, total_fees_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      positionId,
      data.tickLower, data.tickUpper, data.currentTick,
      data.inRange ? 1 : 0,
      data.liquidity?.toString() || '0',
      data.fees0Usd || 0, data.fees1Usd || 0,
      (data.fees0Usd || 0) + (data.fees1Usd || 0)
    );
  },

  getRebalanceCount(positionId, withinHours = 24) {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM actions
      WHERE position_id = ? AND action = 'rebalance'
      AND timestamp > datetime('now', '-${withinHours} hours')
    `).get(positionId);
    return row.cnt;
  },

  getLastClaimTime(positionId) {
    const row = db.prepare(`
      SELECT timestamp FROM actions
      WHERE position_id = ? AND action = 'claim_fees'
      ORDER BY id DESC LIMIT 1
    `).get(positionId);
    return row ? new Date(row.timestamp) : null;
  },

  getHistory(limit = 20) {
    return db.prepare(`SELECT * FROM actions ORDER BY id DESC LIMIT ?`).all(limit);
  },

  // Fee summary over a time window
  getFeeSummary(days) {
    const rows = db.prepare(`
      SELECT
        position_id,
        COUNT(*)        AS claim_count,
        SUM(usd_value)  AS total_usd
      FROM actions
      WHERE action = 'claim_fees'
        AND timestamp > datetime('now', '-${days} days')
      GROUP BY position_id
    `).all();

    const total = db.prepare(`
      SELECT
        COUNT(*)        AS claim_count,
        SUM(usd_value)  AS total_usd
      FROM actions
      WHERE action = 'claim_fees'
        AND timestamp > datetime('now', '-${days} days')
    `).get();

    return { byPosition: rows, total };
  },

  // All-time fee total
  getAllTimeFees() {
    return db.prepare(`
      SELECT
        COUNT(*)        AS claim_count,
        SUM(usd_value)  AS total_usd,
        MIN(timestamp)  AS first_claim,
        MAX(timestamp)  AS last_claim
      FROM actions
      WHERE action = 'claim_fees'
    `).get();
  }
};

module.exports = log;
