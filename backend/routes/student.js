// routes/student.js
const router = require('express').Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('student'));

const ACTIVITIES = ['ww1','ww2','ww3','ww4','ww5','pt1','pt2','pt3','ex1','ex2','ex3'];
const EXAMS = ['ex1','ex2','ex3'];
const TERMS = [1, 2, 3];
const PASSING = 75;
const INC_THRESHOLD = 3;       // missing items in a closed term that make it INC
const ABSENCE_LIMIT = 20;      // DepEd limit per school year
const LATES_PER_ABSENCE = 3;   // same rule as the teacher portal

const showRaw = () => process.env.STUDENT_SHOW_RAW !== 'false';
const QUALITATIVE = {
  passed: 'Passed', failed: 'Failed', inc: 'INC / Not Submitted',
  'in-progress': 'In Progress', pending: '—',
};

// ---------------------------------------------------------------------------
// TERM LOGIC
// ---------------------------------------------------------------------------
// A term is "closed" once its last exam is scored (or the teacher finished the
// subject). Only closed terms can be INC or have overdue items, so activities
// the teacher has planned but not given yet no longer count against the student.
function analyzeTerm(grade, subjectFinished = false) {
  if (!grade) return { status: 'pending', missing: [], overdue: [], hasAnyScore: false, finalDone: false };

  const hps = a => Number(grade[`${a}_hps`]) || 0;
  const hasScore = a => grade[a] !== null && grade[a] !== undefined;

  const missing = ACTIVITIES.filter(a => hps(a) > 0 && !hasScore(a)).map(a => a.toUpperCase());
  const hasAnyScore = ACTIVITIES.some(hasScore);

  // Last exam slot that has a max score. Subjects with no exam (e.g. Work Immersion)
  // are done once every planned activity is scored.
  const examSlots = EXAMS.filter(a => hps(a) > 0);
  const lastExam = examSlots[examSlots.length - 1];
  const finalDone = lastExam ? hasScore(lastExam) : (hasAnyScore && missing.length === 0);

  const closed = finalDone || subjectFinished;
  const overdue = closed ? missing : [];

  let status;
  if (closed && missing.length >= INC_THRESHOLD) status = 'inc';
  else if (hasAnyScore && finalDone)             status = 'graded';
  else if (hasAnyScore)                          status = 'in-progress';
  else                                           status = 'pending';

  return { status, missing, overdue, hasAnyScore, finalDone };
}

function termSummary(g, subjectFinished) {
  const a = analyzeTerm(g, subjectFinished);
  const grade = g && Number(g.term_grade) > 0 ? Number(g.term_grade) : null;
  let status = a.status;
  if (status === 'graded') {
    // Teacher has not saved a computed grade yet, so the term is still open
    status = grade === null ? 'in-progress' : grade >= PASSING ? 'passed' : 'failed';
  }
  return { status, grade, missing: a.missing, overdue: a.overdue };
}

function summarizeSubject(sub, gs) {
  const raw = showRaw();
  const finished = sub.subject_status === 'finished';

  const terms = {};
  for (const t of TERMS) terms[t] = termSummary(gs.find(x => Number(x.term) === t), finished);

  const graded   = TERMS.filter(t => terms[t].status === 'passed' || terms[t].status === 'failed');
  const incTerms = TERMS.filter(t => terms[t].status === 'inc');
  const values   = graded.map(t => terms[t].grade);
  const sum      = values.reduce((a, b) => a + b, 0);
  const average  = values.length ? Math.round(sum / values.length) : null;

  const isCompleted = graded.length === TERMS.length && incTerms.length === 0;
  // A subject the teacher finished is final once it has grades and no INC
  const isFinal = isCompleted || (finished && graded.length > 0 && incTerms.length === 0);

  let status;
  if (incTerms.length)       status = 'INC / Not Submitted';
  else if (isFinal)          status = average >= PASSING ? 'Passed' : 'Failed';
  else if (graded.length)    status = 'In Progress';
  else                       status = 'Not Started';

  // What the student still needs to finish with a rounded average of 75
  let target = null;
  if (raw && !isFinal && !incTerms.length && graded.length && graded.length < TERMS.length) {
    const left = TERMS.length - graded.length;
    const needed = Math.ceil(((PASSING - 0.5) * TERMS.length - sum) / left);
    target = {
      termsLeft: left,
      needed,
      state: needed <= 60 ? 'secured' : needed > 100 ? 'out_of_reach' : 'reachable',
    };
  }

  const pick = fn => Object.fromEntries(TERMS.map(t => [t, fn(terms[t])]));

  return {
    subject_id:  sub.subject_id,
    subject:     sub.subject,
    teacher:     sub.teacher,
    grade_level: sub.grade_level,

    term1: raw ? terms[1].grade : null,
    term2: raw ? terms[2].grade : null,
    term3: raw ? terms[3].grade : null,

    term_status:  pick(t => t.status),
    term_overdue: pick(t => (finished ? [] : t.overdue)),

    term_grade:  average,
    status,
    graded_count: graded.length,
    is_final:    isFinal,
    is_active:   !finished && !isCompleted,
    has_inc:     incTerms.length > 0,
    finished_by_teacher: finished,
    finished_at: sub.finished_at || null,
    target,
  };
}

function buildProgress(list) {
  let completed = 0, passed = 0, failed = 0, inc = 0, inProgress = 0, notStarted = 0;
  for (const s of list) {
    if (s.has_inc)               inc++;
    else if (s.is_final)       { completed++; if (s.status === 'Passed') passed++; else failed++; }
    else if (s.graded_count > 0) inProgress++;
    else                         notStarted++;
  }
  const total = list.length;
  let promotionStatus = 'In Progress';
  if (!total)                                promotionStatus = 'No subjects yet';
  else if (failed > 0)                       promotionStatus = 'For Remediation';
  else if (inc > 0)                          promotionStatus = 'Pending Requirements';
  else if (completed === total)              promotionStatus = 'Cleared for Promotion / Graduation';

  return {
    total, completed, passed, failed, inc, inProgress, notStarted, promotionStatus,
    pctComplete: total ? Math.round((completed / total) * 100) : 0,
  };
}

// ---------------------------------------------------------------------------
// DATA LOADERS (shared by every endpoint so the numbers always agree)
// ---------------------------------------------------------------------------
async function loadSubjects(userId) {
  const [subjects] = await pool.query(`
    SELECT sub.id          AS subject_id,
           sub.name        AS subject,
           sub.status      AS subject_status,
           sub.finished_at AS finished_at,
           t.full_name     AS teacher,
           s.grade_level   AS grade_level
    FROM subjects sub
    JOIN students s ON s.section_id = sub.section_id
    JOIN users t    ON t.id = sub.teacher_id
    WHERE s.user_id = ?
    ORDER BY sub.name
  `, [userId]);

  const [grades] = await pool.query(`
    SELECT g.*
    FROM grades g
    JOIN subjects sub ON sub.id = g.subject_id
    JOIN students s   ON s.section_id = sub.section_id AND s.user_id = g.student_id
    WHERE g.student_id = ?
  `, [userId]);

  const bySubject = {};
  for (const g of grades) (bySubject[g.subject_id] ||= []).push(g);

  return subjects.map(sub => summarizeSubject(sub, bySubject[sub.subject_id] || []));
}

async function loadAttendance(userId) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(status='present'), 0) AS present,
           COALESCE(SUM(status='absent'),  0) AS absent,
           COALESCE(SUM(status='late'),    0) AS late,
           COALESCE(SUM(status='excused'), 0) AS excused
    FROM attendance WHERE student_id = ?
  `, [userId]);

  const r = rows[0] || {};
  const present = +r.present || 0, absent = +r.absent || 0;
  const late = +r.late || 0, excused = +r.excused || 0;

  // Same math as the teacher portal: every 3 lates count as 1 absence
  const converted = Math.floor(late / LATES_PER_ABSENCE);
  const absences = absent + converted;
  const presentAdj = present + late - converted;
  const totalDays = present + absent + late + excused;

  return {
    present: presentAdj,
    absent: absences,
    late, excused, converted,
    limit: ABSENCE_LIMIT,
    remaining: Math.max(ABSENCE_LIMIT - absences, 0),
    totalDays,
    rate: totalDays ? Math.round(((presentAdj + excused) / totalDays) * 100) : null,
  };
}

// Live alerts worked out from the grades and attendance. They have no row in the
// notifications table, so the browser remembers which ones the student has seen
// (id + sig; a changed sig means something new happened).
function buildAlerts(list, att) {
  const alerts = [];

  for (const s of list) {
    const incTerms = TERMS.filter(t => s.term_status[t] === 'inc');
    if (s.finished_by_teacher && incTerms.length) {
      alerts.push({
        id: `inc-fin-${s.subject_id}`, sig: incTerms.join(','), type: 'error',
        title: `INC: ${s.subject} (${incTerms.length > 1 ? 'Terms' : 'Term'} ${incTerms.join(', ')})`,
        body: `This subject is already marked finished, so requirements are settled in person. Approach ${s.teacher} and ask how to clear your INC.`,
      });
    }
    for (const t of TERMS) {
      const overdue = s.term_overdue[t] || [];
      const st = s.term_status[t];

      if (overdue.length) {
        alerts.push({
          id: `miss-${s.subject_id}-${t}`, sig: overdue.join(','),
          type: st === 'inc' ? 'error' : 'warning',
          title: `Missing requirements: ${s.subject} (Term ${t})`,
          body: `Not yet submitted: ${overdue.join(', ')}. ` +
                (st === 'inc' ? 'This term stays INC until they are complete.' : 'Submit them to your teacher to avoid an INC.'),
        });
      }
      if (st === 'failed') {
        const g = s[`term${t}`];
        alerts.push({
          id: `fail-${s.subject_id}-${t}`, sig: String(g ?? 'failed'), type: 'error',
          title: `Below passing: ${s.subject} (Term ${t})`,
          body: (g != null ? `Your grade is ${g}; passing is ${PASSING}. ` : `Your grade is below the passing mark of ${PASSING}. `) +
                'Ask your teacher about make-up work.',
        });
      }
    }
  }

  if (att.absent >= 10) {
    const high = att.absent >= 15;
    alerts.push({
      id: 'att-limit', sig: String(att.absent), type: high ? 'error' : 'warning',
      title: `Attendance: ${att.absent} absences recorded`,
      body: att.remaining > 0
        ? `The limit is ${ABSENCE_LIMIT} per school year. Avoid missing more classes.`
        : 'You have reached the absence limit. Talk to your adviser right away.',
    });
  }

  const rank = { error: 0, warning: 1 };
  return alerts.map(a => ({ ...a, source: 'system', created_at: null }))
               .sort((a, b) => rank[a.type] - rank[b.type]);
}

async function loadNotifications(userId, subjects, attendance) {
  const [stored] = await pool.query(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
    [userId]
  );
  return { alerts: buildAlerts(subjects, attendance), messages: stored };
}

// ---------------------------------------------------------------------------
// GET /student/overview — everything the dashboard needs in one round trip
// ---------------------------------------------------------------------------
router.get('/overview', async (req, res) => {
  try {
    const [subjects, attendance] = await Promise.all([
      loadSubjects(req.user.id),
      loadAttendance(req.user.id),
    ]);
    const notifications = await loadNotifications(req.user.id, subjects, attendance);
    res.json({ subjects, progress: buildProgress(subjects), attendance, notifications });
  } catch (err) {
    console.error('Student Overview Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /student/subjects
// ---------------------------------------------------------------------------
router.get('/subjects', async (req, res) => {
  try {
    res.json(await loadSubjects(req.user.id));
  } catch (err) {
    console.error('Student Subjects Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /student/subjects/:subjectId/details — always returns Terms 1 to 3
// ---------------------------------------------------------------------------
router.get('/subjects/:subjectId/details', async (req, res) => {
  const { subjectId } = req.params;
  try {
    const [authCheck] = await pool.query(`
      SELECT sub.status AS subject_status
      FROM subjects sub
      JOIN students s ON s.section_id = sub.section_id
      WHERE sub.id = ? AND s.user_id = ?
    `, [subjectId, req.user.id]);

    if (!authCheck.length) return res.status(403).json({ error: 'Unauthorized' });
    const finished = authCheck[0].subject_status === 'finished';

    const [grades] = await pool.query(
      'SELECT * FROM grades WHERE subject_id = ? AND student_id = ? ORDER BY term ASC',
      [subjectId, req.user.id]
    );

    const raw = showRaw();
    const result = TERMS.map(t => {
      const g = grades.find(x => Number(x.term) === t);
      const ts = termSummary(g, finished);
      const done = ts.status === 'passed' || ts.status === 'failed';

      const activities = g ? ACTIVITIES.map(a => ({
        field:   a,
        score:   g[a],
        hps:     Number(g[`${a}_hps`]) || 0,
        missing: Number(g[`${a}_hps`]) > 0 && (g[a] === null || g[a] === undefined),
      })) : [];

      return {
        term:               t,
        activities:         raw ? activities : undefined,
        initial_grade:      raw && g ? g.initial_grade : undefined,
        term_grade:         raw && g ? g.term_grade : undefined,
        descriptor:         done && g ? g.descriptor : null,
        qualitative:        QUALITATIVE[ts.status],
        missing_activities: activities.filter(x => x.missing).map(x => x.field.toUpperCase()),
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /student/progress
// ---------------------------------------------------------------------------
router.get('/progress', async (req, res) => {
  try {
    res.json(buildProgress(await loadSubjects(req.user.id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /student/attendance
// ---------------------------------------------------------------------------
router.get('/attendance', async (req, res) => {
  try {
    res.json(await loadAttendance(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /student/notifications  →  { alerts: [...live], messages: [...stored] }
// POST /student/notifications/read  →  marks stored messages as read
// ---------------------------------------------------------------------------
router.get('/notifications', async (req, res) => {
  try {
    const [subjects, attendance] = await Promise.all([
      loadSubjects(req.user.id),
      loadAttendance(req.user.id),
    ]);
    res.json(await loadNotifications(req.user.id, subjects, attendance));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/notifications/read', async (req, res) => {
  try {
    const sent = req.body && req.body.ids;
    if (Array.isArray(sent)) {
      const ids = sent.map(Number).filter(Number.isInteger);
      if (ids.length) {
        await pool.query(
          'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN (?)',
          [req.user.id, ids]
        );
      }
    } else {
      await pool.query(
        'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND (is_read = 0 OR is_read IS NULL)',
        [req.user.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;