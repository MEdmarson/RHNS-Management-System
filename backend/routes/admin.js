const router = require('express').Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('admin'));

// MACRO DASHBOARD
router.get('/dashboard', async (req, res) => {
  const [[{ total_students }]] = await pool.query(
    `SELECT COUNT(*) AS total_students FROM users WHERE role='student'`
  );
  const [[{ avg_grade }]] = await pool.query(
    `SELECT ROUND(AVG(term_grade),2) AS avg_grade FROM grades`
  );
  const [[{ at_risk }]] = await pool.query(`
    SELECT COUNT(*) AS at_risk FROM (
      SELECT g.student_id
      FROM grades g
      LEFT JOIN attendance a ON a.student_id = g.student_id AND a.status='absent'
      GROUP BY g.student_id
      HAVING AVG(g.term_grade) < 75 OR COUNT(a.id) > 4
    ) t`);
  res.json({ total_students, avg_grade, at_risk });
});

// ALL AT-RISK SCHOOL-WIDE
router.get('/at-risk', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT u.full_name, sec.name AS section,
           ROUND(AVG(g.term_grade),2) AS avg_grade,
           (SELECT COUNT(*) FROM attendance a
            WHERE a.student_id = u.id AND a.status='absent') AS absences
    FROM users u
    JOIN students s ON s.user_id = u.id
    LEFT JOIN sections sec ON sec.id = s.section_id
    LEFT JOIN grades g ON g.student_id = u.id
    GROUP BY u.id, u.full_name, sec.name
    HAVING avg_grade < 75 OR absences > 4`);
  res.json(rows);
});

// TEACHER COMPLIANCE
router.get('/compliance', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT u.full_name AS teacher,
           MAX(g.updated_at) AS last_update,
           DATEDIFF(NOW(), MAX(g.updated_at)) AS days_ago
    FROM users u
    LEFT JOIN subjects sub ON sub.teacher_id = u.id
    LEFT JOIN grades g ON g.subject_id = sub.id
    WHERE u.role = 'teacher'
    GROUP BY u.id, u.full_name`);
  res.json(rows);
});

// CSV EXPORT — all students & grades
router.get('/export', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT s.lrn, u.full_name, sec.name AS section, sub.name AS subject,
           g.term, g.term_grade
    FROM users u
    JOIN students s ON s.user_id = u.id
    LEFT JOIN sections sec ON sec.id = s.section_id
    LEFT JOIN grades g ON g.student_id = u.id
    LEFT JOIN subjects sub ON sub.id = g.subject_id
    ORDER BY u.full_name`);
  res.json(rows);
});

module.exports = router;

