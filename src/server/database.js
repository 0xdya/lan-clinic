/**
 * database.js - SQLite Database Module (sql.js / WASM edition)
 *
 * Uses sql.js — a pure JavaScript/WebAssembly port of SQLite.
 * No native compilation (node-gyp) required.
 *
 * Design:
 *   - async `initialize()` opens or creates the DB file, runs schema migrations.
 *   - Returns a `DbHandle` object with query/run/get helpers that mimic
 *     the better-sqlite3 synchronous API as closely as possible.
 *   - After every write (INSERT/UPDATE/DELETE) the DB is saved back to disk.
 *   - A periodic auto-save also runs every 30 s as a safety net.
 *
 * Usage in routes:
 *   const { getDb } = require('../database');
 *   const db = getDb();                // synchronous getter after init
 *   const rows = db.query('SELECT …', [param]);
 *   const result = db.run('INSERT …', [param]); // { changes, lastInsertRowid }
 *   const row = db.get('SELECT … LIMIT 1', [param]);
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// DB Path Resolution
// ─────────────────────────────────────────────
const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'clinic.db');

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// ─────────────────────────────────────────────
// Internal State
// ─────────────────────────────────────────────
let _sqlJs = null; // sql.js SQL namespace
let _db = null;    // sql.js Database instance
let _saveTimer = null;

// ─────────────────────────────────────────────
// Persistence Helpers
// ─────────────────────────────────────────────
function saveToFile() {
  if (!_db) return;
  try {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    console.error('[DB] Failed to save database to disk:', err);
  }
}

function startAutoSave(intervalMs = 30_000) {
  if (_saveTimer) clearInterval(_saveTimer);
  _saveTimer = setInterval(saveToFile, intervalMs);
  _saveTimer.unref(); // Don't block process exit
}

// ─────────────────────────────────────────────
// DbHandle — public query API
// ─────────────────────────────────────────────
const DbHandle = {
  /**
   * Execute a SELECT and return all rows as plain objects.
   * @param {string} sql
   * @param {any[]} params  Positional (?) or named (:name) params
   * @returns {object[]}
   */
  query(sql, params = []) {
    const stmt = _db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  },

  /**
   * Execute a SELECT and return the first row or null.
   */
  get(sql, params = []) {
    const rows = DbHandle.query(sql, params);
    return rows.length > 0 ? rows[0] : null;
  },

  /**
   * Execute an INSERT / UPDATE / DELETE.
   * Saves DB to disk after every write.
   * @returns {{ changes: number, lastInsertRowid: number }}
   */
  run(sql, params = []) {
    _db.run(sql, params);
    const changes = _db.getRowsModified();
    const idRow = DbHandle.get('SELECT last_insert_rowid() AS id');
    saveToFile();
    return {
      changes,
      lastInsertRowid: idRow ? idRow.id : 0,
    };
  },

  /** Expose raw save for external callers if needed */
  save: saveToFile,
};

// ─────────────────────────────────────────────
// Schema Migrations
// ─────────────────────────────────────────────
function runMigrations() {
  // Enable foreign keys (sql.js does support PRAGMA)
  _db.run('PRAGMA foreign_keys = ON;');

  _db.run(`
    CREATE TABLE IF NOT EXISTS patients (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name   TEXT    NOT NULL,
      age         INTEGER,
      phone       TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS daily_queue (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id   INTEGER NOT NULL,
      queue_number INTEGER NOT NULL,
      status       TEXT    CHECK(status IN ('Waiting','In Progress','Completed','Cancelled'))
                   DEFAULT 'Waiting',
      doctor_notes TEXT    DEFAULT '',
      visit_date   DATE    DEFAULT (DATE('now')),
      FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
    );
  `);

  _db.run(`
    CREATE INDEX IF NOT EXISTS idx_daily_queue_visit_date
      ON daily_queue(visit_date);
  `);

  _db.run(`
    CREATE INDEX IF NOT EXISTS idx_patients_full_name
      ON patients(full_name);
  `);

  // NEW: patient_notes table to keep a history of notes per patient
  _db.run(`
    CREATE TABLE IF NOT EXISTS patient_notes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id  INTEGER NOT NULL,
      content     TEXT    NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
    );
  `);

  _db.run(`
    CREATE INDEX IF NOT EXISTS idx_patient_notes_patient_id
      ON patient_notes(patient_id);
  `);

  // === Migration: copy non-empty doctor_notes from daily_queue into patient_notes (idempotent) ===
  // This will copy existing notes (if any) into patient_notes but avoid duplicates using NOT EXISTS.
  _db.run(`
    INSERT INTO patient_notes (patient_id, content, created_at)
    SELECT dq.patient_id, dq.doctor_notes, dq.visit_date
    FROM daily_queue dq
    WHERE dq.doctor_notes IS NOT NULL AND TRIM(dq.doctor_notes) != ''
      AND NOT EXISTS (
        SELECT 1 FROM patient_notes pn
        WHERE pn.patient_id = dq.patient_id
          AND pn.content = dq.doctor_notes
          AND pn.created_at = dq.visit_date
      );
  `);

  // Persist schema immediately
  saveToFile();
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Initialize the database. Must be awaited once before getDb() is called.
 * @returns {Promise<typeof DbHandle>}
 */
async function initialize() {
  if (_db) return DbHandle; // Already initialized

  _sqlJs = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new _sqlJs.Database(fileBuffer);
    console.log(`[DB] Loaded existing database from: ${DB_PATH}`);
  } else {
    _db = new _sqlJs.Database();
    console.log(`[DB] Created new database at: ${DB_PATH}`);
  }

  runMigrations();
  startAutoSave();

  return DbHandle;
}

/**
 * Get the synchronous database handle. Throws if not yet initialized.
 * @returns {typeof DbHandle}
 */
function getDb() {
  if (!_db) {
    throw new Error('[DB] Database not initialized. Call initialize() first.');
  }
  return DbHandle;
}

module.exports = { initialize, getDb };