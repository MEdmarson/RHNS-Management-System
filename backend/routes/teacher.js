const router = require('express').Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('teacher'));

// GET subjects assigned to this teacher
router.get('/my-subjects', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT sub.id, sub.name, sec.id AS section_id, sec.name AS section
    FROM subjects sub
    JOIN sections sec ON sec.id = sub.section_id
    WHERE sub.teacher_id = ?`, [req.user.id]);
  res.json(rows);
});

// --- CLASS RECORD ROUTES ---
router.get('/gradebook', async (req, res) => {
  const term = req.query.term || 1; 
  const subjectId = req.query.subject;
  if (!subjectId) return res.status(400).json({ error: "Subject ID required" });

  const [rows] = await pool.query(`
    SELECT u.id AS student_id, u.full_name, s.lrn, sec.name AS section,
           sub.id AS subject_id, sub.name AS subject,
           g.id AS grade_id, g.ww1, g.ww2, g.ww3, g.ww4, g.ww5,
           g.pt1, g.pt2, g.pt3, g.ex1, g.ex2, g.ex3, g.term_grade,
           g.ww1_hps, g.ww2_hps, g.ww3_hps, g.ww4_hps, g.ww5_hps,
           g.pt1_hps, g.pt2_hps, g.pt3_hps,
           g.ex1_hps, g.ex2_hps, g.ex3_hps
    FROM subjects sub
    JOIN sections sec ON sec.id = sub.section_id
    JOIN students s ON s.section_id = sec.id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN grades g ON g.student_id = u.id AND g.subject_id = sub.id AND g.term = ?
    WHERE sub.teacher_id = ? AND sub.id = ?
    ORDER BY u.full_name`, [term, req.user.id, subjectId]);
  res.json(rows);
});

router.post('/grades', async (req, res) => {
  const { 
    student_id, subject_id, term, 
    ww1, ww2, ww3, ww4, ww5, 
    pt1, pt2, pt3, 
    ex1, ex2, ex3,
    ww1_hps, ww2_hps, ww3_hps, ww4_hps, ww5_hps,
    pt1_hps, pt2_hps, pt3_hps,
    ex1_hps, ex2_hps, ex3_hps
  } = req.body;

  const wwTotal = [ww1, ww2, ww3, ww4, ww5].reduce((a, b) => a + (Number(b) || 0), 0);
  const ptTotal = [pt1, pt2, pt3].reduce((a, b) => a + (Number(b) || 0), 0);
  const exTotal = [ex1, ex2, ex3].reduce((a, b) => a + (Number(b) || 0), 0);

  const wwHpsTotal = [ww1_hps, ww2_hps, ww3_hps, ww4_hps, ww5_hps].reduce((a, b) => a + (Number(b) || 0), 0) || 1;
  const ptHpsTotal = [pt1_hps, pt2_hps, pt3_hps].reduce((a, b) => a + (Number(b) || 0), 0) || 1;
  const exHpsTotal = [ex1_hps, ex2_hps, ex3_hps].reduce((a, b) => a + (Number(b) || 0), 0) || 1;

  const wwPercent = (wwTotal / wwHpsTotal) * 100;
  const ptPercent = (ptTotal / ptHpsTotal) * 100;
  const exPercent = (exTotal / exHpsTotal) * 100;

  const wwScore = wwPercent * 0.20; 
  const ptScore = ptPercent * 0.50; 
  const exScore = exPercent * 0.30; 
  const termGrade = Math.round(wwScore + ptScore + exScore);

  try {
    await pool.query(`
      INSERT INTO grades (
        student_id, subject_id, term, 
        ww1, ww2, ww3, ww4, ww5, 
        pt1, pt2, pt3, 
        ex1, ex2, ex3, term_grade,
        ww1_hps, ww2_hps, ww3_hps, ww4_hps, ww5_hps,
        pt1_hps, pt2_hps, pt3_hps,
        ex1_hps, ex2_hps, ex3_hps
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        ww1=VALUES(ww1), ww2=VALUES(ww2), ww3=VALUES(ww3), ww4=VALUES(ww4), ww5=VALUES(ww5),
        pt1=VALUES(pt1), pt2=VALUES(pt2), pt3=VALUES(pt3),
        ex1=VALUES(ex1), ex2=VALUES(ex2), ex3=VALUES(ex3),
        term_grade=VALUES(term_grade),
        ww1_hps=VALUES(ww1_hps), ww2_hps=VALUES(ww2_hps), ww3_hps=VALUES(ww3_hps), ww4_hps=VALUES(ww4_hps), ww5_hps=VALUES(ww5_hps),
        pt1_hps=VALUES(pt1_hps), pt2_hps=VALUES(pt2_hps), pt3_hps=VALUES(pt3_hps),
        ex1_hps=VALUES(ex1_hps), ex2_hps=VALUES(ex2_hps), ex3_hps=VALUES(ex3_hps)`,
      [student_id, subject_id, term, 
       ww1, ww2, ww3, ww4, ww5, 
       pt1, pt2, pt3, 
       ex1, ex2, ex3, termGrade,
       ww1_hps, ww2_hps, ww3_hps, ww4_hps, ww5_hps,
       pt1_hps, pt2_hps, pt3_hps,
       ex1_hps, ex2_hps, ex3_hps]);

    res.json({ ok: true, termGrade });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- ATTENDANCE ROUTES ---
router.get('/attendance/:subjectId/:date', async (req, res) => {
  const { subjectId, date } = req.params;
  
  try {
    const [rows] = await pool.query(`
      SELECT u.id AS student_id, u.full_name, 
             a.status,
             (SELECT COUNT(*) FROM attendance WHERE student_id = u.id AND status = 'present') AS days_present,
             (SELECT COUNT(*) FROM attendance WHERE student_id = u.id AND status = 'absent') AS days_absent
      FROM subjects sub
      JOIN students s ON s.section_id = sub.section_id
      JOIN users u ON u.id = s.user_id
      LEFT JOIN attendance a ON a.student_id = u.id AND a.date = ? AND a.section_id = sub.section_id
      WHERE sub.teacher_id = ? AND sub.id = ?
      GROUP BY u.id, u.full_name, a.status
      ORDER BY u.full_name`, [date, req.user.id, subjectId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/attendance', async (req, res) => {
  const { student_id, section_id, date, status } = req.body;
  try {
    await pool.query(`
      INSERT INTO attendance (student_id, section_id, date, status, recorded_by)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE status = VALUES(status)`,
      [student_id, section_id, date, status, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET monthly attendance records (NEW ROUTE)
router.get('/attendance-history/:subjectId', async (req, res) => {
  const { subjectId } = req.params;
  const { month, year } = req.query;

  try {
    const [rows] = await pool.query(`
      SELECT u.id AS student_id, u.full_name, 
             a.date, a.status
      FROM subjects sub
      JOIN students s ON s.section_id = sub.section_id
      JOIN users u ON u.id = s.user_id
      JOIN attendance a ON a.student_id = u.id AND a.section_id = sub.section_id
      WHERE sub.teacher_id = ? AND sub.id = ? 
      AND MONTH(a.date) = ? AND YEAR(a.date) = ?
      ORDER BY u.full_name, a.date`, 
      [req.user.id, subjectId, month, year]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- WARNINGS & SF2 ---
router.get('/at-risk', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT u.id, u.full_name,
           ROUND(AVG(g.term_grade), 2) AS avg_grade,
           (SELECT COUNT(*) FROM attendance a
            WHERE a.student_id = u.id AND a.status = 'absent') AS absences
    FROM users u
    JOIN students s ON s.user_id = u.id
    JOIN subjects sub ON sub.section_id = s.section_id AND sub.teacher_id = ?
    LEFT JOIN grades g ON g.student_id = u.id AND g.subject_id = sub.id
    GROUP BY u.id, u.full_name
    HAVING avg_grade < 75 OR absences > 4`, [req.user.id]);
  res.json(rows);
});

router.get('/sf2/:sectionId', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT s.lrn, u.full_name,
           SUM(a.status = 'present') AS days_present,
           SUM(a.status = 'absent')  AS days_absent
    FROM users u
    JOIN students s ON s.user_id = u.id
    LEFT JOIN attendance a ON a.student_id = u.id
    WHERE s.section_id = ?
    GROUP BY u.id, s.lrn, u.full_name
    ORDER BY u.full_name`, [req.params.sectionId]);
  res.json(rows);
});

module.exports = router;