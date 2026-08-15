/**
 * patients.js - Patient Routes
 * REST API endpoints for managing the patient master list.
 *
 * Routes:
 *   GET    /api/patients        - List all patients (with optional search)
 *   GET    /api/patients/:id    - Get a single patient by ID
 *   POST   /api/patients        - Register a new patient
 *   PUT    /api/patients/:id    - Update patient demographics
 *   DELETE /api/patients/:id    - Delete a patient (cascades queue entries)
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../database');

// ─────────────────────────────────────────────
// GET /api/patients
// ─────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { q } = req.query;
    let patients;

    if (q && q.trim()) {
      const pattern = `%${q.trim()}%`;
      patients = db.query(
        `SELECT id, full_name, age, phone, created_at
         FROM patients
         WHERE full_name LIKE ? OR phone LIKE ?
         ORDER BY full_name ASC
         LIMIT 50`,
        [pattern, pattern]
      );
    } else {
      patients = db.query(
        `SELECT id, full_name, age, phone, created_at
         FROM patients
         ORDER BY full_name ASC`
      );
    }

    res.json({ success: true, data: patients });
  } catch (err) {
    console.error('[API] GET /patients error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch patients.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/patients/:id
// ─────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const patient = db.get(
      `SELECT id, full_name, age, phone, created_at FROM patients WHERE id = ?`,
      [req.params.id]
    );

    if (!patient) {
      return res.status(404).json({ success: false, error: 'Patient not found.' });
    }
    res.json({ success: true, data: patient });
  } catch (err) {
    console.error('[API] GET /patients/:id error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch patient.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/patients
// ─────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { full_name, age, phone } = req.body;

    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ success: false, error: 'full_name is required.' });
    }

    const result = db.run(
      `INSERT INTO patients (full_name, age, phone) VALUES (?, ?, ?)`,
      [
        full_name.trim(),
        age ? parseInt(age, 10) : null,
        phone ? String(phone).trim() : null,
      ]
    );

    const newPatient = db.get(
      `SELECT id, full_name, age, phone, created_at FROM patients WHERE id = ?`,
      [result.lastInsertRowid]
    );

    res.status(201).json({ success: true, data: newPatient });
  } catch (err) {
    console.error('[API] POST /patients error:', err);
    res.status(500).json({ success: false, error: 'Failed to create patient.' });
  }
});

// ─────────────────────────────────────────────
// PUT /api/patients/:id
// ─────────────────────────────────────────────
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const existing = db.get(
      `SELECT id FROM patients WHERE id = ?`,
      [req.params.id]
    );

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Patient not found.' });
    }

    const { full_name, age, phone } = req.body;
    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ success: false, error: 'full_name is required.' });
    }

    db.run(
      `UPDATE patients SET full_name = ?, age = ?, phone = ? WHERE id = ?`,
      [
        full_name.trim(),
        age ? parseInt(age, 10) : null,
        phone ? String(phone).trim() : null,
        req.params.id,
      ]
    );

    const updated = db.get(
      `SELECT id, full_name, age, phone, created_at FROM patients WHERE id = ?`,
      [req.params.id]
    );

    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[API] PUT /patients/:id error:', err);
    res.status(500).json({ success: false, error: 'Failed to update patient.' });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/patients/:id
// ─────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const existing = db.get(
      `SELECT id FROM patients WHERE id = ?`,
      [req.params.id]
    );

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Patient not found.' });
    }

    db.run(`DELETE FROM patients WHERE id = ?`, [req.params.id]);
    res.json({ success: true, message: 'Patient deleted.' });
  } catch (err) {
    console.error('[API] DELETE /patients/:id error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete patient.' });
  }
});

module.exports = router;
