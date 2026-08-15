/**
 * queue.js - Daily Queue Routes
 * REST API endpoints for the daily patient queue.
 *
 * Routes:
 *   GET    /api/queue               - Get today's full queue (with patient info)
 *   GET    /api/queue/next-number   - Get the next queue number for today
 *   GET    /api/queue/:id           - Get a single queue entry
 *   POST   /api/queue               - Add a patient to today's queue
 *   PATCH  /api/queue/:id/status    - Update queue status
 *   PATCH  /api/queue/:id/notes     - Update doctor_notes (Doctor only)
 *   DELETE /api/queue/:id           - Remove a queue entry
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../database');

const VALID_STATUSES = ['Waiting', 'In Progress', 'Completed', 'Cancelled'];

// ─────────────────────────────────────────────
// SQL Fragments (reusable)
// ─────────────────────────────────────────────
const QUEUE_SELECT = `
  SELECT
    dq.id,
    dq.patient_id,
    dq.queue_number,
    dq.status,
    dq.doctor_notes,
    dq.visit_date,
    p.full_name,
    p.age,
    p.phone
  FROM daily_queue dq
  JOIN patients p ON dq.patient_id = p.id
`;

// ─────────────────────────────────────────────
// GET /api/queue
// ─────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const queue = db.query(
      `${QUEUE_SELECT}
       WHERE dq.visit_date = DATE('now')
       ORDER BY dq.queue_number ASC`
    );
    res.json({ success: true, data: queue });
  } catch (err) {
    console.error('[API] GET /queue error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch queue.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/queue/next-number  (must precede /:id)
// ─────────────────────────────────────────────
router.get('/next-number', (req, res) => {
  try {
    const db = getDb();
    const row = db.get(
      `SELECT COALESCE(MAX(queue_number), 0) + 1 AS next_num
       FROM daily_queue
       WHERE visit_date = DATE('now')`
    );
    res.json({ success: true, data: { next_number: row ? row.next_num : 1 } });
  } catch (err) {
    console.error('[API] GET /queue/next-number error:', err);
    res.status(500).json({ success: false, error: 'Failed to get next queue number.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/queue/:id
// ─────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const entry = db.get(
      `${QUEUE_SELECT} WHERE dq.id = ?`,
      [req.params.id]
    );
    if (!entry) {
      return res.status(404).json({ success: false, error: 'Queue entry not found.' });
    }
    res.json({ success: true, data: entry });
  } catch (err) {
    console.error('[API] GET /queue/:id error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch queue entry.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/queue  — Add patient to today's queue
// ─────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { patient_id } = req.body;

    if (!patient_id) {
      return res.status(400).json({ success: false, error: 'patient_id is required.' });
    }

    // Verify patient exists
    const patient = db.get(`SELECT id FROM patients WHERE id = ?`, [patient_id]);
    if (!patient) {
      return res.status(404).json({ success: false, error: 'Patient not found.' });
    }

    // Prevent duplicate active entry for today
    const duplicate = db.get(
      `SELECT id FROM daily_queue
       WHERE patient_id = ?
         AND visit_date = DATE('now')
         AND status NOT IN ('Completed', 'Cancelled')
       LIMIT 1`,
      [patient_id]
    );
    if (duplicate) {
      return res.status(409).json({
        success: false,
        error: 'Patient already has an active queue entry for today.',
      });
    }

    // Determine next queue number
    const numRow = db.get(
      `SELECT COALESCE(MAX(queue_number), 0) + 1 AS next_num
       FROM daily_queue WHERE visit_date = DATE('now')`
    );
    const queueNumber = numRow ? numRow.next_num : 1;

    const result = db.run(
      `INSERT INTO daily_queue (patient_id, queue_number, status) VALUES (?, ?, 'Waiting')`,
      [patient_id, queueNumber]
    );

    const entry = db.get(
      `${QUEUE_SELECT} WHERE dq.id = ?`,
      [result.lastInsertRowid]
    );

    res.status(201).json({ success: true, data: entry });
  } catch (err) {
    console.error('[API] POST /queue error:', err);
    res.status(500).json({ success: false, error: 'Failed to add patient to queue.' });
  }
});

// ─────────────────────────────────────────────
// PATCH /api/queue/:id/status
// ─────────────────────────────────────────────
router.patch('/:id/status', (req, res) => {
  try {
    const db = getDb();
    const { status } = req.body;

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `status must be one of: ${VALID_STATUSES.join(', ')}.`,
      });
    }

    const existing = db.get(
      `${QUEUE_SELECT} WHERE dq.id = ?`,
      [req.params.id]
    );
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Queue entry not found.' });
    }

    db.run(
      `UPDATE daily_queue SET status = ? WHERE id = ?`,
      [status, req.params.id]
    );

    const updated = db.get(`${QUEUE_SELECT} WHERE dq.id = ?`, [req.params.id]);
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[API] PATCH /queue/:id/status error:', err);
    res.status(500).json({ success: false, error: 'Failed to update status.' });
  }
});

// ─────────────────────────────────────────────
// PATCH /api/queue/:id/notes  (Doctor-only)
// ─────────────────────────────────────────────
router.patch('/:id/notes', (req, res) => {
  try {
    const db = getDb();
    const { doctor_notes } = req.body;

    if (doctor_notes === undefined || doctor_notes === null) {
      return res.status(400).json({ success: false, error: 'doctor_notes field is required.' });
    }

    const existing = db.get(
      `${QUEUE_SELECT} WHERE dq.id = ?`,
      [req.params.id]
    );
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Queue entry not found.' });
    }

    db.run(
      `UPDATE daily_queue SET doctor_notes = ? WHERE id = ?`,
      [String(doctor_notes), req.params.id]
    );

    const updated = db.get(`${QUEUE_SELECT} WHERE dq.id = ?`, [req.params.id]);
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[API] PATCH /queue/:id/notes error:', err);
    res.status(500).json({ success: false, error: 'Failed to update notes.' });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/queue/:id
// ─────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const existing = db.get(
      `${QUEUE_SELECT} WHERE dq.id = ?`,
      [req.params.id]
    );
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Queue entry not found.' });
    }

    db.run(`DELETE FROM daily_queue WHERE id = ?`, [req.params.id]);
    res.json({ success: true, message: 'Queue entry removed.' });
  } catch (err) {
    console.error('[API] DELETE /queue/:id error:', err);
    res.status(500).json({ success: false, error: 'Failed to remove queue entry.' });
  }
});

module.exports = router;
