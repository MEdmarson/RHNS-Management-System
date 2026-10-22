const router = require('express').Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('student'));

// SUBJECTS + grades (Formatted for Student Portal)
router.get('/subjects', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT sub.name AS subject, t.full_name AS teacher,
           g.term, g.term_grade
    FROM subjects sub
    JOIN students s ON s.section_id = sub.section_id
    JOIN users t ON t.id = sub.teacher_id
    LEFT JOIN grades g ON g.subject_id = sub.id AND g.student_id = ?
    WHERE s.user_id = ?`, [req.user.id, req.user.id]);
  res.json(rows);
});

// ATTENDANCE summary
router.get('/attendance', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT
      SUM(status='present') AS present,
      SUM(status='absent')  AS absent,
      SUM(status='late')    AS late
    FROM attendance WHERE student_id = ?`, [req.user.id]);
  res.json(rows[0] || { present: 0, absent: 0, late: 0 });
});

// NOTIFICATIONS
router.get('/notifications', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json(rows);
});

router.patch('/notifications/:id/read', async (req, res) => {
  await pool.query(
    'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id]
  );
  res.json({ ok: true });
});

module.exports = router;