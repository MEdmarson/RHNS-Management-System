const router = require('express').Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('teacher'));

/* ==========================================================================
   GRADING CONFIG  (keep in sync with js/teacher.js)
   ========================================================================== */
const ACTIVITIES = ['ww1','ww2','ww3','ww4','ww5','pt1','pt2','pt3','ex1','ex2','ex3'];
const GROUP_OF   = { ww: ACTIVITIES.slice(0, 5), pt: ACTIVITIES.slice(5, 8), ex: ACTIVITIES.slice(8) };
const ACT_LABEL  = {
  ww1:'WW1', ww2:'WW2', ww3:'WW3', ww4:'WW4', ww5:'WW5',
  pt1:'PT1', pt2:'PT2', pt3:'PT3', ex1:'SA1', ex2:'SA2', ex3:'TE'
};

// [WW, PT, EX]
const SUBJECT_WEIGHTS = {
  'Academic Electives':                          [0.20, 0.50, 0.30],
  'Arts Apprenticeship':                         [0.15, 0.70, 0.15],
  'Arts, Sports, Health and Wellness Electives': [0.20, 0.60, 0.20],
  'Core Subjects':                               [0.20, 0.50, 0.30],
  'Creative Production and Innovation':          [0.15, 0.70, 0.15],
  'Design and Innovation':                       [0.40, 0.60, 0],
  'Field Exposure':                              [0.15, 0.70, 0.15],
  'Research Electives':                          [0.40, 0.60, 0],
  'TechPro Electives':                           [0.15, 0.65, 0.20],
  'Work Immersion':                              [0.20, 0.80, 0]
};

const TRANSMUTATION = [
  [99.49,100],[98.31,99],[97.13,98],[95.95,97],[94.77,96],[93.59,95],[92.41,94],[91.23,93],
  [90.05,92],[88.87,91],[87.69,90],[86.51,89],[85.33,88],[84.15,87],[82.97,86],[81.79,85],
  [80.61,84],[79.43,83],[78.25,82],[77.07,81],[75.89,80],[74.71,79],[73.53,78],[72.35,77],
  [71.17,76],[69.99,75],[65.33,74],[60.66,73],[56,72],[51.33,71],[46.66,70],[42,69],
  [37.33,68],[32.67,67],[28,66],[23.34,65],[18.67,64],[14,63],[9.34,62],[4.67,61],[0,60]
];
const transmute = initial => {
  for (const [min, grade] of TRANSMUTATION) if (initial > min) return grade;
  return 60;
};
const descriptorOf = t => {
  if (t > 89) return 'Advancing';
  if (t > 79) return 'Benchmarking';
  if (t > 74) return 'Connecting';
  if (t > 64) return 'Developing';
  return 'Emerging';
};

/* --------------------------------------------------------------------------
   Activity states
     score number  -> scored (a real 0 is a real zero)
     null          -> not yet recorded  -> EXCLUDED from the computation
     status 'NS'   -> not submitted     -> counts as 0 AND is flagged as missing
     status 'EX'   -> excused / exempt  -> EXCLUDED from the computation
   -------------------------------------------------------------------------- */
function computeGrade({ scores, status, hps, subjectType }) {
  const weights = SUBJECT_WEIGHTS[subjectType] || SUBJECT_WEIGHTS['Core Subjects'];
  const groups = {};
  let weighted = 0, weightUsed = 0, weightExpected = 0;

  ['ww', 'pt', 'ex'].forEach((g, i) => {
    let total = 0, max = 0;
    GROUP_OF[g].forEach(f => {
      const h = Number(hps[f]) || 0;
      if (h <= 0 || status[f] === 'EX') return;
      if (status[f] === 'NS')            { max += h; return; }
      if (scores[f] === null || scores[f] === undefined) return;
      total += Number(scores[f]) || 0;
      max   += h;
    });
    const w  = weights[i];
    const ps = max > 0 ? (total / max) * 100 : null;
    groups[g] = { total, max, ps, ws: ps === null ? null : ps * w, weight: w };
    if (w > 0) weightExpected += w;
    if (ps !== null && w > 0) { weighted += ps * w; weightUsed += w; }
  });

  const missing = ACTIVITIES.filter(f => status[f] === 'NS').map(f => ACT_LABEL[f]);

  if (weightUsed === 0) {
    return { groups, initial: null, termGrade: null, descriptor: null, provisional: false, missing };
  }
  // Re-scale over the components that already have data, so a missing exam
  // doesn't drag the grade down. Flag as provisional until everything is in.
  const initial = weighted / weightUsed;
  const termGrade = transmute(initial);
  return {
    groups, initial, termGrade,
    descriptor: descriptorOf(termGrade),
    provisional: weightUsed < weightExpected - 1e-9,
    missing
  };
}

/* ==========================================================================
   HELPERS
   ========================================================================== */
const parseJson = v => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch { return {}; }
};
const toScore = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
const cleanStatus = s => {
  const out = {};
  if (s && typeof s === 'object') {
    ACTIVITIES.forEach(f => { if (s[f] === 'NS' || s[f] === 'EX') out[f] = s[f]; });
  }
  return out;
};
async function ownSubject(subjectId, teacherId) {
  const [rows] = await pool.query(
    'SELECT id, name, section_id FROM subjects WHERE id = ? AND teacher_id = ?', [subjectId, teacherId]);
  return rows[0] || null;
}
async function teachesSection(sectionId, teacherId) {
  const [rows] = await pool.query(
    'SELECT 1 FROM subjects WHERE section_id = ? AND teacher_id = ? LIMIT 1', [sectionId, teacherId]);
  return rows.length > 0;
}

/* ==========================================================================
   CLASSES
   ========================================================================== */
router.get('/my-subjects', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT sub.id, sub.name, sec.id AS section_id, sec.name AS section,
             (SELECT COUNT(*) FROM students st WHERE st.section_id = sec.id) AS student_count
      FROM subjects sub
      JOIN sections sec ON sec.id = sub.section_id
      WHERE sub.teacher_id = ?
      ORDER BY sec.name, sub.name`, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/roster/:subjectId', async (req, res) => {
  try {
    const subject = await ownSubject(req.params.subjectId, req.user.id);
    if (!subject) return res.status(403).json({ error: 'Not your subject' });
    const [rows] = await pool.query(`
      SELECT u.id AS student_id, u.full_name, s.lrn
      FROM students s JOIN users u ON u.id = s.user_id
      WHERE s.section_id = ? ORDER BY u.full_name`, [subject.section_id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================================================
   CLASS RECORD
   ========================================================================== */
router.get('/gradebook', async (req, res) => {
  const term = Number(req.query.term) || 1;
  const subjectId = Number(req.query.subject);
  if (!subjectId) return res.status(400).json({ error: 'Subject ID required' });

  try {
    const subject = await ownSubject(subjectId, req.user.id);
    if (!subject) return res.status(403).json({ error: 'Not your subject' });

    const [rows] = await pool.query(`
      SELECT u.id AS student_id, u.full_name, s.lrn,
             g.id AS grade_id,
             g.ww1, g.ww2, g.ww3, g.ww4, g.ww5, g.pt1, g.pt2, g.pt3, g.ex1, g.ex2, g.ex3,
             g.ww1_hps, g.ww2_hps, g.ww3_hps, g.ww4_hps, g.ww5_hps,
             g.pt1_hps, g.pt2_hps, g.pt3_hps, g.ex1_hps, g.ex2_hps, g.ex3_hps,
             g.term_grade, g.initial_grade, g.descriptor, g.missing_requirements, g.activity_status
      FROM students s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN grades g ON g.student_id = u.id AND g.subject_id = ? AND g.term = ?
      WHERE s.section_id = ?
      ORDER BY u.full_name`, [subjectId, term, subject.section_id]);

    // HPS is shared by the whole class: take it from the first row that has it.
    const withHps = rows.find(r => r.ww1_hps !== null && r.ww1_hps !== undefined);
    const hps = withHps ? Object.fromEntries(ACTIVITIES.map(f => [f, withHps[`${f}_hps`]])) : null;

    res.json({
      hps,
      rows: rows.map(r => ({ ...r, activity_status: cleanStatus(parseJson(r.activity_status)) }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Bulk save. Body:
 * { subject_id, term, subject_type, hps:{ww1:20,...},
 *   rows:[{ student_id, scores:{ww1:15,ww2:null,...}, status:{ww2:'NS',pt1:'EX'} }] }
 * The server computes initial/term grade/descriptor/missing list itself.
 */
router.post('/grades/bulk', async (req, res) => {
  const { subject_id, term, subject_type, hps = {}, rows = [] } = req.body || {};
  if (!subject_id || !term || !Array.isArray(rows)) return res.status(400).json({ error: 'Invalid payload' });

  const subject = await ownSubject(subject_id, req.user.id).catch(() => null);
  if (!subject) return res.status(403).json({ error: 'Not your subject' });

  const cleanHps = {};
  ACTIVITIES.forEach(f => { cleanHps[f] = toScore(hps[f]) ?? 0; });

  const cols = [
    'student_id', 'subject_id', 'term',
    ...ACTIVITIES, ...ACTIVITIES.map(f => `${f}_hps`),
    'initial_grade', 'term_grade', 'descriptor', 'missing_requirements', 'activity_status'
  ];
  const sql = `
    INSERT INTO grades (${cols.join(', ')})
    VALUES (${cols.map(() => '?').join(', ')})
    ON DUPLICATE KEY UPDATE ${cols.slice(3).map(c => `${c}=VALUES(${c})`).join(', ')}`;

  let conn;
  try {
    const [enrolled] = await pool.query('SELECT user_id FROM students WHERE section_id = ?', [subject.section_id]);
    const allowed = new Set(enrolled.map(r => r.user_id));

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const results = [];
    for (const row of rows) {
      if (!allowed.has(Number(row.student_id))) continue;

      const status = cleanStatus(row.status);
      const scores = {};
      ACTIVITIES.forEach(f => {
        scores[f] = status[f] ? null : toScore(row.scores && row.scores[f]);
      });

      const calc = computeGrade({ scores, status, hps: cleanHps, subjectType: subject_type });

      await conn.query(sql, [
        row.student_id, subject_id, term,
        ...ACTIVITIES.map(f => scores[f]),
        ...ACTIVITIES.map(f => cleanHps[f]),
        calc.initial, calc.termGrade, calc.descriptor,
        calc.missing.length ? calc.missing.join(', ') : null,
        JSON.stringify(status)
      ]);
      results.push({ student_id: row.student_id, term_grade: calc.termGrade, missing: calc.missing });
    }

    await conn.commit();
    res.json({ ok: true, saved: results.length, results });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

/* ==========================================================================
   ATTENDANCE
   ========================================================================== */
const STATUSES = ['present', 'late', 'excused', 'absent'];

router.get('/attendance/:subjectId/:date', async (req, res) => {
  const { subjectId, date } = req.params;
  try {
    const [rows] = await pool.query(`
      SELECT u.id AS student_id, u.full_name, a.status,
             (SELECT COUNT(*) FROM attendance WHERE student_id = u.id AND section_id = sub.section_id AND status = 'present') AS days_present,
             (SELECT COUNT(*) FROM attendance WHERE student_id = u.id AND section_id = sub.section_id AND status = 'late')    AS days_late,
             (SELECT COUNT(*) FROM attendance WHERE student_id = u.id AND section_id = sub.section_id AND status = 'excused') AS days_excused,
             (SELECT COUNT(*) FROM attendance WHERE student_id = u.id AND section_id = sub.section_id AND status = 'absent')  AS days_absent
      FROM subjects sub
      JOIN students s ON s.section_id = sub.section_id
      JOIN users u ON u.id = s.user_id
      LEFT JOIN attendance a ON a.student_id = u.id AND a.date = ? AND a.section_id = sub.section_id
      WHERE sub.teacher_id = ? AND sub.id = ?
      ORDER BY u.full_name`, [date, req.user.id, subjectId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/attendance', async (req, res) => {
  const { student_id, section_id, date, status } = req.body;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    if (!(await teachesSection(section_id, req.user.id))) return res.status(403).json({ error: 'Not your section' });
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
      FROM subjects sub
      JOIN students s ON s.section_id = sub.section_id
      JOIN users u ON u.id = s.user_id
      JOIN attendance a ON a.student_id = u.id AND a.section_id = sub.section_id
      WHERE sub.teacher_id = ? AND sub.id = ? AND MONTH(a.date) = ? AND YEAR(a.date) = ?
      ORDER BY u.full_name, a.date`, [req.user.id, subjectId, month, year]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================================================
   AT-RISK
   ========================================================================== */
const RISK = {
  PASSING: 75,            // below this = failing (high)
  WATCH: 78,              // below this = borderline (medium)
  MISSING_HIGH: 3,        // this many missing activities in one subject = high
  STREAK_HIGH: 5,         // consecutive school days absent
  STREAK_MEDIUM: 3,
  RATE_HIGH: 85,          // attendance % (excused days are not counted against)
  RATE_MEDIUM: 92,
  MIN_DAYS_FOR_RATE: 5,   // don't judge the rate on fewer recorded days
  LATES_PER_ABSENCE: 3
};

function attendanceSummary(records) {
  // records: [{ date:'YYYY-MM-DD', status }] sorted ascending
  const c = { present: 0, late: 0, excused: 0, absent: 0 };
  records.forEach(r => { if (c[r.status] !== undefined) c[r.status]++; });

  const converted = Math.floor(c.late / RISK.LATES_PER_ABSENCE);
  const effectiveAbsences = c.absent + converted;
  const counted = records.length - c.excused;          // excused days leave the denominator
  const rate = counted > 0 ? Math.max(0, ((counted - effectiveAbsences) / counted) * 100) : null;

  // Current streak: walk back from the latest record; excused days neither extend nor break it.
  let streak = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const s = records[i].status;
    if (s === 'excused') continue;
    if (s === 'absent') streak++; else break;
  }
  return { recorded: records.length, ...c, converted, effective_absences: effectiveAbsences, rate, streak };
}

/** Pure function: easy to unit-test. */
function buildRiskReport({ subjects, students, grades, attendance }) {
  const subjectById = new Map(subjects.map(s => [s.id, s]));

  // For each student + subject, use the latest term that actually has a grade.
  const best = new Map();
  grades.forEach(g => {
    if (g.term_grade === null || g.term_grade === undefined) return;
    const k = `${g.student_id}:${g.subject_id}`;
    if (!best.has(k) || g.term > best.get(k).term) best.set(k, g);
  });
  const gradesByStudent = new Map();
  best.forEach(g => {
    if (!gradesByStudent.has(g.student_id)) gradesByStudent.set(g.student_id, []);
    gradesByStudent.get(g.student_id).push(g);
  });
  const attByStudent = new Map();
  attendance.forEach(a => {
    if (!attByStudent.has(a.student_id)) attByStudent.set(a.student_id, []);
    attByStudent.get(a.student_id).push(a);
  });

  const out = [];
  students.forEach(st => {
    const flags = [];
    const subjectRows = [];

    (gradesByStudent.get(st.student_id) || []).forEach(g => {
      const subj = subjectById.get(g.subject_id);
      if (!subj) return;
      const status = parseJson(g.activity_status);
      let missing = ACTIVITIES.filter(f => status[f] === 'NS').map(f => ACT_LABEL[f]);
      if (!missing.length && g.missing_requirements && String(g.missing_requirements).trim()) {
        missing = String(g.missing_requirements).split(',').map(s => s.trim()).filter(Boolean); // legacy free-text
      }
      const grade = g.term_grade;
      subjectRows.push({ subject: subj.name, term: g.term, grade, missing });

      if (grade !== null && grade !== undefined) {
        if (grade < RISK.PASSING)
          flags.push({ category: 'failing', severity: 'high', text: `${subj.name}: ${grade} (below ${RISK.PASSING})` });
        else if (grade < RISK.WATCH)
          flags.push({ category: 'failing', severity: 'medium', text: `${subj.name}: ${grade} (borderline)` });
      }
      if (missing.length) {
        flags.push({
          category: 'missing',
          severity: missing.length >= RISK.MISSING_HIGH ? 'high' : 'medium',
          text: `${subj.name}: no submission for ${missing.join(', ')}`
        });
      }
    });

    const att = attendanceSummary(attByStudent.get(st.student_id) || []);
    if (att.streak >= RISK.STREAK_MEDIUM) {
      flags.push({
        category: 'attendance',
        severity: att.streak >= RISK.STREAK_HIGH ? 'high' : 'medium',
        text: `${att.streak} absences in a row`
      });
    }
    if (att.rate !== null && att.recorded >= RISK.MIN_DAYS_FOR_RATE) {
      if (att.rate < RISK.RATE_HIGH)
        flags.push({ category: 'attendance', severity: 'high', text: `Attendance ${Math.round(att.rate)}%` });
      else if (att.rate < RISK.RATE_MEDIUM)
        flags.push({ category: 'attendance', severity: 'medium', text: `Attendance ${Math.round(att.rate)}%` });
    }

    if (!flags.length) return;
    const rank = { high: 0, medium: 1 };
    out.push({
      student_id: st.student_id,
      full_name: st.full_name,
      section: st.section,
      level: flags.some(f => f.severity === 'high') ? 'high' : 'medium',
      categories: [...new Set(flags.map(f => f.category))],
      flags: flags.sort((a, b) => rank[a.severity] - rank[b.severity]),
      subjects: subjectRows,
      attendance: { ...att, rate: att.rate === null ? null : Math.round(att.rate) }
    });
  });

  out.sort((a, b) =>
    (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1) ||
    b.flags.length - a.flags.length ||
    a.full_name.localeCompare(b.full_name));

  const has = c => out.filter(s => s.categories.includes(c)).length;
  return {
    thresholds: RISK,
    summary: {
      total: out.length,
      high: out.filter(s => s.level === 'high').length,
      medium: out.filter(s => s.level === 'medium').length,
      failing: has('failing'), missing: has('missing'), attendance: has('attendance')
    },
    students: out
  };
}

router.get('/at-risk', async (req, res) => {
  try {
    const [subjects] = await pool.query(`
      SELECT sub.id, sub.name, sub.section_id, sec.name AS section
      FROM subjects sub JOIN sections sec ON sec.id = sub.section_id
      WHERE sub.teacher_id = ?`, [req.user.id]);
    if (!subjects.length) return res.json(buildRiskReport({ subjects, students: [], grades: [], attendance: [] }));

    const subjectIds = subjects.map(s => s.id);
    const sectionIds = [...new Set(subjects.map(s => s.section_id))];
    const sectionName = new Map(subjects.map(s => [s.section_id, s.section]));

    const [studentRows] = await pool.query(`
      SELECT u.id AS student_id, u.full_name, s.section_id
      FROM students s JOIN users u ON u.id = s.user_id
      WHERE s.section_id IN (?)`, [sectionIds]);
    const students = studentRows.map(r => ({ ...r, section: sectionName.get(r.section_id) }));

    const [grades] = await pool.query(`
      SELECT student_id, subject_id, term, term_grade, missing_requirements, activity_status
      FROM grades WHERE subject_id IN (?)`, [subjectIds]);

    const [attendance] = await pool.query(`
      SELECT student_id, DATE_FORMAT(date, '%Y-%m-%d') AS date, status
      FROM attendance WHERE section_id IN (?)
      ORDER BY student_id, date`, [sectionIds]);

    res.json(buildRiskReport({ subjects, students, grades, attendance }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================================================
   SF2
   ========================================================================== */
router.get('/sf2/:sectionId', async (req, res) => {
  try {
    if (!(await teachesSection(req.params.sectionId, req.user.id)))
      return res.status(403).json({ error: 'Not your section' });
    const [rows] = await pool.query(`
      SELECT s.lrn, u.full_name,
             COALESCE(SUM(a.status = 'present'), 0) AS days_present,
             COALESCE(SUM(a.status = 'late'), 0)    AS days_late,
             COALESCE(SUM(a.status = 'excused'), 0) AS days_excused,
             COALESCE(SUM(a.status = 'absent'), 0)  AS days_absent
      FROM users u
      JOIN students s ON s.user_id = u.id
      LEFT JOIN attendance a ON a.student_id = u.id AND a.section_id = s.section_id
      WHERE s.section_id = ?
      GROUP BY u.id, s.lrn, u.full_name ORDER BY u.full_name`, [req.params.sectionId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.__test = { computeGrade, buildRiskReport, attendanceSummary };