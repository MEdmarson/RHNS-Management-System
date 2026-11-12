// routes/classRecordExport.js
//
// Exports a DepEd class record that matches templates/class_record_template.xlsx
// (the "11 MAGALANG PKLP ECR" file): logos, merged header, borders, dropdowns,
// conditional formatting, TERM 1-3, FINAL GRADE and the proficiency profile block.
//
// How it works: the template is loaded, the header block (rows 1-16) is kept as-is,
// and everything from the "MALE" row downwards is rebuilt for the real class size,
// re-using the template's own cell styles.  All the planning is done by pure
// functions (planTermSheet / planFinalSheet) so it can be unit-tested; applyPlan()
// is the only part that touches ExcelJS.
const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, authorize('teacher'));

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'class_record_template.xlsx');
const ASSET_DIR = path.join(__dirname, '..', 'assets');

/* ==========================================================================
   CONSTANTS
   ========================================================================== */
const TRANSMUTATION = [
  [99.49,100],[98.31,99],[97.13,98],[95.95,97],[94.77,96],[93.59,95],[92.41,94],[91.23,93],
  [90.05,92],[88.87,91],[87.69,90],[86.51,89],[85.33,88],[84.15,87],[82.97,86],[81.79,85],
  [80.61,84],[79.43,83],[78.25,82],[77.07,81],[75.89,80],[74.71,79],[73.53,78],[72.35,77],
  [71.17,76],[69.99,75],[65.33,74],[60.66,73],[56,72],[51.33,71],[46.66,70],[42,69],
  [37.33,68],[32.67,67],[28,66],[23.34,65],[18.67,64],[14,63],[9.34,62],[4.67,61]
];

const SUBJECT_WEIGHTS = {
  'Academic Electives': 1, 'Arts Apprenticeship': 1, 'Arts, Sports, Health and Wellness Electives': 1,
  'Core Subjects': 1, 'Creative Production and Innovation': 1, 'Design and Innovation': 1,
  'Field Exposure': 1, 'Research Electives': 1, 'TechPro Electives': 1, 'Work Immersion': 1
}; // names only: the weights themselves live in the template's hidden "Sheet2"

const ACTIVITIES = ['ww1','ww2','ww3','ww4','ww5','pt1','pt2','pt3','ex1','ex2','ex3'];
const SCORE_COL = { ww1:3, ww2:4, ww3:5, ww4:6, ww5:7, pt1:11, pt2:12, pt3:13, ex1:17, ex2:18, ex3:19 };
const HPS_COL = SCORE_COL; // row 15 uses the same columns as the scores
const TERM_LABEL = { 1: 'FIRST TERM', 2: 'SECOND TERM', 3: 'THIRD TERM' };
const TERM_MAX_COL = 25;   // A..Y
const FINAL_MAX_COL = 10;  // A..J

const LEVELS = [
  ['Advancing (A)', 'Advancing'], ['Benchmarking (B)', 'Benchmarking'], ['Connecting (C) ', 'Connecting'],
  ['Developing (D)', 'Developing'], ['Emerging (E) ', 'Emerging']
];

/* ==========================================================================
   FORMULA BUILDERS  (copied from the template, one row at a time)
   ========================================================================== */
function transmutationFormula(w) {
  let f = `IF(${w}>0,60,IF(${w}=0,0))`;
  for (let i = TRANSMUTATION.length - 1; i >= 0; i--) {
    const [min, grade] = TRANSMUTATION[i];
    f = `IF(${w}>${min},${grade},${f})`;
  }
  return `IF(${w}=" "," ",${f})`;
}
const descriptorFormula = x =>
  `IF(${x}=" "," ",IF(${x}>89,"Advancing",IF(${x}>79,"Benchmarking",IF(${x}>74,"Connecting",IF(${x}>64,"Developing",IF(${x}>0,"Emerging",0))))))`;

const F = fm => ({ formula: fm });

function termStudentRow(r, number, student) {
  const cells = {};
  if (student) {
    cells[1] = number;
    cells[2] = student.name;
    ACTIVITIES.forEach(a => {
      const v = student.scores ? student.scores[a] : null;
      if (v !== null && v !== undefined) cells[SCORE_COL[a]] = v;
    });
  }
  cells[8]  = F(`SUM(C${r}:G${r})`);
  cells[9]  = F(`IF(OR(H${r}=0)," ",H${r}/$H$15*100)`);
  cells[10] = F(`IFERROR(IF(OR(H${r}=" ")," ",I${r}*$C$13)," ")`);
  cells[14] = F(`SUM(K${r}:M${r})`);
  cells[15] = F(`IF(OR(N${r}=0)," ",N${r}/$N$15*100)`);
  cells[16] = F(`IFERROR(O${r}*$K$13," ")`);
  cells[20] = F(`SUM(Q${r}:S${r})`);
  cells[21] = F(`IF(OR(T${r}=0)," ",T${r}/$T$15*100)`);
  cells[22] = F(`IFERROR(U${r}*$Q$13," ")`);
  cells[23] = F(`IF(OR(J${r}=0,P${r}=0)," ",SUM(J${r},P${r},V${r}))`);
  cells[24] = F(transmutationFormula(`W${r}`));
  cells[25] = F(descriptorFormula(`X${r}`));
  return cells;
}

/* ==========================================================================
   LAYOUT PLANS  (pure — no ExcelJS in here)
   ========================================================================== */
function layoutTerm(nMale, nFemale) {
  const male = Math.max(nMale, 1), female = Math.max(nFemale, 1); // an empty block keeps one blank row
  const maleLabel = 17, maleFirst = 18, maleLast = 17 + male;
  const femaleLabel = maleLast + 1, femaleFirst = femaleLabel + 1, femaleLast = femaleLabel + female;
  const footer = femaleLast + 1;
  return { maleLabel, maleFirst, maleLast, femaleLabel, femaleFirst, femaleLast, footer, lastRow: footer + 10 };
}

function planTermSheet(males, females) {
  const L = layoutTerm(males.length, females.length);
  const rows = [];
  const merges = [`A${L.maleLabel}:B${L.maleLabel}`];

  rows.push({ row: L.maleLabel, style: 'maleLabel', cells: { 1: 'MALE' } });
  for (let r = L.maleFirst; r <= L.maleLast; r++) {
    const i = r - L.maleFirst;
    rows.push({ row: r, style: 'male', cells: termStudentRow(r, i + 1, males[i]) });
  }
  rows.push({ row: L.femaleLabel, style: 'femaleLabel', cells: { 1: 'FEMALE' } });
  for (let r = L.femaleFirst; r <= L.femaleLast; r++) {
    const i = r - L.femaleFirst;
    rows.push({ row: r, style: 'female', cells: termStudentRow(r, i + 1, females[i]) });
  }

  // ---- footer: signatures + performance profile (template rows 66-76) ----
  const f = L.footer;
  const mR = `$Y$${L.maleFirst}:$Y$${L.maleLast}`;
  const fR = `$Y$${L.femaleFirst}:$Y$${L.femaleLast}`;
  const a = f + 6, e = f + 10; // first / last proficiency-level row

  const footerCells = Array.from({ length: 11 }, () => ({}));
  footerCells[0] = { 1: 'Prepared by:', 6: 'Checked by:', 20: 'Approved:' };
  footerCells[1] = { 2: F('P10'), 9: 'CONRADO C. AREOLA JR.', 22: 'ROWENA LEA G. MORENO' };
  footerCells[2] = { 2: 'Subject Teacher', 9: 'SHS OIC Assistant Principal', 22: 'Principal IV' };
  footerCells[4] = { 2: "STUDENTS' PERFORMANCE PROFILE" };
  footerCells[5] = { 2: 'LEVEL OF PROFICIENCY', 3: 'MALE', 5: '%', 7: 'FEMALE', 9: '%', 10: 'TOTAL', 11: '%', 17: 'BASIC STATISTICS' };
  LEVELS.forEach(([label, key], i) => {
    const r = a + i;
    footerCells[6 + i] = {
      2: label,
      3: F(`COUNTIF(${mR},"${key}")`),
      5: F(`IFERROR(C${r}/SUM($C$${a}:$C$${e})*100," ")`),
      7: F(`COUNTIF(${fR},"${key}")`),
      9: F(`IFERROR(G${r}/SUM($G$${a}:$G$${e})*100," ")`),
      10: F(`SUM(C${r},G${r})`),
      11: F(`IFERROR(J${r}/SUM($J$${a}:$J$${e})*100," ")`)
    };
  });
  Object.assign(footerCells[6], { 16: 'EXAMS', 17: 'SA1', 18: 'SA2', 19: 'TE', 20: 'PASSED', 21: F(`SUM(J${a}:J${a + 2})`) });
  Object.assign(footerCells[7], {
    16: 'MEAN', 20: 'FAILED', 21: F(`SUM(J${a + 3}:J${e})`),
    17: F(`IFERROR(AVERAGE(Q${L.maleFirst}:Q${L.femaleLast})," ")`),
    18: F(`IFERROR(AVERAGE(R${L.maleFirst}:R${L.femaleLast})," ")`),
    19: F(`IFERROR(AVERAGE(S${L.maleFirst}:S${L.femaleLast})," ")`)
  });
  Object.assign(footerCells[8], {
    16: 'MPS',
    17: F(`IFERROR(Q${f + 7}/Q15," ")`), 18: F(`IFERROR(R${f + 7}/R15," ")`), 19: F(`IFERROR(S${f + 7}/S15," ")`)
  });
  footerCells.forEach((cells, i) => rows.push({ row: f + i, style: `footer${i}`, cells }));

  merges.push(`I${f + 1}:N${f + 1}`, `V${f + 1}:Y${f + 1}`, `I${f + 2}:N${f + 2}`, `V${f + 2}:Y${f + 2}`, `B${f + 4}:L${f + 4}`);
  for (let r = f + 5; r <= f + 10; r++) merges.push(`C${r}:D${r}`, `E${r}:F${r}`, `G${r}:H${r}`, `K${r}:L${r}`);

  return {
    layout: L, rows, merges,
    clearFrom: 17, clearTo: Math.max(76, L.lastRow), maxCol: TERM_MAX_COL,
    scoreRanges: [[L.maleFirst, L.maleLast], [L.femaleFirst, L.femaleLast]],
    printArea: `A1:Y${L.lastRow}`
  };
}

function layoutFinal(nMale, nFemale) {
  const male = Math.max(nMale, 1), female = Math.max(nFemale, 1);
  const maleLabel = 13, maleFirst = 14, maleLast = 13 + male;
  const femaleLabel = maleLast + 1, femaleFirst = femaleLabel + 1, femaleLast = femaleLabel + female;
  const footer = femaleLast + 3;               // the template leaves two spare rows before the signatures
  return { maleLabel, maleFirst, maleLast, femaleLabel, femaleFirst, femaleLast, spare: [femaleLast + 1, femaleLast + 2], footer, lastRow: footer + 6 };
}

function planFinalSheet(males, females, termLayout) {
  const L = layoutFinal(males.length, females.length);
  const T = termLayout;
  const rows = [];
  const merges = [`A${L.maleLabel}:J${L.maleLabel}`];
  const q = s => `'TERM ${s}'`;

  const studentRow = (r, termRow, number, hasStudent) => {
    const cells = {};
    if (hasStudent) {
      cells[1] = number;
      cells[2] = F(`${q(1)}!B${termRow}`);
      [1, 2, 3].forEach((t, i) => { cells[5 + i] = F(`IF(${q(t)}!X${termRow}=0,"",${q(t)}!X${termRow})`); });
      cells[8]  = F(`IFERROR(ROUND(AVERAGE(E${r}:G${r}),0),"")`);
      cells[9]  = F(`IF(H${r}="","",IF(H${r}>89,"Advancing",IF(H${r}>79,"Benchmarking",IF(H${r}>74,"Connecting",IF(H${r}>64,"Developing",IF(H${r}>0,"Emerging",0))))))`);
      cells[10] = F(`IF(H${r}="","",IF(H${r}>=75,"PASSED","FAILED"))`);
    }
    return cells;
  };

  rows.push({ row: L.maleLabel, style: 'maleLabel', cells: { 1: 'MALE' } });
  for (let r = L.maleFirst; r <= L.maleLast; r++) {
    const i = r - L.maleFirst;
    rows.push({ row: r, style: 'male', cells: studentRow(r, T.maleFirst + i, i + 1, i < males.length) });
    merges.push(`B${r}:D${r}`);
  }
  rows.push({ row: L.femaleLabel, style: 'femaleLabel', cells: { 1: 'FEMALE' } });
  for (let r = L.femaleFirst; r <= L.femaleLast; r++) {
    const i = r - L.femaleFirst;
    rows.push({ row: r, style: 'female', cells: studentRow(r, T.femaleFirst + i, i + 1, i < females.length) });
    merges.push(`B${r}:D${r}`);
  }
  L.spare.forEach(r => { rows.push({ row: r, style: 'spare', cells: {} }); merges.push(`B${r}:D${r}`); });

  const f = L.footer, tf = T.footer;
  const footerCells = Array.from({ length: 7 }, () => ({}));
  footerCells[0] = { 1: 'Prepared by:', 6: 'Checked by:', 9: 'Noted:' };
  footerCells[1] = { 2: F(`${q(1)}!P10`), 7: F(`${q(1)}!I${tf + 1}`), 9: F(`${q(1)}!V${tf + 1}`) };
  footerCells[2] = { 2: F(`${q(1)}!B${tf + 2}`), 7: F(`${q(1)}!I${tf + 2}`), 9: F(`${q(1)}!V${tf + 2}`) };
  footerCells.forEach((cells, i) => rows.push({ row: f + i, style: `footer${i}`, cells }));
  [f + 1, f + 2].forEach(r => merges.push(`B${r}:D${r}`, `G${r}:H${r}`, `I${r}:J${r}`));

  return { layout: L, rows, merges, clearFrom: 13, clearTo: Math.max(70, L.lastRow), maxCol: FINAL_MAX_COL, printArea: `A1:J${L.lastRow}` };
}

/* template rows whose styles are cloned for each kind of row */
const TERM_STYLE_ROWS  = { maleLabel: 17, male: 18, femaleLabel: 38, female: 39,
  footer0: 66, footer1: 67, footer2: 68, footer3: 69, footer4: 70, footer5: 71, footer6: 72, footer7: 73, footer8: 74, footer9: 75, footer10: 76 };
const FINAL_STYLE_ROWS = { maleLabel: 13, male: 14, femaleLabel: 34, female: 36, spare: 62,
  footer0: 64, footer1: 65, footer2: 66, footer3: 67, footer4: 68, footer5: 69, footer6: 70 };

/* ==========================================================================
   DATA
   ========================================================================== */
const parseJson = v => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch { return {}; }
};
const num = v => (v === null || v === undefined || v === '') ? null : Number(v);

function normalizeGender(g) {
  const v = String(g || '').trim().toLowerCase();
  return (v === 'female' || v === 'f') ? 'female' : 'male';
}

/** NS (not submitted) is exported as 0. EX (excused) and blank stay empty. */
function scoresOf(row) {
  const status = parseJson(row.activity_status);
  const scores = {};
  ACTIVITIES.forEach(a => {
    scores[a] = status[a] === 'NS' ? 0 : (status[a] === 'EX' ? null : num(row[a]));
  });
  return scores;
}

function hpsOf(rows) {
  const ref = rows.find(r => r.ww1_hps !== null && r.ww1_hps !== undefined);
  const out = {};
  ACTIVITIES.forEach(a => {
    const v = ref ? num(ref[`${a}_hps`]) : null;
    out[a] = v && v > 0 ? v : null;      // unused columns stay blank, like the template
  });
  return out;
}

async function fetchTermRows(teacherId, subjectId, term) {
  const base = `
    SELECT u.id AS student_id, u.full_name, s.lrn, s.gender,
           g.ww1, g.ww2, g.ww3, g.ww4, g.ww5, g.pt1, g.pt2, g.pt3, g.ex1, g.ex2, g.ex3,
           g.ww1_hps, g.ww2_hps, g.ww3_hps, g.ww4_hps, g.ww5_hps,
           g.pt1_hps, g.pt2_hps, g.pt3_hps, g.ex1_hps, g.ex2_hps, g.ex3_hps`;
  const from = `
    FROM subjects sub
    JOIN sections sec ON sec.id = sub.section_id
    JOIN students s   ON s.section_id = sec.id
    JOIN users u      ON u.id = s.user_id
    LEFT JOIN grades g ON g.student_id = u.id AND g.subject_id = sub.id AND g.term = ?
    WHERE sub.teacher_id = ? AND sub.id = ?
    ORDER BY u.full_name`;
  try {
    const [rows] = await pool.query(base + ', g.activity_status' + from, [term, teacherId, subjectId]);
    return rows;
  } catch (err) {
    if (err && err.code === 'ER_BAD_FIELD_ERROR') {          // migration.sql not run yet
      const [rows] = await pool.query(base + from, [term, teacherId, subjectId]);
      return rows;
    }
    throw err;
  }
}

async function fetchMeta(teacherId, subjectId) {
  const [[meta]] = await pool.query(`
    SELECT sub.name AS subject_name, sec.name AS section, u.full_name AS teacher_name
    FROM subjects sub
    JOIN sections sec ON sec.id = sub.section_id
    JOIN users u      ON u.id = sub.teacher_id
    WHERE sub.teacher_id = ? AND sub.id = ?`, [teacherId, subjectId]);
  return meta;
}

const cleanText = s => String(s || '').replace(/\s+/g, ' ').trim();
function gradeLevelOf(section, override) {
  if (override && /^\d{1,2}$/.test(String(override))) return Number(override);
  const m = String(section || '').match(/(?:^|\D)(1[0-2]|[7-9])(?!\d)/);
  return m ? Number(m[1]) : 11;
}

/** roster (from term 1) split by gender; every term uses the same order so rows line up across sheets */
function splitRoster(rows) {
  const males = [], females = [];
  rows.forEach(r => (normalizeGender(r.gender) === 'female' ? females : males).push(r));
  return { males, females };
}

/* ==========================================================================
   EXCELJS GLUE
   ========================================================================== */
const cloneStyle = s => (s ? JSON.parse(JSON.stringify(s)) : {});

function snapshotStyles(ws, styleRows, maxCol) {
  const snaps = {};
  for (const [key, r] of Object.entries(styleRows)) {
    const row = ws.getRow(r);
    snaps[key] = Array.from({ length: maxCol }, (_, i) => cloneStyle(row.getCell(i + 1).style));
  }
  return snaps;
}

function clearBelow(ws, fromRow, toRow, maxCol) {
  ws.model.merges.slice().forEach(range => {
    const top = parseInt(range.match(/\d+/)[0], 10);
    if (top >= fromRow) ws.unMergeCells(range);
  });
  for (let r = fromRow; r <= toRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= maxCol; c++) { const cell = row.getCell(c); cell.value = null; cell.style = {}; }
  }
  const dv = ws.dataValidations && ws.dataValidations.model;
  if (dv) Object.keys(dv).forEach(addr => { if (parseInt(addr.replace(/[A-Z]+/, ''), 10) >= fromRow) delete dv[addr]; });
}

function applyPlan(ws, plan, snaps) {
  for (const row of plan.rows) {
    const wr = ws.getRow(row.row);
    const snap = snaps[row.style];
    for (let c = 1; c <= plan.maxCol; c++) wr.getCell(c).style = cloneStyle(snap[c - 1]);
    for (const [c, v] of Object.entries(row.cells)) wr.getCell(Number(c)).value = v;
  }
  plan.merges.forEach(m => ws.mergeCells(m));
  ws.pageSetup.printArea = plan.printArea;
}

function fillTermHeader(ws, term, ctx) {
  const { meta, subjectType, gradeLevel, hps } = ctx;
  ws.getCell('A1').value = `CLASS RECORD - TERM ${term}`;
  ws.getCell('A10').value = TERM_LABEL[term];

  if (term === 1) {
    ws.getCell('H10').value = gradeLevel;
    ws.getCell('P10').value = cleanText(meta.teacher_name);
    ws.getCell('W10').value = cleanText(meta.subject_name);
    ws.getCell('H11').value = cleanText(meta.section);
  } else {                                   // terms 2 and 3 read the header from TERM 1
    ['G5', 'O5', 'V5', 'G7', 'V7', 'H10', 'P10', 'W10', 'H11', 'P11'].forEach(a => {
      ws.getCell(a).value = { formula: `'TERM 1'!${a}` };
    });
  }
  ws.getCell('W11').value = subjectType.toUpperCase();

  // highest possible scores (blank = column not used)
  ACTIVITIES.forEach(a => { ws.getRow(15).getCell(HPS_COL[a]).value = hps[a]; });

  // the template's x14 dropdown (track list) is not read by ExcelJS, so add it back
  ws.getCell('P11').dataValidation = { type: 'list', allowBlank: true, formulae: ['Sheet2!$A$15:$A$16'] };
}

function refreshTermRules(ws, plan) {
  // grey-out the exam columns when the subject type has no exam weight (V15 = 0) -- same rule as the template
  ws.conditionalFormattings = (ws.conditionalFormattings || []).filter(cf => cf.ref === 'Q15:V15');
  plan.scoreRanges.forEach(([a, b], i) => {
    ws.addConditionalFormatting({
      ref: `Q${a}:V${b}`,
      rules: [{ type: 'expression', priority: 10 + i, formulae: ['$V$15=0'],
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFD9D9D9' } } } }]
    });
    ['C', 'D', 'E', 'F', 'G', 'K', 'L', 'M', 'Q', 'R', 'S'].forEach(col => {
      for (let r = a; r <= b; r++) {
        ws.getCell(`${col}${r}`).dataValidation = {
          type: 'whole', operator: 'between', allowBlank: true, showErrorMessage: true,
          formulae: [0, `$${col}$15`]
        };
      }
    });
  });
}

/** Safety net: if ExcelJS dropped the template's pictures, put the logos back. */
function ensureLogos(wb, ws, which) {
  if (ws.getImages().length > 0) return;
  const add = (file, tl, ext) => {
    const p = path.join(ASSET_DIR, file);
    if (!fs.existsSync(p)) return;
    const id = wb.addImage({ filename: p, extension: 'png' });
    ws.addImage(id, { tl, ext });
  };
  if (which === 'term') {
    add('school_logo.png', { col: 1.07, row: 0.05 }, { width: 145, height: 135 });
    add('deped_banner.png', { col: 23.1, row: 2.1 }, { width: 171, height: 86 });
  } else {
    add('school_logo_final.png', { col: 0.2, row: 0.05 }, { width: 79, height: 79 });
    add('deped_banner.png', { col: 8.9, row: 0 }, { width: 138, height: 70 });
  }
}

async function buildWorkbook({ meta, subjectType, gradeLevel, termRows }) {
  const ExcelJS = require('exceljs');              // required lazily so the planners can be tested without it
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);

  const { males, females } = splitRoster(termRows[1]);
  const byId = t => new Map(termRows[t].map(r => [r.student_id, r]));

  let termLayoutForFinal = null;
  for (const term of [1, 2, 3]) {
    const ws = wb.getWorksheet(`TERM ${term}`);
    const rowsById = byId(term);
    const toStudent = r => {
      const own = rowsById.get(r.student_id) || {};
      return { name: r.full_name, scores: scoresOf(own) };
    };
    const plan = planTermSheet(males.map(toStudent), females.map(toStudent));
    termLayoutForFinal = plan.layout;

    const snaps = snapshotStyles(ws, TERM_STYLE_ROWS, TERM_MAX_COL);
    clearBelow(ws, plan.clearFrom, plan.clearTo, plan.maxCol);
    applyPlan(ws, plan, snaps);
    fillTermHeader(ws, term, { meta, subjectType, gradeLevel, hps: hpsOf(termRows[term]) });
    refreshTermRules(ws, plan);
    ensureLogos(wb, ws, 'term');
  }

  const fws = wb.getWorksheet('FINAL GRADE');
  const fplan = planFinalSheet(males, females, termLayoutForFinal);
  const fsnaps = snapshotStyles(fws, FINAL_STYLE_ROWS, FINAL_MAX_COL);
  clearBelow(fws, fplan.clearFrom, fplan.clearTo, fplan.maxCol);
  applyPlan(fws, fplan, fsnaps);
  ensureLogos(wb, fws, 'final');

  wb.creator = 'RNHS Teacher Portal';
  wb.created = new Date();
  wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };   // show values even before "Enable Editing"
  return wb;
}

/* ==========================================================================
   ROUTE
   ========================================================================== */
router.get('/class-record/:subjectId/export', async (req, res) => {
  try {
    const subjectId = Number(req.params.subjectId);
    const meta = await fetchMeta(req.user.id, subjectId);
    if (!meta) return res.status(404).json({ error: 'Subject not found' });

    const subjectType = SUBJECT_WEIGHTS[req.query.type] ? req.query.type : 'Core Subjects';
    const termRows = {};
    for (const term of [1, 2, 3]) termRows[term] = await fetchTermRows(req.user.id, subjectId, term);

    const wb = await buildWorkbook({
      meta, subjectType, gradeLevel: gradeLevelOf(meta.section, req.query.grade), termRows
    });

    const safe = s => String(s).replace(/[^a-z0-9]+/gi, '_');
    const fileName = `ClassRecord_${safe(cleanText(meta.subject_name))}_${safe(meta.section)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.__test = { planTermSheet, planFinalSheet, transmutationFormula, descriptorFormula, TERM_STYLE_ROWS, FINAL_STYLE_ROWS, hpsOf, scoresOf, gradeLevelOf };