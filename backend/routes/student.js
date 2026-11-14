const router = require('express').Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('student'));

// SUBJECTS + grades (Active + Past)
router.get('/subjects', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT sub.id AS subject_id, 
             sub.name AS subject, 
             t.full_name AS teacher,
             MAX(CASE WHEN g.term = 1 THEN g.term_grade END) AS term1,
             MAX(CASE WHEN g.term = 2 THEN g.term_grade END) AS term2,
             MAX(CASE WHEN g.term = 3 THEN g.term_grade END) AS term3,
             MAX(g.missing_requirements) AS missing_requirements
      FROM subjects sub
      JOIN students s ON s.section_id = sub.section_id
      JOIN users t ON t.id = sub.teacher_id
      LEFT JOIN grades g ON g.subject_id = sub.id AND g.student_id = ?
      WHERE s.user_id = ?
      GROUP BY sub.id, sub.name, t.full_name
    `, [req.user.id, req.user.id]);
    
    const out = rows.map(r => {
      const present = [r.term1, r.term2, r.term3].filter(v => v !== null && v > 0);
      const avg = present.length ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : null;
      
      // If there is a Term 3 grade, we assume the subject is completed.
      // Otherwise, it is still "In Progress".
      const isCompleted = r.term3 !== null && r.term3 > 0;
      
      let status = 'In Progress';
      if (isCompleted) {
        status = avg >= 75 ? 'Passed' : 'Failed';
      }

      return {
        subject_id: r.subject_id,
        subject: r.subject,
        teacher: r.teacher,
        grade_level: 11, // Hardcoded fallback, or pull from students table if needed
        term1: r.term1,
        term2: r.term2,
        term3: r.term3,
        term_grade: avg,
        status: status,
        is_active: !isCompleted, // Active if no Term 3 grade yet
        missing_requirements: r.missing_requirements
      };
    });

    res.json(out);
  } catch (err) {
    console.error("Student Subjects Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET SUBJECT DETAILS (For the Modal)
router.get('/subjects/:subjectId/details', async (req, res) => {
  const { subjectId } = req.params;
  try {
    const [authCheck] = await pool.query(`
      SELECT 1 FROM subjects sub
      JOIN students s ON s.section_id = sub.section_id
      WHERE sub.id = ? AND s.user_id = ?
    `, [subjectId, req.user.id]);

    if (!authCheck.length) return res.status(403).json({ error: 'Unauthorized' });

    const [grades] = await pool.query(`
      SELECT term, ww1, ww2, ww3, ww4, ww5, pt1, pt2, pt3, ex1, ex2, ex3, 
             initial_grade, term_grade, descriptor
      FROM grades WHERE subject_id = ? AND student_id = ?
      ORDER BY term ASC
    `, [subjectId, req.user.id]);

    res.json(grades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ATTENDANCE summary
router.get('/attendance', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        COALESCE(SUM(status='present'), 0) AS present,
        COALESCE(SUM(status='absent'), 0)  AS absent,
        COALESCE(SUM(status='late'), 0)    AS late
      FROM attendance WHERE student_id = ?`, [req.user.id]);
    res.json(rows[0] || { present: 0, absent: 0, late: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NOTIFICATIONS
router.get('/notifications', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;