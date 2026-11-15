// routes/atRisk.js
// One source of truth for "at risk of failing / dropping". Used by the teacher portal
// (GET /teacher/at-risk) and the student portal (alert on GET /student/overview), so both always agree.
'use strict';

const AT_RISK = {
  PASSING_GRADE: 75,        // grade (on submitted work) below this = failing
  MISSING_WEIGHT_PCT: 20,   // missed work worth >= this many points of the term's initial grade = significant
  MISSING_COUNT: 3,         // ...or this many missed activities in the term = significant
  ABSENCE_LIMIT: 4,         // more than this many effective absences = at risk of dropping
  LATES_PER_ABSENCE: 3,     // every N lates counts as 1 absence (keep in sync with teacher-utils.js)
  WINDOW_DAYS: 30           // attendance look-back window
};

const TRANSMUTATION = [
  [99.49,100],[98.31,99],[97.13,98],[95.95,97],[94.77,96],[93.59,95],[92.41,94],[91.23,93],
  [90.05,92],[88.87,91],[87.69,90],[86.51,89],[85.33,88],[84.15,87],[82.97,86],[81.79,85],
  [80.61,84],[79.43,83],[78.25,82],[77.07,81],[75.89,80],[74.71,79],[73.53,78],[72.35,77],
  [71.17,76],[69.99,75],[65.33,74],[60.66,73],[56,72],[51.33,71],[46.66,70],[42,69],
  [37.33,68],[32.67,67],[28,66],[23.34,65],[18.67,64],[14,63],[9.34,62],[4.67,61],[0,60]
];
const transmute = (initial) => (TRANSMUTATION.find(([min]) => initial > min) || [0, 0])[1];

const SUBJECT_WEIGHTS = {
  'Academic Electives':                          [0.20, 0.50, 0.30],
  'Arts Apprenticeship':                         [0.15, 0.70, 0.15],
  'Arts, Sports, Health and Wellness Electives': [0.20, 0.60, 0.20],
  'Core Subjects':                               [0.20, 0.50, 0.30],
  'Creative Production and Innovation':          [0.15, 0.70, 0.15],
  'Design and Innovation':                       [0.40, 0.60, 0.00],
  'Field Exposure':                              [0.15, 0.70, 0.15],
  'Research Electives':                          [0.40, 0.60, 0.00],
  'TechPro Electives':                           [0.15, 0.65, 0.20],
  'Work Immersion':                              [0.20, 0.80, 0.00]
};
const isSubjectType = (t) => Object.prototype.hasOwnProperty.call(SUBJECT_WEIGHTS, t);
const weightsFor = (type) => SUBJECT_WEIGHTS[isSubjectType(type) ? type : 'Core Subjects'];

const ACTIVITIES = [
  ['ww1', 'ww', 'Written Work 1'], ['ww2', 'ww', 'Written Work 2'], ['ww3', 'ww', 'Written Work 3'],
  ['ww4', 'ww', 'Written Work 4'], ['ww5', 'ww', 'Written Work 5'],
  ['pt1', 'pt', 'Performance Task 1'], ['pt2', 'pt', 'Performance Task 2'], ['pt3', 'pt', 'Performance Task 3'],
  ['ex1', 'ex', 'Summative Assessment 1'], ['ex2', 'ex', 'Summative Assessment 2'], ['ex3', 'ex', 'Term Exam']
];
const COMP_NAMES = { ww: 'Written Work', pt: 'Performance Tasks', ex: 'Exams' };
const hasScore = (v) => v !== null && v !== undefined && v !== '';

// `given[key]` = how many students in the class already have a score for that activity.
// An activity the teacher has only planned (HPS set, nobody scored yet) is NOT counted as missed
// and does not pull the grade down - same rule the student portal already uses.
function analyzeWork(row, weights, given = {}) {
  const w = { ww: weights[0], pt: weights[1], ex: weights[2] };
  const comp = { ww: { hps: 0, got: 0, missedHps: 0 }, pt: { hps: 0, got: 0, missedHps: 0 }, ex: { hps: 0, got: 0, missedHps: 0 } };
  const missed = [];
  let total = 0;

  for (const [key, c, label] of ACTIVITIES) {
    const hps = Number(row[key + '_hps']) || 0;
    if (hps <= 0) continue;                                           // never planned
    const scored = hasScore(row[key]);
    if (!scored && !(Number(given[key]) > 0)) continue;               // planned, not given yet
    total++;
    comp[c].hps += hps;
    if (scored) comp[c].got += Number(row[key]) || 0;
    else { comp[c].missedHps += hps; missed.push({ key: key.toUpperCase(), label, hps, component: c }); }
  }

  // points of the initial grade lost if every missed activity counts as zero
  let missedWeightPct = 0;
  const components = {};
  for (const c of ['ww', 'pt', 'ex']) {
    if (comp[c].hps > 0) missedWeightPct += (comp[c].missedHps / comp[c].hps) * w[c] * 100;
    components[c] = comp[c].hps > 0 ? Math.round((comp[c].got / comp[c].hps) * 1000) / 10 : null;
  }
  missedWeightPct = Math.round(missedWeightPct * 10) / 10;

  const significant = missed.length > 0 &&
    (missedWeightPct >= AT_RISK.MISSING_WEIGHT_PCT || missed.length >= AT_RISK.MISSING_COUNT);

  // Grade on SUBMITTED work: only activities that were handed in count, and the weights are spread over the
  // components that have real scores. Missing work is judged separately by the "significant" rule above.
  let wsum = 0, wscore = 0;
  for (const c of ['ww', 'pt', 'ex']) {
    const handedHps = comp[c].hps - comp[c].missedHps;
    if (handedHps > 0 && w[c] > 0) { wsum += w[c]; wscore += (comp[c].got / handedHps) * 100 * w[c]; }
  }
  const workInitial = wsum > 0 ? wscore / wsum : null;
  const workGrade = workInitial === null ? null : (workInitial === 0 ? 0 : transmute(workInitial));

  let weakest = null;
  for (const c of ['ww', 'pt', 'ex']) {
    if (components[c] !== null && comp[c].got > 0 && (weakest === null || components[c] < components[weakest])) weakest = c;
  }

  return {
    missed, total, missedWeightPct, significant, components, workGrade,
    weakest: weakest ? { key: weakest, name: COMP_NAMES[weakest], pct: components[weakest] } : null
  };
}

// terms = { [term]: { [studentId]: gradeRow } } for ONE subject (every student in the class).
// The "current" term is the latest one where somebody has actually been scored.
function currentTermInfo(terms) {
  const live = Object.keys(terms).map(Number)
    .filter(t => Object.values(terms[t]).some(r => ACTIVITIES.some(([k]) => hasScore(r[k]))))
    .sort((a, b) => a - b);
  if (!live.length) return null;
  const current = live[live.length - 1];
  const rows = Object.values(terms[current]);
  const hpsOf = (r) => ACTIVITIES.reduce((s, [k]) => s + (Number(r[k + '_hps']) || 0), 0);
  const hpsRow = rows.slice().sort((a, b) => hpsOf(b) - hpsOf(a))[0];       // HPS is the same for the whole class
  const given = {};
  for (const [k] of ACTIVITIES) given[k] = rows.filter(r => hasScore(r[k])).length;
  return { current, hpsRow, given };
}

// Returns the "failing" entry for one student in one subject, or null if they are fine.
function evaluateSubject(sub, terms, studentId, weights) {
  const info = currentTermInfo(terms);
  if (!info) return null;                                                    // nothing scored in this subject yet

  const own = terms[info.current][studentId] || {};
  const row = {};
  for (const [k] of ACTIVITIES) { row[k] = hasScore(own[k]) ? own[k] : null; row[k + '_hps'] = info.hpsRow[k + '_hps']; }

  const t = analyzeWork(row, weights, info.given);
  const grade = t.workGrade;                                                 // grade on work actually handed in
  const lowGrade = grade !== null && grade < AT_RISK.PASSING_GRADE;
  if (!lowGrade && !t.significant) return null;                              // one or two missed activities alone do not tag a student

  const previous = Object.keys(terms).map(Number).filter(n => n < info.current).sort((a, b) => a - b)
    .map(n => { const pr = terms[n][studentId]; return pr && hasScore(pr.term_grade) ? { term: n, grade: Number(pr.term_grade) } : null; })
    .filter(Boolean);

  return {
    subject_id: sub.id, subject: sub.name, term: info.current,
    term_grade: grade,
    recorded_grade: hasScore(own.term_grade) ? Number(own.term_grade) : null,    // what the class record shows
    initial_grade: hasScore(own.initial_grade) ? Number(own.initial_grade) : null,
    low_grade: lowGrade,
    missing: { count: t.missed.length, total: t.total, weight_pct: t.missedWeightPct, significant: t.significant, items: t.missed },
    components: t.components,
    weakest: t.weakest,
    previous,
    cause: lowGrade && t.significant ? 'both' : lowGrade ? 'scores' : 'missing'
  };
}

// DATE columns come back as Date objects at local midnight - format with local parts (toISOString shifts a day in UTC+8)
function fmtDate(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// recs = [{ date, status }] for the look-back window, oldest first. Returns the "dropping" entry or null.
function evaluateAttendance(recs) {
  if (!recs || !recs.length) return null;
  const count = (s) => recs.filter(r => r.status === s).length;
  const absent = count('absent'), late = count('late'), excused = count('excused'), present = count('present');
  const converted = Math.floor(late / AT_RISK.LATES_PER_ABSENCE);
  const effective = absent + converted;
  if (effective <= AT_RISK.ABSENCE_LIMIT) return null;

  let streak = 0;
  for (let i = recs.length - 1; i >= 0 && recs[i].status === 'absent'; i--) streak++;
  return {
    effective_absences: effective, absent, late, excused, present, converted,
    recorded_days: recs.length,
    absence_rate: Math.round((effective / recs.length) * 100),
    streak,
    recent_absences: recs.filter(r => r.status === 'absent').slice(-5).map(r => fmtDate(r.date)),
    window_days: AT_RISK.WINDOW_DAYS
  };
}

function severityOf(failing, dropping) {
  const severe = failing.some(f => f.cause === 'both' || (f.term_grade !== null && f.term_grade < 70)) ||
                 (failing.length > 0 && !!dropping) || (!!dropping && dropping.streak >= 3);
  return severe ? 'high' : 'medium';
}

module.exports = { AT_RISK, ACTIVITIES, SUBJECT_WEIGHTS, isSubjectType, weightsFor, analyzeWork, currentTermInfo, evaluateSubject, evaluateAttendance, severityOf, fmtDate };