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

// `given` = { [term]: { ww1: n, ... } } where n is how many classmates have a score
// for that activity. An activity with a max score that classmates already have
// scores for, but the student does not, counts as MISSED even before the term closes.
function summarizeSubject(sub, gs, given = {}) {
  const raw = showRaw();
  const finished = sub.subject_status === 'finished';

  const terms = {};
  for (const t of TERMS) terms[t] = termSummary(gs.find(x => Number(x.term) === t), finished);

  // Missed in a term that is still open (closed terms are already reported as overdue)
  const missedIn = t => finished ? [] : terms[t].missing.filter(m =>
    !terms[t].overdue.includes(m) && (Number(given[t]?.[m.toLowerCase()]) || 0) > 0);

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
    term_missed:  Object.fromEntries(TERMS.map(t => [t, missedIn(t)])),

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

  // How many classmates already have a score for each activity (tells us it was actually given)
  const [givenRows] = await pool.query(`
    SELECT g.subject_id, g.term,
           ${ACTIVITIES.map(a => `COALESCE(SUM(g.${a} IS NOT NULL), 0) AS ${a}`).join(', ')}
    FROM grades g
    JOIN subjects sub ON sub.id = g.subject_id
    JOIN students me  ON me.section_id = sub.section_id AND me.user_id = ?
    WHERE g.student_id <> ?
    GROUP BY g.subject_id, g.term
  `, [userId, userId]);

  const givenBySubject = {};
  for (const r of givenRows) (givenBySubject[r.subject_id] ||= {})[Number(r.term)] = r;

  const bySubject = {};
  for (const g of grades) (bySubject[g.subject_id] ||= []).push(g);

  return subjects.map(sub => summarizeSubject(sub, bySubject[sub.subject_id] || [], givenBySubject[sub.subject_id] || {}));
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
//
// Each alert carries the details the Alerts tab shows:
//   category  : 'inc' | 'missing' | 'failing' | 'target' | 'attendance'
//   subject_id, subject, terms[]   -> chips + "View subject" button
//   items[]   -> missing activities (WW1, PT2 ...) shown as chips
//   facts[]   -> short supporting lines (grade vs passing, absences used ...)
//   action    -> { label, view, subject_id? } for the button / dashboard link
function buildAlerts(list, att) {
  const alerts = [];
  const add = a => alerts.push({ source: 'system', created_at: null, terms: [], items: [], facts: [], ...a });

  for (const s of list) {
    const ctx = { subject_id: s.subject_id, subject: s.subject };
    const open = { label: 'View subject', view: 'subjects', subject_id: s.subject_id };
    const incTerms = TERMS.filter(t => s.term_status[t] === 'inc');

    if (s.finished_by_teacher && incTerms.length) {
      add({
        ...ctx, id: `inc-fin-${s.subject_id}`, sig: incTerms.join(','), type: 'error', category: 'inc',
        title: `INC: ${s.subject} (${incTerms.length > 1 ? 'Terms' : 'Term'} ${incTerms.join(', ')})`,
        body: `This subject is already marked finished, so requirements are settled in person. Approach ${s.teacher} and ask how to clear your INC.`,
        terms: incTerms,
        facts: [`Teacher: ${s.teacher}`],
        action: open,
      });
    }

    for (const t of TERMS) {
      const overdue = s.term_overdue[t] || [];
      const missed  = s.term_missed?.[t] || [];
      const st = s.term_status[t];

      // Activity already given to the class, but nothing is recorded for this student
      if (missed.length) {
        add({
          ...ctx, id: `missed-${s.subject_id}-${t}`, sig: missed.join(','),
          type: 'warning', category: 'missed',
          title: `Missed activity: ${s.subject} (Term ${t})`,
          body: `Your teacher has recorded scores for ${missed.join(', ')}, but nothing is recorded for you yet. ` +
                `Submit it or ask ${s.teacher} about a make-up so it does not become an INC.`,
          terms: [t], items: missed,
          facts: [`Teacher: ${s.teacher}`, `${missed.length} item${missed.length === 1 ? '' : 's'} to complete`],
          action: open,
        });
      }

      if (overdue.length) {
        add({
          ...ctx, id: `miss-${s.subject_id}-${t}`, sig: overdue.join(','),
          type: st === 'inc' ? 'error' : 'warning', category: 'missing',
          title: `Missing requirements: ${s.subject} (Term ${t})`,
          body: `You have ${overdue.length} item${overdue.length === 1 ? '' : 's'} not yet submitted. ` +
                (st === 'inc' ? 'This term stays INC until they are complete.' : 'Submit them to your teacher to avoid an INC.'),
          terms: [t], items: overdue,
          facts: [`Teacher: ${s.teacher}`],
          action: open,
        });
      }

      if (st === 'failed') {
        const g = s[`term${t}`];
        add({
          ...ctx, id: `fail-${s.subject_id}-${t}`, sig: String(g ?? 'failed'), type: 'error', category: 'failing',
          title: `Below passing: ${s.subject} (Term ${t})`,
          body: (g != null ? `Your grade is ${g}; passing is ${PASSING}. ` : `Your grade is below the passing mark of ${PASSING}. `) +
                'Ask your teacher about make-up work.',
          terms: [t],
          facts: g != null
            ? [`Your grade: ${g}`, `Passing grade: ${PASSING}`, `Short by ${PASSING - g} point${PASSING - g === 1 ? '' : 's'}`]
            : [`Passing grade: ${PASSING}`],
          action: open,
        });
      }
    }

    // Passing outlook (only exists when raw scores are visible to the student)
    if (s.target && s.target.state !== 'secured') {
      const { termsLeft, needed, state } = s.target;
      const need = termsLeft === 1
        ? `You need at least ${needed} in the last term to pass.`
        : `You need an average of at least ${needed} over the remaining ${termsLeft} terms to pass.`;
      add({
        ...ctx, id: `target-${s.subject_id}`, sig: `${state}-${needed}-${termsLeft}`,
        type: state === 'out_of_reach' ? 'error' : 'info', category: 'target',
        title: state === 'out_of_reach' ? `${s.subject}: passing is at risk` : `${s.subject}: aim for ${needed}+`,
        body: state === 'out_of_reach'
          ? 'Passing by grades alone is no longer possible. Ask your teacher about remediation.'
          : need,
        facts: [`Terms left: ${termsLeft}`, `Target: ${needed}${termsLeft > 1 ? ' average' : ''}`],
        action: open,
      });
    }
  }

  const attAction = { label: 'View attendance', view: 'attendance' };
  const attFacts = [`Absences recorded: ${att.absent}`];
  if (att.converted) attFacts.push(`${att.converted} absence(s) came from ${att.late} lates`);

  if (att.absent >= 10) {
    add({
      id: 'att-limit', sig: String(att.absent), type: att.absent >= 15 ? 'error' : 'warning', category: 'attendance',
      title: `Attendance: ${att.absent} absences recorded`,
      body: att.absent >= 15
        ? 'Your absences are very high. Talk to your adviser right away.'
        : 'Missing classes can affect your standing. Try to attend every class.',
      facts: attFacts, action: attAction,
    });
  }

  if (att.late % LATES_PER_ABSENCE === LATES_PER_ABSENCE - 1) {
    add({
      id: 'att-late', sig: String(att.late), type: 'info', category: 'attendance',
      title: 'One more late counts as an absence',
      body: `Every ${LATES_PER_ABSENCE} lates are counted as 1 absence. Arrive on time to keep your record clean.`,
      facts: [`Lates so far: ${att.late}`], action: attAction,
    });
  }

  const rank = { error: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => (rank[a.type] ?? 3) - (rank[b.type] ?? 3));
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