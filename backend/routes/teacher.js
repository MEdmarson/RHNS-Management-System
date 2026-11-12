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

  // 1. Calculate Totals
  const wwTotal = [ww1, ww2, ww3, ww4, ww5].reduce((a, b) => a + (Number(b) || 0), 0);
  const ptTotal = [pt1, pt2, pt3].reduce((a, b) => a + (Number(b) || 0), 0);
  const exTotal = [ex1, ex2, ex3].reduce((a, b) => a + (Number(b) || 0), 0);

  // 2. Calculate HPS Totals
  const wwHpsTotal = [ww1_hps, ww2_hps, ww3_hps, ww4_hps, ww5_hps].reduce((a, b) => a + (Number(b) || 0), 0) || 1;
  const ptHpsTotal = [pt1_hps, pt2_hps, pt3_hps].reduce((a, b) => a + (Number(b) || 0), 0) || 1;
  const exHpsTotal = [ex1_hps, ex2_hps, ex3_hps].reduce((a, b) => a + (Number(b) || 0), 0) || 1;

  // 3. Calculate PS (Percentage Score)
  const wwPs = (wwTotal / wwHpsTotal) * 100;
  const ptPs = (ptTotal / ptHpsTotal) * 100;
  const exPs = (exTotal / exHpsTotal) * 100;

  // 4. Calculate WS (Weighted Score) - Core Subjects: WW 20%, PT 50%, EX 30%
  const wwWs = wwPs * 0.20; 
  const ptWs = ptPs * 0.50; 
  const exWs = exPs * 0.30; 

  // 5. Calculate Initial Grade and Term Grade
  const initialGrade = wwWs + ptWs + exWs;
  const termGrade = Math.round(initialGrade);

  // 6. Calculate Descriptor
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

// GET final grades (average of all 3 terms per student)
router.get('/final-grades', async (req, res) => {
  const subjectId = req.query.subject;
  if (!subjectId) return res.status(400).json({ error: "Subject ID required" });

  try {
    // Pivot using g.term_grade (Column X), NOT g.initial_grade (Column W)
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
      
      // Get only the terms that have actual grades
      const present = [t1, t2, t3].filter(v => v !== null && v !== undefined);
      
      // Round the average exactly like Excel's =ROUND(AVERAGE(...),0)
      const final_grade = present.length 
        ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) 
        : null;

      // Use the same thresholds as the Term Grade descriptors in the ECR
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

// --- WARNINGS & SF2 ---
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

router.get('/sf2/:sectionId', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.lrn, u.full_name, 
             SUM(a.status = 'present') AS days_present, 
             SUM(a.status = 'late') AS days_late,
             SUM(a.status = 'excused') AS days_excused,
             SUM(a.status = 'absent') AS days_absent
      FROM users u 
      JOIN students s ON s.user_id = u.id
      LEFT JOIN attendance a ON a.student_id = u.id
      WHERE s.section_id = ? 
      GROUP BY u.id, s.lrn, u.full_name 
      ORDER BY u.full_name`, [req.params.sectionId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;