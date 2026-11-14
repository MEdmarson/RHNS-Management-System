// routes/classRecordExport.js
// GET /api/teacher/class-record/:subjectId/export?type=Core%20Subjects
//
// Downloads the class record by filling templates/class-record-template.xlsx (your real Excel file)
// with the data from the database. See utils/classRecordBuilder.js.
const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { buildClassRecord } = require('../utils/classRecordBuilder');

const router = express.Router();
router.use(authenticate, authorize('teacher'));

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'class-record-template.xlsx');
let templateCache = null;
const getTemplate = () => templateCache || (templateCache = fs.readFileSync(TEMPLATE_PATH));

async function fetchTermRows(teacherId, subjectId, term) {
  const [rows] = await pool.query(`
    SELECT u.id AS student_id, u.full_name, s.lrn, s.gender,
           g.ww1, g.ww2, g.ww3, g.ww4, g.ww5,
           g.pt1, g.pt2, g.pt3, g.ex1, g.ex2, g.ex3,
           g.ww1_hps, g.ww2_hps, g.ww3_hps, g.ww4_hps, g.ww5_hps,
           g.pt1_hps, g.pt2_hps, g.pt3_hps,
           g.ex1_hps, g.ex2_hps, g.ex3_hps
    FROM subjects sub
    JOIN sections sec ON sec.id = sub.section_id
    JOIN students s   ON s.section_id = sec.id
    JOIN users u      ON u.id = s.user_id
    LEFT JOIN grades g ON g.student_id = u.id AND g.subject_id = sub.id AND g.term = ?
    WHERE sub.teacher_id = ? AND sub.id = ?
    ORDER BY u.full_name
  `, [term, teacherId, subjectId]);
  return rows;
}

async function fetchMeta(teacherId, subjectId) {
  const [[meta]] = await pool.query(`
    SELECT sub.name AS subject_name, sec.name AS section, u.full_name AS teacher_name
    FROM subjects sub
    JOIN sections sec ON sec.id = sub.section_id
    JOIN users u      ON u.id = sub.teacher_id
    WHERE sub.teacher_id = ? AND sub.id = ?
  `, [teacherId, subjectId]);
  return meta;
}

router.get('/class-record/:subjectId/export', async (req, res) => {
  try {
    const subjectId = Number(req.params.subjectId);
    const meta = await fetchMeta(req.user.id, subjectId);
    if (!meta) return res.status(404).json({ error: 'Subject not found' });

    const termRows = {};
    for (const term of [1, 2, 3]) termRows[term] = await fetchTermRows(req.user.id, subjectId, term);

    const buffer = await buildClassRecord({
      templateBuf: getTemplate(),
      meta,
      subjectType: req.query.type || 'Core Subjects',
      termRows
    });

    const safe = (str) => String(str).replace(/[^a-z0-9]+/gi, '_');
    const fileName = `ClassRecord_${safe(meta.subject_name)}_${safe(meta.section)}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;