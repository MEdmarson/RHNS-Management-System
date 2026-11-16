const router = require('express').Router();
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const { authenticate, authorize } = require('../middleware/auth');
const risk = require('./atRisk');   // same at-risk rules as the teacher and student portals

router.use(authenticate, authorize('admin'));

// ==========================================
// 1. DASHBOARD & ANALYTICS
// ==========================================
// Shared helpers. The at-risk rules live in routes/atRisk.js - the same file the teacher and student
// portals use - so the admin numbers always agree with what teachers and students see.

const envNum = (name, fallback) => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) ? v : fallback;
};

// Teacher compliance: days since the teacher last saved a grade in any ACTIVE subject.
// Change the numbers here, or set them in .env / Render Environment.
const COMPLIANCE = {
  OK_DAYS:   envNum('COMPLIANCE_OK_DAYS', 14),     // updated within this many days  = On track
  LATE_DAYS: envNum('COMPLIANCE_LATE_DAYS', 30)    // updated within this many days  = Behind (older or never = Overdue)
};

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const avgOf = (total, n) => (n > 0 ? Math.round((total / n) * 10) / 10 : null);

// Every flagged student in the school (failing, missing work, or too many absences).
async function computeAtRisk() {
  const [subjects] = await pool.query(`SELECT id, name, subject_type, section_id FROM subjects WHERE status = 'active'`);
  const [students] = await pool.query(`
    SELECT u.id AS student_id, u.full_name, s.lrn, s.grade_level, s.section_id, sec.name AS section
    FROM students s
    JOIN users u ON u.id = s.user_id
    JOIN sections sec ON sec.id = s.section_id
    ORDER BY u.full_name`);
  const [gradeRows] = await pool.query(`
    SELECT g.* FROM grades g JOIN subjects sub ON sub.id = g.subject_id WHERE sub.status = 'active'`);
  const [attRows] = await pool.query(`
    SELECT DISTINCT a.student_id, a.date, a.status
    FROM attendance a
    JOIN students s ON s.user_id = a.student_id AND s.section_id = a.section_id
    WHERE a.date >= DATE_SUB(CURDATE(), INTERVAL ${risk.AT_RISK.WINDOW_DAYS} DAY)
    ORDER BY a.student_id, a.date`);

  // subject -> term -> student -> grade row   (the shape atRisk.js expects)
  const bySubject = {};
  const gradeAcc = {};
  for (const g of gradeRows) {
    if (!bySubject[g.subject_id]) bySubject[g.subject_id] = {};
    if (!bySubject[g.subject_id][g.term]) bySubject[g.subject_id][g.term] = {};
    bySubject[g.subject_id][g.term][g.student_id] = g;
    if (Number(g.term_grade) > 0) {
      const a = gradeAcc[g.student_id] || (gradeAcc[g.student_id] = { sum: 0, n: 0 });
      a.sum += Number(g.term_grade); a.n++;
    }
  }
  const subjectsBySection = {};
  for (const sub of subjects) (subjectsBySection[sub.section_id] || (subjectsBySection[sub.section_id] = [])).push(sub);

  const attByStudent = {};
  let attended = 0, counted = 0;
  for (const a of attRows) {
    (attByStudent[a.student_id] || (attByStudent[a.student_id] = [])).push(a);
    if (a.status === 'present' || a.status === 'late') attended++;
    if (a.status === 'present' || a.status === 'late' || a.status === 'absent') counted++;
  }

  const result = [];
  for (const st of students) {
    const failing = [];
    for (const sub of (subjectsBySection[st.section_id] || [])) {
      const entry = risk.evaluateSubject(sub, bySubject[sub.id] || {}, st.student_id, risk.weightsFor(sub.subject_type));
      if (entry) failing.push(entry);
    }
    const recs = attByStudent[st.student_id] || [];
    const dropping = risk.evaluateAttendance(recs);
    if (!failing.length && !dropping) continue;

    const causes = [];
    if (failing.some(f => f.low_grade)) causes.push('grades');
    if (failing.some(f => f.missing && f.missing.significant)) causes.push('missing');
    if (dropping) causes.push('attendance');

    const reasons = failing.map(f => {
      const n = f.missing ? f.missing.count : 0;
      const missed = `${n} missed ${n === 1 ? 'activity' : 'activities'}`;
      if (f.cause === 'both') return `${f.subject}: grade ${f.term_grade}, ${missed}`;
      if (f.cause === 'scores') return `${f.subject}: grade ${f.term_grade}`;
      return `${f.subject}: ${missed}`;
    });
    if (dropping) reasons.push(`${dropping.effective_absences} absences in the last ${dropping.window_days} days`);

    const absent = recs.filter(r => r.status === 'absent').length;
    const late = recs.filter(r => r.status === 'late').length;
    const acc = gradeAcc[st.student_id];

    result.push({
      id: st.student_id,                                   // old field names are kept so the At-Risk tab keeps working
      student_id: st.student_id, full_name: st.full_name, lrn: st.lrn,
      grade_level: st.grade_level, section_id: st.section_id, section: st.section,
      avg_grade: acc ? Math.round((acc.sum / acc.n) * 100) / 100 : null,
      absences: dropping ? dropping.effective_absences : absent + Math.floor(late / risk.AT_RISK.LATES_PER_ABSENCE),
      severity: risk.severityOf(failing, dropping),
      causes, reasons,
      worst_grade: failing.length ? Math.min(...failing.map(f => (f.term_grade === null ? 100 : f.term_grade))) : null
    });
  }

  result.sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1) ||
    ((a.worst_grade ?? 101) - (b.worst_grade ?? 101)) ||
    (b.absences - a.absences));

  return { students: result, attendance: { attended, counted } };
}

function complianceStatus(r) {
  if (!r.active_subjects) return 'no_subjects';
  if (r.days_ago === null || r.days_ago === undefined) return 'overdue';           // has subjects, never saved a grade
  if (r.days_ago <= COMPLIANCE.OK_DAYS) return 'on_track';
  if (r.days_ago <= COMPLIANCE.LATE_DAYS) return 'behind';
  return 'overdue';
}

// One row per teacher: when they last saved grades and last recorded attendance.
async function computeCompliance() {
  const [teachers] = await pool.query(`
    SELECT u.id AS teacher_id, u.full_name AS teacher,
           COUNT(DISTINCT CASE WHEN sub.status = 'active' THEN sub.id END) AS active_subjects,
           MAX(CASE WHEN sub.status = 'active' THEN g.updated_at END) AS last_update,
           DATEDIFF(NOW(), MAX(CASE WHEN sub.status = 'active' THEN g.updated_at END)) AS days_ago
    FROM users u
    LEFT JOIN subjects sub ON sub.teacher_id = u.id
    LEFT JOIN grades g ON g.subject_id = sub.id
    WHERE u.role = 'teacher'
    GROUP BY u.id, u.full_name
    ORDER BY u.full_name`);
  const [att] = await pool.query(`
    SELECT recorded_by AS teacher_id, MAX(recorded_at) AS last_attendance,
           DATEDIFF(NOW(), MAX(recorded_at)) AS attendance_days_ago
    FROM attendance WHERE recorded_by IS NOT NULL GROUP BY recorded_by`);
  const attBy = {};
  for (const a of att) attBy[a.teacher_id] = a;

  const order = { overdue: 0, behind: 1, on_track: 2, no_subjects: 3 };
  return teachers.map(t => {
    const a = attBy[t.teacher_id];
    const row = {
      teacher_id: t.teacher_id, teacher: t.teacher,
      active_subjects: Number(t.active_subjects) || 0,
      last_update: t.last_update,
      days_ago: t.days_ago === null || t.days_ago === undefined ? null : Number(t.days_ago),
      last_attendance: a ? a.last_attendance : null,
      attendance_days_ago: a && a.attendance_days_ago !== null ? Number(a.attendance_days_ago) : null
    };
    row.status = complianceStatus(row);
    return row;
  }).sort((x, y) => (order[x.status] - order[y.status]) || ((y.days_ago ?? 9999) - (x.days_ago ?? 9999)));
}

// ---- The admin dashboard (one request, everything it needs) ----
router.get('/overview', async (req, res) => {
  try {
    const PASS = risk.AT_RISK.PASSING_GRADE;
    const [atRisk, compliance] = await Promise.all([computeAtRisk(), computeCompliance()]);

    const [[counts]] = await pool.query(`
      SELECT (SELECT COUNT(*) FROM users WHERE role = 'student') AS students,
             (SELECT COUNT(*) FROM users WHERE role = 'teacher') AS teachers,
             (SELECT COUNT(*) FROM sections) AS sections,
             (SELECT COUNT(*) FROM subjects WHERE status = 'active') AS active_subjects`);
    const [levels] = await pool.query(`SELECT grade_level, COUNT(*) AS students FROM students GROUP BY grade_level ORDER BY grade_level`);

    // "Current term" = the latest term in which any grade has been recorded
    const [[tt]] = await pool.query(`SELECT MAX(term) AS t FROM grades WHERE term_grade > 0`);
    const currentTerm = tt && tt.t ? Number(tt.t) : null;

    let termRows = [], sectionRows = [], dist = null;
    if (currentTerm) {
      const [lt] = await pool.query(`
        SELECT s.grade_level, g.term, COUNT(*) AS n, SUM(g.term_grade) AS total, SUM(g.term_grade >= ?) AS passing
        FROM grades g JOIN students s ON s.user_id = g.student_id
        WHERE g.term_grade > 0 GROUP BY s.grade_level, g.term`, [PASS]);
      termRows = lt.map(r => ({ grade_level: Number(r.grade_level), term: Number(r.term), n: Number(r.n), total: Number(r.total), passing: Number(r.passing) }));

      const [sr] = await pool.query(`
        SELECT sec.id AS section_id, sec.name AS section, MAX(s.grade_level) AS grade_level,
               COUNT(DISTINCT s.user_id) AS students, COUNT(*) AS n, SUM(g.term_grade) AS total, SUM(g.term_grade >= ?) AS passing
        FROM grades g JOIN students s ON s.user_id = g.student_id JOIN sections sec ON sec.id = s.section_id
        WHERE g.term_grade > 0 AND g.term = ? GROUP BY sec.id, sec.name`, [PASS, currentTerm]);
      sectionRows = sr;

      const [[d]] = await pool.query(`
        SELECT SUM(term_grade >= 90) AS outstanding,
               SUM(term_grade >= 85 AND term_grade < 90) AS very_satisfactory,
               SUM(term_grade >= 80 AND term_grade < 85) AS satisfactory,
               SUM(term_grade >= 75 AND term_grade < 80) AS fairly_satisfactory,
               SUM(term_grade < 75) AS did_not_meet
        FROM grades WHERE term_grade > 0 AND term = ?`, [currentTerm]);
      dist = [
        { label: 'Outstanding (90–100)', key: 'outstanding', count: Number(d.outstanding) || 0 },
        { label: 'Very Satisfactory (85–89)', key: 'very_satisfactory', count: Number(d.very_satisfactory) || 0 },
        { label: 'Satisfactory (80–84)', key: 'satisfactory', count: Number(d.satisfactory) || 0 },
        { label: 'Fairly Satisfactory (75–79)', key: 'fairly_satisfactory', count: Number(d.fairly_satisfactory) || 0 },
        { label: 'Did Not Meet (below 75)', key: 'did_not_meet', count: Number(d.did_not_meet) || 0 }
      ];
    }

    // ---- macro progress ----
    const cur = termRows.filter(r => r.term === currentTerm);
    const curN = cur.reduce((s, r) => s + r.n, 0);
    const curTotal = cur.reduce((s, r) => s + r.total, 0);
    const curPass = cur.reduce((s, r) => s + r.passing, 0);

    const byTerm = [...new Set(termRows.map(r => r.term))].sort((a, b) => a - b).map(t => {
      const rows = termRows.filter(r => r.term === t);
      return { term: t, avg_grade: avgOf(rows.reduce((s, r) => s + r.total, 0), rows.reduce((s, r) => s + r.n, 0)) };
    });

    const flagged = atRisk.students;
    const byLevel = levels.map(l => {
      const lvl = Number(l.grade_level);
      const c = cur.find(r => r.grade_level === lvl);
      const f = flagged.filter(s => Number(s.grade_level) === lvl);
      return {
        grade_level: lvl, students: Number(l.students),
        avg_grade: c ? avgOf(c.total, c.n) : null,
        pass_rate: c ? pct(c.passing, c.n) : null,
        at_risk: f.length,
        high: f.filter(s => s.severity === 'high').length,
        medium: f.filter(s => s.severity !== 'high').length
      };
    });

    const bySection = sectionRows.map(r => ({
      section_id: r.section_id, section: r.section, grade_level: Number(r.grade_level), students: Number(r.students),
      avg_grade: avgOf(Number(r.total), Number(r.n)), pass_rate: pct(Number(r.passing), Number(r.n))
    })).sort((a, b) => (a.avg_grade ?? 999) - (b.avg_grade ?? 999));

    // ---- compliance summary ----
    const tally = { on_track: 0, behind: 0, overdue: 0, no_subjects: 0 };
    for (const t of compliance) tally[t.status]++;
    const expected = compliance.length - tally.no_subjects;

    res.json({
      generated_at: new Date().toISOString(),
      settings: {
        passing_grade: PASS, window_days: risk.AT_RISK.WINDOW_DAYS, absence_limit: risk.AT_RISK.ABSENCE_LIMIT,
        compliance_ok_days: COMPLIANCE.OK_DAYS, compliance_late_days: COMPLIANCE.LATE_DAYS
      },
      kpis: {
        students: Number(counts.students), teachers: Number(counts.teachers),
        sections: Number(counts.sections), active_subjects: Number(counts.active_subjects),
        current_term: currentTerm,
        school_avg: avgOf(curTotal, curN),
        pass_rate: pct(curPass, curN),
        attendance_rate: pct(atRisk.attendance.attended, atRisk.attendance.counted),
        at_risk: flagged.length,
        at_risk_pct: pct(flagged.length, Number(counts.students)),
        compliance_rate: pct(tally.on_track, expected)
      },
      progress: { current_term: currentTerm, by_grade_level: byLevel, by_section: bySection, distribution: dist, by_term: byTerm },
      at_risk: {
        total: flagged.length,
        high: flagged.filter(s => s.severity === 'high').length,
        medium: flagged.filter(s => s.severity !== 'high').length,
        by_grade_level: byLevel.map(l => ({ grade_level: l.grade_level, students: l.students, total: l.at_risk, high: l.high, medium: l.medium })),
        top: flagged.slice(0, 8)
      },
      compliance: { ...tally, expected, rate: pct(tally.on_track, expected), teachers: compliance }
    });
  } catch (err) {
    console.error('Overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Kept for the old dashboard cards; the at-risk count now uses the shared rules.
router.get('/dashboard', async (req, res) => {
  try {
    const [[{ total_students }]] = await pool.query(
      `SELECT COUNT(*) AS total_students FROM users WHERE role='student'`
    );
    const [[{ avg_grade }]] = await pool.query(
      `SELECT ROUND(AVG(term_grade),2) AS avg_grade FROM grades WHERE term_grade > 0`
    );
    const { students } = await computeAtRisk();
    res.json({ total_students, avg_grade, at_risk: students.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full list of flagged students (all grade levels). Still an array with the old fields
// (id, full_name, section, avg_grade, absences) plus grade_level, severity and reasons.
router.get('/at-risk', async (req, res) => {
  try {
    const { students } = await computeAtRisk();
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Every teacher with last grade update / last attendance and a status (on_track | behind | overdue | no_subjects).
// Still has the old fields: teacher, last_update, days_ago.
router.get('/compliance', async (req, res) => {
  try {
    res.json(await computeCompliance());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/export', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.lrn, u.full_name, s.grade_level, sec.name AS section, sub.name AS subject,
             g.term, g.term_grade
      FROM users u
      JOIN students s ON s.user_id = u.id
      LEFT JOIN sections sec ON sec.id = s.section_id
      LEFT JOIN grades g ON g.student_id = u.id
      LEFT JOIN subjects sub ON sub.id = g.subject_id
      ORDER BY u.full_name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. MANAGE USERS
// ==========================================
router.get('/all-users', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.full_name, u.email, u.role, s.lrn, s.section_id, sec.name AS section 
      FROM users u
      LEFT JOIN students s ON s.user_id = u.id
      LEFT JOIN sections sec ON sec.id = s.section_id
      WHERE u.role != 'admin'
      ORDER BY u.role, u.full_name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users', async (req, res) => {
  const { email, password, full_name, role, lrn, section_id, grade_level } = req.body;
  try {
    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
      [email, password_hash, full_name, role]
    );
    const newUserId = result.insertId;

    if (role === 'student') {
      await pool.query(
        'INSERT INTO students (user_id, lrn, section_id, grade_level) VALUES (?, ?, ?, ?)',
        [newUserId, lrn, section_id || null, grade_level || 10]
      );
    }
    res.json({ ok: true, message: 'User created successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email or LRN already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:id', async (req, res) => {
  const userId = req.params.id;
  const { full_name, email, lrn, section_id, password } = req.body;
  try {
    await pool.query(
      'UPDATE users SET full_name = ?, email = ? WHERE id = ?',
      [full_name, email, userId]
    );

    if (password && password.trim() !== '') {
      const password_hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash, userId]);
    }

    const [user] = await pool.query('SELECT role FROM users WHERE id = ?', [userId]);
    if (user[0].role === 'student') {
      await pool.query(
        'UPDATE students SET lrn = ?, section_id = ? WHERE user_id = ?',
        [lrn, section_id || null, userId]
      );
    }
    res.json({ ok: true, message: 'User updated successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email or LRN already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = ? AND role != "admin"', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. MANAGE SUBJECTS
// ==========================================
router.get('/subjects', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT sub.id, sub.name, sub.code, sub.section_id, sub.teacher_id, 
             u.full_name AS teacher_name, sec.name AS section_name
      FROM subjects sub
      LEFT JOIN users u ON u.id = sub.teacher_id
      LEFT JOIN sections sec ON sec.id = sub.section_id
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/subjects', async (req, res) => {
  const { code, name, teacher_id, section_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO subjects (code, name, teacher_id, section_id) VALUES (?, ?, ?, ?)',
      [code, name, teacher_id, section_id]
    );
    res.json({ ok: true, message: 'Subject created and assigned' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Subject code already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/subjects/:id', async (req, res) => {
  const { code, name, teacher_id, section_id } = req.body;
  try {
    await pool.query(
      'UPDATE subjects SET code = ?, name = ?, teacher_id = ?, section_id = ? WHERE id = ?',
      [code, name, teacher_id, section_id, req.params.id]
    );
    res.json({ ok: true, message: 'Subject updated successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Subject code already exists' });
    res.status(500).json({ error: err.message });
  }
});

// UPDATED: Admin now properly cleans up grades/attendance when deleting a subject
router.delete('/subjects/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Delete associated grades
    await pool.query('DELETE FROM grades WHERE subject_id = ?', [id]);

    // Attendance is stored per section (not per subject), so it is kept when a subject is deleted.

    // 2. Delete the subject
    await pool.query('DELETE FROM subjects WHERE id = ?', [id]);
    
    res.json({ ok: true, message: 'Subject and linked records deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. DROPDOWNS
// ==========================================
router.get('/teachers', async (req, res) => {
  const [rows] = await pool.query("SELECT id, full_name FROM users WHERE role = 'teacher'");
  res.json(rows);
});

router.get('/sections', async (req, res) => {
  const [rows] = await pool.query('SELECT id, name FROM sections');
  res.json(rows);
});

module.exports = router;