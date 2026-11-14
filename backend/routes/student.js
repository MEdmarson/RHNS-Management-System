// routes/student.js
const router = require('express').Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('student'));

const ACTIVITIES = ['ww1','ww2','ww3','ww4','ww5','pt1','pt2','pt3','ex1','ex2','ex3'];

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function analyzeTerm(grade) {
  if (!grade) return { status: 'pending', hasAnyScore: false, missing: [], hasFinalExam: false };

  const missing = [];
  let hasAnyScore = false;
  let hasFinalExam = false;

  for (const a of ACTIVITIES) {
    const score = grade[a];
    const hps = Number(grade[`${a}_hps`]) || 0;
    const hasScore = score !== null && score !== undefined;

    // Only count as missing if HPS is set and score is blank
    if (hps > 0 && !hasScore) missing.push(a.toUpperCase());
    
    if (hasScore) hasAnyScore = true;
    
    // Check if the Final Exam (ex3 / TE) has been taken
    if (a === 'ex3' && hasScore) hasFinalExam = true;
  }

  let status;
  // Only mark as INC if they missed 3 or more activities
  if (missing.length >= 3) {
    status = 'inc';
  } else if (hasAnyScore && hasFinalExam) {
    status = 'graded'; // Term is done
  } else if (hasAnyScore) {
    status = 'in-progress'; // Currently taking it
  } else {
    status = 'pending'; // Not started
  }

  return { status, hasAnyScore, missing, hasFinalExam };
}

function qualitativeFromTerm(analysis, termGrade) {
  if (analysis.status === 'inc')          return 'INC / Not Submitted';
  if (analysis.status === 'pending')      return '—';
  if (analysis.status === 'in-progress')  return 'In Progress';
  if (termGrade && termGrade >= 75)       return 'Passed';
  if (termGrade && termGrade > 0)         return 'Failed';
  return '—';
}

// ---------------------------------------------------------------------------
// GET /student/subjects — Active + Past + per-term status
// ---------------------------------------------------------------------------
router.get('/subjects', async (req, res) => {
  try {
    const [subjects] = await pool.query(`
      SELECT sub.id        AS subject_id,
             sub.name      AS subject,
             t.full_name   AS teacher,
             s.grade_level AS grade_level
      FROM subjects sub
      JOIN students s ON s.section_id = sub.section_id
      JOIN users t    ON t.id = sub.teacher_id
      WHERE s.user_id = ?
      ORDER BY sub.name
    `, [req.user.id]);

    const [grades] = await pool.query(`
      SELECT g.*
      FROM grades g
      JOIN subjects sub ON sub.id = g.subject_id
      JOIN students s   ON s.section_id = sub.section_id
      WHERE s.user_id = ? AND g.student_id = ?
    `, [req.user.id, req.user.id]);

    const bySubject = {};
    for (const g of grades) {
      (bySubject[g.subject_id] ||= []).push(g);
    }

    const showRaw = process.env.STUDENT_SHOW_RAW === 'false';

    const out = subjects.map(sub => {
      const gs = bySubject[sub.subject_id] || [];

      const termGrades = {};
      const termStatus = {};
      const termMissing = {};

      for (const term of [1, 2, 3]) {
        const g = gs.find(x => Number(x.term) === term);
        const analysis = analyzeTerm(g);
        termMissing[term] = analysis.missing;

        if (g && g.term_grade !== null && Number(g.term_grade) > 0) {
          // Only apply the grade and status if the term is fully completed
          if (analysis.status === 'graded') {
            termGrades[term] = Number(g.term_grade);
            termStatus[term] = termGrades[term] >= 75 ? 'Passed' : 'Failed';
          } else if (analysis.status === 'inc') {
            termStatus[term] = 'inc';
          } else {
            termStatus[term] = 'in-progress'; 
          }
        } else {
          termStatus[term] = analysis.status === 'inc' ? 'inc' : 'in-progress';
        }
      }

      const gradedTerms = [1,2,3].filter(t => termStatus[t] === 'Passed' || termStatus[t] === 'Failed');
      const incTerms    = [1,2,3].filter(t => termStatus[t] === 'inc');

      const gradeValues = gradedTerms.map(t => termGrades[t]).filter(v => v > 0);
      const finalGrade = gradeValues.length
        ? Math.round(gradeValues.reduce((a, b) => a + b, 0) / gradeValues.length)
        : null;

      const isCompleted = gradedTerms.length === 3 && incTerms.length === 0;

      let status;
      if (incTerms.length > 0)          status = 'INC / Not Submitted';
      else if (isCompleted)             status = finalGrade >= 75 ? 'Passed' : 'Failed';
      else if (gradedTerms.length > 0)  status = 'In Progress';
      else                              status = 'Not Started';

      return {
        subject_id:  sub.subject_id,
        subject:     sub.subject,
        teacher:     sub.teacher,
        grade_level: sub.grade_level,

        term1: showRaw ? (termGrades[1] ?? null) : null,
        term2: showRaw ? (termGrades[2] ?? null) : null,
        term3: showRaw ? (termGrades[3] ?? null) : null,

        term_status:  termStatus,
        term_missing: termMissing,

        term_grade: finalGrade,
        status,
        is_active:  !isCompleted,
        has_inc:    incTerms.length > 0,
      };
    });

    res.json(out);
  } catch (err) {
    console.error('Student Subjects Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /student/subjects/:subjectId/details
// ---------------------------------------------------------------------------
router.get('/subjects/:subjectId/details', async (req, res) => {
  const { subjectId } = req.params;
  try {
    const [authCheck] = await pool.query(`
      SELECT 1 FROM subjects sub
      JOIN students s ON s.section_id = sub.section_id
      WHERE sub.id = ? AND s.user_id = ?
    `, [subjectId, req.user.id]);

    if (!authCheck.length) return res.status(403).json({ error: 'Unauthorized' });

    const [grades] = await pool.query(`
      SELECT * FROM grades
      WHERE subject_id = ? AND student_id = ?
      ORDER BY term ASC
    `, [subjectId, req.user.id]);

    const showRaw = process.env.STUDENT_SHOW_RAW === 'true';

    const result = grades.map(g => {
      const analysis = analyzeTerm(g);
      const termGrade = Number(g.term_grade) || 0;
      const qualitative = qualitativeFromTerm(analysis, termGrade);

      const activities = ACTIVITIES.map(a => ({
        field:   a,
        score:   g[a],
        hps:     Number(g[`${a}_hps`]) || 0,
        missing: Number(g[`${a}_hps`]) > 0 && (g[a] === null || g[a] === undefined),
      }));

      return {
        term:               g.term,
        activities:         showRaw ? activities : undefined, 
        initial_grade:      showRaw ? g.initial_grade : undefined,
        term_grade:         showRaw ? g.term_grade : undefined,
        descriptor:         g.descriptor,
        qualitative,
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
    const [subjects] = await pool.query(`
      SELECT sub.id AS subject_id FROM subjects sub
      JOIN students s ON s.section_id = sub.section_id
      WHERE s.user_id = ?
    `, [req.user.id]);

    const [grades] = await pool.query(`
      SELECT g.* FROM grades g
      JOIN subjects sub ON sub.id = g.subject_id
      JOIN students s   ON s.section_id = sub.section_id
      WHERE s.user_id = ? AND g.student_id = ?
    `, [req.user.id, req.user.id]);

    const bySubject = {};
    for (const g of grades) (bySubject[g.subject_id] ||= []).push(g);

    let completed = 0, passed = 0, failed = 0, inc = 0, inProgress = 0, notStarted = 0;

    for (const sub of subjects) {
      const gs = bySubject[sub.subject_id] || [];
      const statuses = [1,2,3].map(t => analyzeTerm(gs.find(x => Number(x.term) === t)).status);
      const gradedTerms = statuses.filter(s => s === 'graded');
      const incTerms    = statuses.filter(s => s === 'inc');

      if (incTerms.length > 0) {
        inc++;
        continue;
      }

      if (gradedTerms.length === 3) {
        completed++;
        const vals = gs.map(g => Number(g.term_grade) || 0).filter(v => v > 0);
        const final = vals.length ? Math.round(vals.reduce((a,b) => a+b, 0) / vals.length) : 0;
        if (final >= 75) passed++; else failed++;
      } else if (gradedTerms.length > 0) {
        inProgress++;
      } else {
        notStarted++;
      }
    }

    const total = subjects.length;
    let promotionStatus = 'In Progress';
    if (failed > 0)                                 promotionStatus = 'For Remediation';
    else if (inc > 0)                               promotionStatus = 'Pending Requirements';
    else if (total > 0 && completed === total)      promotionStatus = 'Cleared for Promotion / Graduation';

    res.json({
      total, completed, passed, failed, inc, inProgress, notStarted, promotionStatus,
      pctComplete: total ? Math.round((completed / total) * 100) : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /student/attendance
// ---------------------------------------------------------------------------
router.get('/attendance', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT COALESCE(SUM(status='present'), 0) AS present,
             COALESCE(SUM(status='absent'),  0) AS absent,
             COALESCE(SUM(status='late'),    0) AS late
      FROM attendance WHERE student_id = ?
    `, [req.user.id]);
    res.json(rows[0] || { present: 0, absent: 0, late: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /student/notifications
// ---------------------------------------------------------------------------
router.get('/notifications', async (req, res) => {
  try {
    const [stored] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );

    const [grades] = await pool.query(`
      SELECT g.*, sub.name AS subject_name
      FROM grades g
      JOIN subjects sub ON sub.id = g.subject_id
      JOIN students s   ON s.section_id = sub.section_id
      WHERE s.user_id = ? AND g.student_id = ?
    `, [req.user.id, req.user.id]);

    const virtual = [];
    const seen = new Set();
    for (const g of grades) {
      const analysis = analyzeTerm(g);
      if (analysis.missing.length === 0) continue;
      const key = `${g.subject_id}:${g.term}`;
      if (seen.has(key)) continue;
      seen.add(key);

      virtual.push({
        id:         `inc-${g.subject_id}-${g.term}`,
        type:       'warning',
        title:      `Missing: ${g.subject_name} (Term ${g.term})`,
        body:       `Unsubmitted activities: ${analysis.missing.join(', ')}`,
        created_at: new Date().toISOString(),
        is_read:    false,
      });
    }

    res.json([...virtual, ...stored]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;