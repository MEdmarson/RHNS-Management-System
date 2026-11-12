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

// GET students and grades
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

// UPDATE grades (Removed missing_requirements)
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
  const termGrade = Math.round(initialGrade);

  let descriptor = 'Emerging';
  if (termGrade > 89) descriptor = 'Advancing';
  else if (termGrade > 79) descriptor = 'Benchmarking';
  else if (termGrade > 74) descriptor = 'Connecting';
  else if (termGrade > 64) descriptor = 'Developing';

  try {
    await pool.query(`
      INSERT INTO grades (
        student_id, subject_id, term, ww1, ww2, ww3, ww4, ww5, pt1, pt2, pt3, ex1, ex2, ex3, initial_grade, term_grade, descriptor,
        ww1_hps, ww2_hps, ww3_hps, ww4_hps, ww5_hps, pt1_hps, pt2_hps, pt3_hps, ex1_hps, ex2_hps, ex3_hps
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        ww1=VALUES(ww1), ww2=VALUES(ww2), ww3=VALUES(ww3), ww4=VALUES(ww4), ww5=VALUES(ww5),
        pt1=VALUES(pt1), pt2=VALUES(pt2), pt3=VALUES(pt3), ex1=VALUES(ex1), ex2=VALUES(ex2), ex3=VALUES(ex3),
        initial_grade=VALUES(initial_grade), term_grade=VALUES(term_grade), descriptor=VALUES(descriptor),
        ww1_hps=VALUES(ww1_hps), ww2_hps=VALUES(ww2_hps), ww3_hps=VALUES(ww3_hps), ww4_hps=VALUES(ww4_hps), ww5_hps=VALUES(ww5_hps),
        pt1_hps=VALUES(pt1_hps), pt2_hps=VALUES(pt2_hps), pt3_hps=VALUES(pt3_hps), ex1_hps=VALUES(ex1_hps), ex2_hps=VALUES(ex2_hps), ex3_hps=VALUES(ex3_hps)`,
      [student_id, subject_id, term, ww1, ww2, ww3, ww4, ww5, pt1, pt2, pt3, ex1, ex2, ex3, initialGrade, termGrade, descriptor,
       ww1_hps, ww2_hps, ww3_hps, ww4_hps, ww5_hps, pt1_hps, pt2_hps, pt3_hps, ex1_hps, ex2_hps, ex3_hps]);

    res.json({ ok: true, termGrade });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      FROM subjects sub JOIN students s ON s.section_id = sub.section_id
      JOIN users u ON u.id = s.user_id
      LEFT JOIN attendance a ON a.student_id = u.id AND a.date = ? AND a.section_id = sub.section_id
      WHERE sub.teacher_id = ? AND sub.id = ?
      GROUP BY u.id, u.full_name, a.status ORDER BY u.full_name`, [date, req.user.id, subjectId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/attendance', async (req, res) => {
  const { student_id, section_id, date, status } = req.body;
  try {
    await pool.query(`
      INSERT INTO attendance (student_id, section_id, date, status, recorded_by)
      VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status)`,
      [student_id, section_id, date, status, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/attendance-history/:subjectId', async (req, res) => {
  const { subjectId } = req.params;
  const { month, year } = req.query;
  try {
    const [rows] = await pool.query(`
      SELECT u.id AS student_id, u.full_name, a.date, a.status
      FROM subjects sub JOIN students s ON s.section_id = sub.section_id
      JOIN users u ON u.id = s.user_id
      JOIN attendance a ON a.student_id = u.id AND a.section_id = sub.section_id
      WHERE sub.teacher_id = ? AND sub.id = ? AND MONTH(a.date) = ? AND YEAR(a.date) = ?
      ORDER BY u.full_name, a.date`, [req.user.id, subjectId, month, year]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- AT-RISK DASHBOARD WITH 50% THRESHOLD LOGIC ---
router.get('/at-risk', async (req, res) => {
  try {
    // 1. Get all students and their attendance data
    const [students] = await pool.query(`
      SELECT u.id AS student_id, u.full_name, sec.name AS section,
             SUM(a.status = 'absent') AS total_absences,
             SUM(a.status = 'late') AS total_lates,
             SUM(a.status = 'present') AS total_presents,
             COUNT(DISTINCT a.date) AS total_days_recorded
      FROM users u
      JOIN students s ON s.user_id = u.id
      JOIN sections sec ON sec.id = s.section_id
      JOIN subjects sub ON sub.section_id = sec.id AND sub.teacher_id = ?
      LEFT JOIN attendance a ON a.student_id = u.id
      GROUP BY u.id, u.full_name, sec.name`, [req.user.id]);

    // 2. Get all grade data for the teacher's subjects to compute 50% threshold
    const [gradesData] = await pool.query(`
      SELECT g.student_id, g.subject_id, g.term, 
             g.ww1, g.ww2, g.ww3, g.ww4, g.ww5,
             g.pt1, g.pt2, g.pt3, g.ex1, g.ex2, g.ex3,
             g.term_grade, s.section_id
      FROM grades g
      JOIN students s ON s.user_id = g.student_id
      JOIN subjects sub ON sub.id = g.subject_id AND sub.teacher_id = ?
    `, [req.user.id]);

    // Count total students per section
    const sectionStudentCounts = {};
    students.forEach(s => {
      sectionStudentCounts[s.section] = (sectionStudentCounts[s.section] || 0) + 1;
    });

    // Count how many students have a grade for each specific task per section/subject
    const taskCounts = {};
    gradesData.forEach(g => {
      const key = `${g.section_id}-${g.subject_id}-${g.term}`;
      if (!taskCounts[key]) {
        taskCounts[key] = { ww1: 0, ww2: 0, ww3: 0, ww4: 0, ww5: 0, pt1: 0, pt2: 0, pt3: 0, ex1: 0, ex2: 0, ex3: 0 };
      }
      ['ww1','ww2','ww3','ww4','ww5','pt1','pt2','pt3','ex1','ex2','ex3'].forEach(task => {
        if (g[task] !== null) taskCounts[key][task]++;
      });
    });

    const atRiskFailing = [];
    const atRiskDropping = [];

    students.forEach(student => {
      const absences = student.total_absences || 0;
      const lates = student.total_lates || 0;
      const daysRecorded = student.total_days_recorded || 1; 
      
      const convertedLates = Math.floor(lates / 3);
      const effectiveAbsences = absences + convertedLates;
      const attendanceRate = ((daysRecorded - effectiveAbsences) / daysRecorded) * 100;

      const failingFlags = [];
      const droppingFlags = [];

      // Get student's specific grades for this teacher's subjects
      const studentGrades = gradesData.filter(g => g.student_id === student.student_id);

      studentGrades.forEach(g => {
        const key = `${g.section_id}-${g.subject_id}-${g.term}`;
        const totalStudents = sectionStudentCounts[student.section] || 1;
        const counts = taskCounts[key] || {};
        const threshold = totalStudents * 0.5;

        // Check for missing tasks based on 50% threshold
        const tasks = ['ww1','ww2','ww3','ww4','ww5','pt1','pt2','pt3','ex1','ex2','ex3'];
        const missingTasks = tasks.filter(task => g[task] === null && counts[task] >= threshold);

        if (missingTasks.length > 0) {
          failingFlags.push(`Missing: ${missingTasks.join(', ').toUpperCase()}`);
        }

        // Check for INC (No TE grade when 50% have taken it)
        const teTask = 'ex3'; // Assuming TE is mapped to ex3
        if (g[teTask] === null && counts[teTask] >= threshold) {
          failingFlags.push(`INC (No TE)`);
        } else if (g.term_grade !== null && g.term_grade < 78) {
          failingFlags.push(`Low Avg (${g.term_grade})`);
        }
      });

      if (failingFlags.length > 0) {
        atRiskFailing.push({ ...student, reason: [...new Set(failingFlags)].join(' | ') });
      }
      
      if (effectiveAbsences >= 5) droppingFlags.push(`${effectiveAbsences} Absences`);
      if (attendanceRate < 85) droppingFlags.push(`Low Att. (${Math.round(attendanceRate)}%)`);
      
      if (droppingFlags.length > 0) {
        atRiskDropping.push({ ...student, reason: droppingFlags.join(' | ') });
      }
    });

    res.json({ failing: atRiskFailing, dropping: atRiskDropping });
  } catch (err) { 
    console.error(err);
    res.status(500).json({ error: err.message }); 
  }
});

// --- SF2 ---
router.get('/sf2/:sectionId', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.lrn, u.full_name, 
             SUM(a.status = 'present') AS days_present, 
             SUM(a.status = 'late') AS days_late,
             SUM(a.status = 'excused') AS days_excused,
             SUM(a.status = 'absent') AS days_absent
      FROM users u JOIN students s ON s.user_id = u.id
      LEFT JOIN attendance a ON a.student_id = u.id
      WHERE s.section_id = ? GROUP BY u.id, s.lrn, u.full_name ORDER BY u.full_name`, [req.params.sectionId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;