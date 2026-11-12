const router = require('express').Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('teacher'));

// DepEd Transmutation Table
const TRANSMUTATION = [
  [99.49,100],[98.31,99],[97.13,98],[95.95,97],[94.77,96],[93.59,95],[92.41,94],[91.23,93],
  [90.05,92],[88.87,91],[87.69,90],[86.51,89],[85.33,88],[84.15,87],[82.97,86],[81.79,85],
  [80.61,84],[79.43,83],[78.25,82],[77.07,81],[75.89,80],[74.71,79],[73.53,78],[72.35,77],
  [71.17,76],[69.99,75],[65.33,74],[60.66,73],[56,72],[51.33,71],[46.66,70],[42,69],
  [37.33,68],[32.67,67],[28,66],[23.34,65],[18.67,64],[14,63],[9.34,62],[4.67,61],[0,60]
];

function transmute(initial) {
  for (const [min, grade] of TRANSMUTATION) {
    if (initial > min) return grade;
  }
  return 0;
}

// GET subjects assigned to this teacher
router.get('/my-subjects', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT sub.id, sub.name, sec.id AS section_id, sec.name AS section
    FROM subjects sub
    JOIN sections sec ON sec.id = sub.section_id
    WHERE sub.teacher_id = ?`, [req.user.id]);
  res.json(rows);
});

// GET students and grades for a specific subject and term
router.get('/gradebook', async (req, res) => {
  const term = req.query.term || 1; 
  const subjectId = req.query.subject;
  if (!subjectId) return res.status(400).json({ error: "Subject ID required" });

  const [rows] = await pool.query(`
    SELECT u.id AS student_id, u.full_name, s.lrn, sec.name AS section,
           sub.id AS subject_id, sub.name AS subject,
           g.id AS grade_id, g.ww1, g.ww2, g.ww3, g.ww4, g.ww5,
           g.pt1, g.pt2, g.pt3, g.ex1, g.ex2, g.ex3, 
           g.term_grade, g.initial_grade, g.descriptor,
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

// UPDATE grades
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

  const wwPs = (wwTotal / wwHpsTotal) * 100;
  const ptPs = (ptTotal / ptHpsTotal) * 100;
  const exPs = (exTotal / exHpsTotal) * 100;

  const wwWs = wwPs * 0.20; 
  const ptWs = ptPs * 0.50; 
  const exWs = exPs * 0.30; 

  const initialGrade = wwWs + ptWs + exWs;
  const termGrade = transmute(initialGrade);

  let descriptor = 'Emerging';
  if (termGrade > 89) descriptor = 'Advancing';
  else if (termGrade > 79) descriptor = 'Benchmarking';
  else if (termGrade > 74) descriptor = 'Connecting';
  else if (termGrade > 64) descriptor = 'Developing';

  try {
    await pool.query(`
      INSERT INTO grades (
        student_id, subject_id, term, 
        ww1, ww2, ww3, ww4, ww5, 
        pt1, pt2, pt3, 
        ex1, ex2, ex3, initial_grade, term_grade, descriptor,
        ww1_hps, ww2_hps, ww3_hps, ww4_hps, ww5_hps,
        pt1_hps, pt2_hps, pt3_hps,
        ex1_hps, ex2_hps, ex3_hps
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        ww1=VALUES(ww1), ww2=VALUES(ww2), ww3=VALUES(ww3), ww4=VALUES(ww4), ww5=VALUES(ww5),
        pt1=VALUES(pt1), pt2=VALUES(pt2), pt3=VALUES(pt3),
        ex1=VALUES(ex1), ex2=VALUES(ex2), ex3=VALUES(ex3),
        initial_grade=VALUES(initial_grade), term_grade=VALUES(term_grade), descriptor=VALUES(descriptor),
        ww1_hps=VALUES(ww1_hps), ww2_hps=VALUES(ww2_hps), ww3_hps=VALUES(ww3_hps), ww4_hps=VALUES(ww4_hps), ww5_hps=VALUES(ww5_hps),
        pt1_hps=VALUES(pt1_hps), pt2_hps=VALUES(pt2_hps), pt3_hps=VALUES(pt3_hps),
        ex1_hps=VALUES(ex1_hps), ex2_hps=VALUES(ex2_hps), ex3_hps=VALUES(ex3_hps)`,
      [student_id, subject_id, term, 
       ww1, ww2, ww3, ww4, ww5, 
       pt1, pt2, pt3, 
       ex1, ex2, ex3, initialGrade, termGrade, descriptor,
       ww1_hps, ww2_hps, ww3_hps, ww4_hps, ww5_hps,
       pt1_hps, pt2_hps, pt3_hps,
       ex1_hps, ex2_hps, ex3_hps]);

    res.json({ ok: true, termGrade });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET final grades
router.get('/final-grades', async (req, res) => {
  const subjectId = req.query.subject;
  if (!subjectId) return res.status(400).json({ error: "Subject ID required" });

  try {
    const [rows] = await pool.query(`
      SELECT u.id AS student_id, u.full_name,
             MAX(CASE WHEN g.term = 1 THEN g.term_grade END) AS term1,
             MAX(CASE WHEN g.term = 2 THEN g.term_grade END) AS term2,
             MAX(CASE WHEN g.term = 3 THEN g.term_grade END) AS term3
      FROM subjects sub
      JOIN sections sec ON sec.id = sub.section_id
      JOIN students s  ON s.section_id = sec.id
      JOIN users u     ON u.id = s.user_id
      LEFT JOIN grades g ON g.student_id = u.id AND g.subject_id = sub.id
      WHERE sub.teacher_id = ? AND sub.id = ?
      GROUP BY u.id, u.full_name
      ORDER BY u.full_name
    `, [req.user.id, subjectId]);

    const out = rows.map(r => {
      const t1 = r.term1 === null ? null : Number(r.term1);
      const t2 = r.term2 === null ? null : Number(r.term2);
      const t3 = r.term3 === null ? null : Number(r.term3);
      
      const present = [t1, t2, t3].filter(v => v !== null && v !== undefined);
      
      const final_grade = present.length 
        ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) 
        : null;

      let descriptor = '';
      if (final_grade !== null) {
        if (final_grade > 89)      descriptor = 'Advancing';
        else if (final_grade > 79) descriptor = 'Benchmarking';
        else if (final_grade > 74) descriptor = 'Connecting';
        else if (final_grade > 64) descriptor = 'Developing';
        else if (final_grade > 0)  descriptor = 'Emerging';
      }

      return {
        student_id: r.student_id,
        full_name: r.full_name,
        term1: r.term1,
        term2: r.term2,
        term3: r.term3,
        final_grade,
        descriptor
      };
    });

    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- ATTENDANCE ---
router.get('/attendance/:subjectId/:date', async (req, res) => {
  const { subjectId, date } = req.params;
  try {
    const [rows] = await pool.query(`
      SELECT u.id AS student_id, u.full_name, a.status,
             (SELECT COUNT(*) FROM attendance WHERE student_id = u.id AND status = 'present') AS days_present,
             (SELECT COUNT(*) FROM attendance WHERE student_id = u.id AND status = 'late') AS days_late,
             (SELECT COUNT(*) FROM attendance WHERE student_id = u.id AND status = 'excused') AS days_excused,
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
    console.error(err);
    res.status(500).json({ error: err.message }); 
  }
});

router.post('/attendance', async (req, res) => {
  const { student_id, section_id, date, status } = req.body;
  try {
    await pool.query(`
      INSERT INTO attendance (student_id, section_id, date, status, recorded_by)
      VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status)`,
      [student_id, section_id, date, status, req.user.id]);
    res.json({ ok: true });
  } catch (err) { 
    console.error(err);
    res.status(500).json({ error: err.message }); 
  }
});

router.get('/attendance-history/:subjectId', async (req, res) => {
  const { subjectId } = req.params;
  const { month, year } = req.query;
  try {
    const [rows] = await pool.query(`
      SELECT u.id AS student_id, u.full_name, a.date, a.status
      FROM subjects sub 
      JOIN students s ON s.section_id = sub.section_id
      JOIN users u ON u.id = s.user_id
      JOIN attendance a ON a.student_id = u.id AND a.section_id = sub.section_id
      WHERE sub.teacher_id = ? AND sub.id = ? AND MONTH(a.date) = ? AND YEAR(a.date) = ?
      ORDER BY u.full_name, a.date`, [req.user.id, subjectId, month, year]);
    res.json(rows);
  } catch (err) { 
    console.error(err);
    res.status(500).json({ error: err.message }); 
  }
});

// --- WARNINGS ---
router.get('/at-risk', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.full_name,
             ROUND(AVG(g.term_grade), 2) AS avg_grade,
             (SELECT COUNT(*) FROM attendance a WHERE a.student_id = u.id AND a.status = 'present') AS raw_present,
             (SELECT COUNT(*) FROM attendance a WHERE a.student_id = u.id AND a.status = 'late')    AS raw_late,
             (SELECT COUNT(*) FROM attendance a WHERE a.student_id = u.id AND a.status = 'excused') AS raw_excused,
             (SELECT COUNT(*) FROM attendance a WHERE a.student_id = u.id AND a.status = 'absent')  AS raw_absent
      FROM users u 
      JOIN students s ON s.user_id = u.id
      JOIN subjects sub ON sub.section_id = s.section_id AND sub.teacher_id = ?
      LEFT JOIN grades g ON g.student_id = u.id AND g.subject_id = sub.id
      GROUP BY u.id, u.full_name 
      HAVING (avg_grade < 75) 
          OR (raw_absent + FLOOR(raw_late / 3) > 4)`, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SF2 (UPDATED: monthly auto-generation + per-section security) ---
router.get('/sf2/:sectionId', async (req, res) => {
  try {
    const { sectionId } = req.params;
    const { month, year } = req.query;

    // Default to current month/year if not provided
    const now = new Date();
    const m = Number(month) || (now.getMonth() + 1);
    const y = Number(year)  || now.getFullYear();

    // 1. Verify the teacher actually handles this section
    const [authCheck] = await pool.query(`
      SELECT 1 FROM subjects sub
      WHERE sub.section_id = ? AND sub.teacher_id = ? LIMIT 1`,
      [sectionId, req.user.id]);

    if (!authCheck.length) {
      return res.status(403).json({ error: "Unauthorized access to this section's SF2" });
    }

    // 2. Fetch per-student attendance counts for the given month only.
    //    LEFT JOIN keeps students with zero records in the result.
    const [rows] = await pool.query(`
      SELECT s.lrn, u.full_name,
             COALESCE(SUM(a.status = 'present'), 0) AS days_present,
             COALESCE(SUM(a.status = 'late'),    0) AS days_late,
             COALESCE(SUM(a.status = 'excused'), 0) AS days_excused,
             COALESCE(SUM(a.status = 'absent'),  0) AS days_absent
      FROM users u
      JOIN students s ON s.user_id = u.id
      LEFT JOIN attendance a
             ON a.student_id = u.id
            AND a.section_id = s.section_id
            AND MONTH(a.date) = ?
            AND YEAR(a.date)  = ?
      WHERE s.section_id = ?
      GROUP BY u.id, s.lrn, u.full_name
      ORDER BY u.full_name`,
      [m, y, sectionId]);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;