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

// Students log in with their LRN, so their email is optional (stored as NULL, never as an empty string,
// so several students without an email do not clash on the unique index). Teachers still need one.
const cleanEmail = (v) => { const t = String(v || '').trim(); return t === '' ? null : t; };

// Make sure users.email accepts NULL (keeps the existing column type and unique index)
pool.query(`SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email'`)
  .then(([[c]]) => c && c.IS_NULLABLE === 'NO' ? pool.query(`ALTER TABLE users MODIFY email ${c.COLUMN_TYPE} NULL`) : null)
  .catch((e) => console.error('Could not make users.email nullable:', e.message));

router.post('/users', async (req, res) => {
  const { password, full_name, role, lrn, section_id, grade_level } = req.body;
  const email = cleanEmail(req.body.email);
  try {
    if (role !== 'student' && !email) return res.status(400).json({ error: 'Email is required for teachers' });
    if (role === 'student' && !String(lrn || '').trim()) return res.status(400).json({ error: 'LRN is required for students' });
    // A student without a typed password starts with their LRN, like the login page tells them
    const plain = password && String(password).trim() ? password : (role === 'student' ? String(lrn).trim() : '');
    if (!plain) return res.status(400).json({ error: 'Password is required' });
    const password_hash = await bcrypt.hash(plain, 10);
    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
      [email, password_hash, full_name, role]
    );
    const newUserId = result.insertId;

    if (role === 'student') {
      await pool.query(
        'INSERT INTO students (user_id, lrn, section_id, grade_level) VALUES (?, ?, ?, ?)',
        [newUserId, String(lrn).trim(), section_id || null, grade_level || 10]
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
  const { full_name, lrn, section_id, password } = req.body;
  const email = cleanEmail(req.body.email);
  try {
    const [[existing]] = await pool.query('SELECT role FROM users WHERE id = ?', [userId]);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (existing.role !== 'student' && !email) return res.status(400).json({ error: 'Email is required for teachers' });
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

// ==========================================
// 5. TEACHER COMPLIANCE DRILL-DOWN: READ-ONLY CLASS RECORDS
//    (GET only - the admin can look at and download a class record, never edit it)
// ==========================================
const fs = require('fs');
const path = require('path');
const { buildClassRecord, SUBJECT_WEIGHTS } = require('../utils/classRecordBuilder');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'class-record-template.xlsx');
let templateCache = null;
const getTemplate = () => templateCache || (templateCache = fs.readFileSync(TEMPLATE_PATH));

const GRADE_COLS = `g.ww1, g.ww2, g.ww3, g.ww4, g.ww5, g.pt1, g.pt2, g.pt3, g.ex1, g.ex2, g.ex3,
  g.ww1_hps, g.ww2_hps, g.ww3_hps, g.ww4_hps, g.ww5_hps, g.pt1_hps, g.pt2_hps, g.pt3_hps,
  g.ex1_hps, g.ex2_hps, g.ex3_hps, g.initial_grade, g.term_grade, g.descriptor, g.missing_requirements`;

async function termRowsFor(subjectId, term) {
  const [rows] = await pool.query(`
    SELECT u.id AS student_id, u.full_name, s.lrn, s.gender, ${GRADE_COLS}
    FROM subjects sub
    JOIN students s ON s.section_id = sub.section_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN grades g ON g.student_id = u.id AND g.subject_id = sub.id AND g.term = ?
    WHERE sub.id = ?
    ORDER BY u.full_name
  `, [term, subjectId]);
  return rows;
}

async function subjectMeta(subjectId) {
  const [[meta]] = await pool.query(`
    SELECT sub.id, sub.name AS subject_name, sub.code, sub.status, sub.subject_type,
           sec.name AS section, u.full_name AS teacher_name, u.id AS teacher_id
    FROM subjects sub
    JOIN sections sec ON sec.id = sub.section_id
    LEFT JOIN users u ON u.id = sub.teacher_id
    WHERE sub.id = ?
  `, [subjectId]);
  return meta;
}

// Subjects of one teacher, with how many students and how many have grades
router.get('/teachers/:id/subjects', async (req, res) => {
  try {
    const [[teacher]] = await pool.query("SELECT id, full_name FROM users WHERE id = ? AND role = 'teacher'", [req.params.id]);
    if (!teacher) return res.status(404).json({ error: 'Teacher not found' });
    const [subjects] = await pool.query(`
      SELECT sub.id, sub.name, sub.code, sub.status, sub.subject_type, sec.name AS section,
             (SELECT COUNT(*) FROM students st WHERE st.section_id = sub.section_id) AS student_count,
             (SELECT COUNT(DISTINCT g.student_id) FROM grades g WHERE g.subject_id = sub.id AND g.term_grade IS NOT NULL) AS graded_count,
             (SELECT MAX(g.updated_at) FROM grades g WHERE g.subject_id = sub.id) AS last_update
      FROM subjects sub
      LEFT JOIN sections sec ON sec.id = sub.section_id
      WHERE sub.teacher_id = ?
      ORDER BY sub.name
    `, [teacher.id]).catch(async () => {
      // older schema without grades.updated_at
      return pool.query(`
        SELECT sub.id, sub.name, sub.code, sub.status, sub.subject_type, sec.name AS section,
               (SELECT COUNT(*) FROM students st WHERE st.section_id = sub.section_id) AS student_count,
               (SELECT COUNT(DISTINCT g.student_id) FROM grades g WHERE g.subject_id = sub.id AND g.term_grade IS NOT NULL) AS graded_count,
               NULL AS last_update
        FROM subjects sub LEFT JOIN sections sec ON sec.id = sub.section_id
        WHERE sub.teacher_id = ? ORDER BY sub.name
      `, [teacher.id]);
    });
    res.json({ teacher, subjects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One subject's class record for all three terms + final grade (view only)
router.get('/class-record/:subjectId', async (req, res) => {
  try {
    const meta = await subjectMeta(Number(req.params.subjectId));
    if (!meta) return res.status(404).json({ error: 'Subject not found' });
    const terms = {};
    for (const t of [1, 2, 3]) terms[t] = await termRowsFor(meta.id, t);

    const final = terms[1].map((r, i) => {
      const tg = [1, 2, 3].map(t => terms[t][i] && terms[t][i].term_grade).map(v => (v === null || v === undefined ? null : Number(v)));
      const present = tg.filter(v => v !== null && v > 0);
      const fg = present.length ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : null;
      return { student_id: r.student_id, full_name: r.full_name, lrn: r.lrn, gender: r.gender,
               t1: tg[0], t2: tg[1], t3: tg[2], final: fg, passed: fg === null ? null : fg >= 75 };
    });
    const type = SUBJECT_WEIGHTS[meta.subject_type] ? meta.subject_type : 'Core Subjects';
    res.json({ meta: { ...meta, subject_type: type, weights: SUBJECT_WEIGHTS[type] }, terms, final });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Excel download - same template and builder the teacher uses
router.get('/class-record/:subjectId/export', async (req, res) => {
  try {
    const meta = await subjectMeta(Number(req.params.subjectId));
    if (!meta) return res.status(404).json({ error: 'Subject not found' });
    const termRows = {};
    for (const t of [1, 2, 3]) termRows[t] = await termRowsFor(meta.id, t);
    const buffer = await buildClassRecord({
      templateBuf: getTemplate(),
      meta: { subject_name: meta.subject_name, section: meta.section, teacher_name: meta.teacher_name || '' },
      subjectType: SUBJECT_WEIGHTS[meta.subject_type] ? meta.subject_type : 'Core Subjects',
      termRows
    });
    const safe = (s) => String(s).replace(/[^a-z0-9]+/gi, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ClassRecord_${safe(meta.subject_name)}_${safe(meta.section)}.xlsx"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error('Admin export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. SECTIONS & TRANSFERRING STUDENTS
// ==========================================
// Sections with student / subject counts
router.get('/sections/summary', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT sec.id, sec.name,
             (SELECT MAX(st.grade_level) FROM students st WHERE st.section_id = sec.id) AS grade_level,
             (SELECT COUNT(*) FROM students st WHERE st.section_id = sec.id) AS student_count,
             (SELECT COUNT(*) FROM subjects sb WHERE sb.section_id = sec.id) AS subject_count
      FROM sections sec ORDER BY sec.name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sections', async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  if (!name) return res.status(400).json({ error: 'Section name is required' });
  try {
    const [[dup]] = await pool.query('SELECT id FROM sections WHERE LOWER(name) = LOWER(?)', [name]);
    if (dup) return res.status(400).json({ error: 'A section with that name already exists' });
    const [r] = await pool.query('INSERT INTO sections (name) VALUES (?)', [name]);
    res.json({ ok: true, id: r.insertId, message: 'Section created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/sections/:id', async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  if (!name) return res.status(400).json({ error: 'Section name is required' });
  try {
    const [[dup]] = await pool.query('SELECT id FROM sections WHERE LOWER(name) = LOWER(?) AND id <> ?', [name, req.params.id]);
    if (dup) return res.status(400).json({ error: 'A section with that name already exists' });
    await pool.query('UPDATE sections SET name = ? WHERE id = ?', [name, req.params.id]);
    res.json({ ok: true, message: 'Section renamed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Only an empty section (no students, no subjects) can be deleted, so no records are ever lost
router.delete('/sections/:id', async (req, res) => {
  try {
    const [[c]] = await pool.query(
      `SELECT (SELECT COUNT(*) FROM students WHERE section_id = ?) AS students,
              (SELECT COUNT(*) FROM subjects WHERE section_id = ?) AS subjects`, [req.params.id, req.params.id]);
    if (c.students > 0 || c.subjects > 0) {
      return res.status(400).json({ error: `Cannot delete: the section still has ${c.students} student(s) and ${c.subjects} subject(s). Move or remove them first.` });
    }
    await pool.query('DELETE FROM sections WHERE id = ?', [req.params.id]);
    res.json({ ok: true, message: 'Section deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Students of a section
router.get('/sections/:id/students', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id AS student_id, u.full_name, s.lrn, s.gender, s.grade_level
      FROM students s JOIN users u ON u.id = s.user_id
      WHERE s.section_id = ? ORDER BY u.full_name
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Transfer students to another section.
// POST /api/admin/sections/transfer { student_ids: [..], to_section_id, preview?: true }
// Nothing is deleted: grades stay stored under the old subjects and attendance under the old section.
router.post('/sections/transfer', async (req, res) => {
  const ids = [...new Set((req.body.student_ids || []).map(Number).filter(Boolean))];
  const toId = Number(req.body.to_section_id);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one student' });
  if (!toId) return res.status(400).json({ error: 'Choose the destination section' });
  try {
    const [[target]] = await pool.query('SELECT id, name FROM sections WHERE id = ?', [toId]);
    if (!target) return res.status(404).json({ error: 'Destination section not found' });

    const [students] = await pool.query(
      'SELECT s.user_id, u.full_name, s.section_id FROM students s JOIN users u ON u.id = s.user_id WHERE s.user_id IN (?)', [ids]);
    const moving = students.filter(s => s.section_id !== toId);
    if (!moving.length) return res.status(400).json({ error: 'Those students are already in that section' });

    // How many existing grade rows will no longer be reachable (they belong to the old section's subjects)
    const [[g]] = await pool.query(`
      SELECT COUNT(*) AS n FROM grades gr
      JOIN subjects sb ON sb.id = gr.subject_id
      WHERE gr.student_id IN (?) AND sb.section_id <> ?`, [moving.map(s => s.user_id), toId]);
    const [[tsub]] = await pool.query('SELECT COUNT(*) AS n FROM subjects WHERE section_id = ?', [toId]);

    if (req.body.preview) {
      return res.json({
        ok: true, preview: true, to_section: target.name,
        moving: moving.length, skipped: students.length - moving.length,
        grade_rows_left_behind: g.n, destination_subjects: tsub.n
      });
    }

    const [[lvl]] = await pool.query(
      "SELECT grade_level FROM students WHERE section_id = ? AND grade_level IS NOT NULL LIMIT 1", [toId]);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const s of moving) {
        if (lvl && lvl.grade_level) {
          await conn.query('UPDATE students SET section_id = ?, grade_level = ? WHERE user_id = ?', [toId, lvl.grade_level, s.user_id]);
        } else {
          await conn.query('UPDATE students SET section_id = ? WHERE user_id = ?', [toId, s.user_id]);
        }
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

    res.json({ ok: true, moved: moving.length, to_section: target.name, grade_rows_left_behind: g.n,
               message: `${moving.length} student(s) moved to ${target.name}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;