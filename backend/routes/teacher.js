const router = require('express').Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const ExcelJS = require('exceljs');

router.use(authenticate, authorize('teacher'));

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: err.message });
});

const TRANSMUTATION = [
  [99.49,100],[98.31,99],[97.13,98],[95.95,97],[94.77,96],[93.59,95],[92.41,94],[91.23,93],
  [90.05,92],[88.87,91],[87.69,90],[86.51,89],[85.33,88],[84.15,87],[82.97,86],[81.79,85],
  [80.61,84],[79.43,83],[78.25,82],[77.07,81],[75.89,80],[74.71,79],[73.53,78],[72.35,77],
  [71.17,76],[69.99,75],[65.33,74],[60.66,73],[56,72],[51.33,71],[46.66,70],[42,69],
  [37.33,68],[32.67,67],[28,66],[23.34,65],[18.67,64],[14,63],[9.34,62],[4.67,61],[0,60]
];

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

const transmute = (initial) => (TRANSMUTATION.find(([min]) => initial > min) || [0, 0])[1];
const normalizeGender = (g) => String(g || '').trim().toLowerCase().startsWith('f') ? 'female' : 'male';
const val = (v) => (v === null || v === undefined || v === '') ? null : Number(v);

// --- DASHBOARD & SUBJECTS ---
router.get('/my-subjects', asyncRoute(async (req, res) => {
  const [rows] = await pool.query(`SELECT sub.id, sub.name, sub.code, sec.id AS section_id, sec.name AS section FROM subjects sub JOIN sections sec ON sec.id = sub.section_id WHERE sub.teacher_id = ?`, [req.user.id]);
  res.json(rows);
}));

router.get('/sections', asyncRoute(async (req, res) => {
  const [rows] = await pool.query('SELECT id, name FROM sections');
  res.json(rows);
}));

router.post('/subjects', asyncRoute(async (req, res) => {
  const { code, name, section_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO subjects (code, name, teacher_id, section_id) VALUES (?, ?, ?, ?)',
      [code, name, req.user.id, section_id]
    );
    res.json({ ok: true, message: 'Subject created successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Subject code already exists' });
    res.status(500).json({ error: err.message });
  }
}));

router.delete('/subjects/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  try {
    const [check] = await pool.query('SELECT id FROM subjects WHERE id = ? AND teacher_id = ?', [id, req.user.id]);
    if (check.length === 0) return res.status(403).json({ error: 'Unauthorized to delete this subject' });
    
    await pool.query('DELETE FROM grades WHERE subject_id = ?', [id]);
    await pool.query('DELETE FROM attendance WHERE subject_id = ?', [id]).catch(() => {});
    await pool.query('DELETE FROM subjects WHERE id = ?', [id]);
    
    res.json({ ok: true, message: 'Subject deleted successfully' });
  } catch (err) {
    console.error("Delete Error:", err);
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
}));

// --- GRADEBOOK ---
router.get('/gradebook', asyncRoute(async (req, res) => {
  const { term = 1, subject } = req.query;
  if (!subject) return res.status(400).json({ error: "Subject ID required" });

  const [subjRows] = await pool.query('SELECT section_id FROM subjects WHERE id = ? AND teacher_id = ?', [subject, req.user.id]);
  if (!subjRows.length) return res.status(404).json({ error: "Subject not found" });
  const sectionId = subjRows[0].section_id;

  const [students] = await pool.query(`
    SELECT u.id AS student_id, u.full_name, s.lrn
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.section_id = ?
    ORDER BY u.full_name
  `, [sectionId]);

  const [grades] = await pool.query(`
    SELECT * FROM grades WHERE subject_id = ? AND term = ?
  `, [subject, term]);

  const gradeMap = {};
  grades.forEach(g => { gradeMap[g.student_id] = g; });

  const rows = students.map(s => {
    const g = gradeMap[s.student_id] || {};
    return {
      student_id: s.student_id, 
      full_name: s.full_name,
      lrn: s.lrn,
      subject_id: Number(subject),
      term: term,
      ...g 
    };
  });

  res.json(rows);
}));

router.post('/grades', asyncRoute(async (req, res) => {
  try {
    const g = req.body;
    if (!g.student_id) return res.json({ ok: true, skipped: true });

    // Helper: Converts to number, but keeps 'null' if it's empty
    const n = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? null : Number(v);
    const calcN = (v) => n(v) || 0; // Helper for math (treats null as 0)

    const ww1 = n(g.ww1), ww2 = n(g.ww2), ww3 = n(g.ww3), ww4 = n(g.ww4), ww5 = n(g.ww5);
    const pt1 = n(g.pt1), pt2 = n(g.pt2), pt3 = n(g.pt3);
    const ex1 = n(g.ex1), ex2 = n(g.ex2), ex3 = n(g.ex3);
    
    const ww_hps = calcN(g.ww1_hps) + calcN(g.ww2_hps) + calcN(g.ww3_hps) + calcN(g.ww4_hps) + calcN(g.ww5_hps);
    const pt_hps = calcN(g.pt1_hps) + calcN(g.pt2_hps) + calcN(g.pt3_hps);
    const ex_hps = calcN(g.ex1_hps) + calcN(g.ex2_hps) + calcN(g.ex3_hps);

    // If all scores are null, don't calculate a grade (keep it null)
    const hasAnyGrade = [ww1, ww2, ww3, ww4, ww5, pt1, pt2, pt3, ex1, ex2, ex3].some(v => v !== null);

    let initialGrade = null;
    let termGrade = null;
    let descriptor = null;

    if (hasAnyGrade) {
      const ww_ps = ww_hps === 0 ? 0 : ((calcN(ww1)+calcN(ww2)+calcN(ww3)+calcN(ww4)+calcN(ww5)) / ww_hps) * 100;
      const pt_ps = pt_hps === 0 ? 0 : ((calcN(pt1)+calcN(pt2)+calcN(pt3)) / pt_hps) * 100;
      const ex_ps = ex_hps === 0 ? 0 : ((calcN(ex1)+calcN(ex2)+calcN(ex3)) / ex_hps) * 100;

      initialGrade = Number(((ww_ps * 0.20) + (pt_ps * 0.50) + (ex_ps * 0.30)).toFixed(2));
      termGrade = initialGrade === 0 ? 0 : transmute(initialGrade);
      descriptor = termGrade === 0 ? '' : termGrade > 89 ? 'Advancing' : termGrade > 79 ? 'Benchmarking' : termGrade > 74 ? 'Connecting' : termGrade > 64 ? 'Developing' : 'Emerging';
    }

    const sql = `
      INSERT INTO grades (
        student_id, subject_id, term,
        ww1, ww2, ww3, ww4, ww5, pt1, pt2, pt3, ex1, ex2, ex3,
        initial_grade, term_grade, descriptor,
        ww1_hps, ww2_hps, ww3_hps, ww4_hps, ww5_hps,
        pt1_hps, pt2_hps, pt3_hps, ex1_hps, ex2_hps, ex3_hps
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        ww1=VALUES(ww1), ww2=VALUES(ww2), ww3=VALUES(ww3), ww4=VALUES(ww4), ww5=VALUES(ww5),
        pt1=VALUES(pt1), pt2=VALUES(pt2), pt3=VALUES(pt3), ex1=VALUES(ex1), ex2=VALUES(ex2), ex3=VALUES(ex3),
        initial_grade=VALUES(initial_grade), term_grade=VALUES(term_grade), descriptor=VALUES(descriptor),
        ww1_hps=VALUES(ww1_hps), ww2_hps=VALUES(ww2_hps), ww3_hps=VALUES(ww3_hps), ww4_hps=VALUES(ww4_hps), ww5_hps=VALUES(ww5_hps),
        pt1_hps=VALUES(pt1_hps), pt2_hps=VALUES(pt2_hps), pt3_hps=VALUES(pt3_hps), 
        ex1_hps=VALUES(ex1_hps), ex2_hps=VALUES(ex2_hps), ex3_hps=VALUES(ex3_hps)
    `;

    const vals = [
      g.student_id, g.subject_id, g.term,
      ww1, ww2, ww3, ww4, ww5, pt1, pt2, pt3, ex1, ex2, ex3,
      initialGrade, termGrade, descriptor,
      calcN(g.ww1_hps), calcN(g.ww2_hps), calcN(g.ww3_hps), calcN(g.ww4_hps), calcN(g.ww5_hps),
      calcN(g.pt1_hps), calcN(g.pt2_hps), calcN(g.pt3_hps), calcN(g.ex1_hps), calcN(g.ex2_hps), calcN(g.ex3_hps)
    ];

    await pool.query(sql, vals);
    res.json({ ok: true, termGrade });
  } catch (err) {
    console.error("DATABASE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
}));

router.get('/final-grades', asyncRoute(async (req, res) => {
  const { subject } = req.query;
  if (!subject) return res.status(400).json({ error: "Subject ID required" });

  const [rows] = await pool.query(`
    SELECT u.id AS student_id, u.full_name,
           MAX(CASE WHEN g.term = 1 THEN g.term_grade END) AS term1,
           MAX(CASE WHEN g.term = 2 THEN g.term_grade END) AS term2,
           MAX(CASE WHEN g.term = 3 THEN g.term_grade END) AS term3
    FROM subjects sub JOIN sections sec ON sec.id = sub.section_id JOIN students s ON s.section_id = sec.id JOIN users u ON u.id = s.user_id
    LEFT JOIN grades g ON g.student_id = u.id AND g.subject_id = sub.id
    WHERE sub.teacher_id = ? AND sub.id = ? GROUP BY u.id, u.full_name ORDER BY u.full_name`, [req.user.id, subject]);

  res.json(rows.map(r => {
    const present = [r.term1, r.term2, r.term3].filter(v => v !== null && v > 0).map(Number);
    const final = present.length ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : null;
    const desc = final === null ? '' : final > 89 ? 'Advancing' : final > 79 ? 'Benchmarking' : final > 74 ? 'Connecting' : final > 64 ? 'Developing' : 'Emerging';
    return { ...r, final_grade: final, descriptor: desc };
  }));
}));

// --- ATTENDANCE & WARNINGS ---
router.get('/attendance/:subjectId/:date', asyncRoute(async (req, res) => {
  const [rows] = await pool.query(`
    SELECT u.id AS student_id, u.full_name, a.status,
           (SELECT COUNT(*) FROM attendance WHERE student_id = u.id AND status = 'present') AS days_present,
           (SELECT COUNT(*) FROM attendance WHERE student_id = u.id AND status = 'late') AS days_late,
           (SELECT COUNT(*) FROM attendance WHERE student_id = u.id AND status = 'excused') AS days_excused,
           (SELECT COUNT(*) FROM attendance WHERE student_id = u.id AND status = 'absent') AS days_absent
    FROM subjects sub JOIN students s ON s.section_id = sub.section_id JOIN users u ON u.id = s.user_id
    LEFT JOIN attendance a ON a.student_id = u.id AND a.date = ? AND a.section_id = sub.section_id
    WHERE sub.teacher_id = ? AND sub.id = ? GROUP BY u.id, u.full_name, a.status ORDER BY u.full_name`, [req.params.date, req.user.id, req.params.subjectId]);
  res.json(rows);
}));

router.post('/attendance', asyncRoute(async (req, res) => {
  const { student_id, section_id, date, status } = req.body;
  await pool.query(`INSERT INTO attendance (student_id, section_id, date, status, recorded_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status)`, [student_id, section_id, date, status, req.user.id]);
  res.json({ ok: true });
}));

router.get('/attendance-history/:subjectId', asyncRoute(async (req, res) => {
  const [rows] = await pool.query(`
    SELECT u.id AS student_id, u.full_name, a.date, a.status
    FROM subjects sub JOIN students s ON s.section_id = sub.section_id JOIN users u ON u.id = s.user_id
    JOIN attendance a ON a.student_id = u.id AND a.section_id = sub.section_id
    WHERE sub.teacher_id = ? AND sub.id = ? AND MONTH(a.date) = ? AND YEAR(a.date) = ? ORDER BY u.full_name, a.date`, [req.user.id, req.params.subjectId, req.query.month, req.query.year]);
  res.json(rows);
}));

router.get('/at-risk', asyncRoute(async (req, res) => {
  const [rows] = await pool.query(`
    SELECT u.id, u.full_name, 
           ROUND(AVG(g.term_grade), 2) AS avg_grade,
           COUNT(DISTINCT g.term_grade) AS graded_count,
           (SELECT COUNT(*) FROM attendance a WHERE a.student_id = u.id AND a.status = 'present' AND a.date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS raw_present,
           (SELECT COUNT(*) FROM attendance a WHERE a.student_id = u.id AND a.status = 'late' AND a.date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS raw_late,
           (SELECT COUNT(*) FROM attendance a WHERE a.student_id = u.id AND a.status = 'excused' AND a.date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS raw_excused,
           (SELECT COUNT(*) FROM attendance a WHERE a.student_id = u.id AND a.status = 'absent' AND a.date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS raw_absent
    FROM users u 
    JOIN students s ON s.user_id = u.id 
    JOIN subjects sub ON sub.section_id = s.section_id AND sub.teacher_id = ?
    LEFT JOIN grades g ON g.student_id = u.id AND g.subject_id = sub.id
    GROUP BY u.id, u.full_name 
    HAVING (avg_grade < 75 AND graded_count > 0) 
        OR (raw_absent + FLOOR(raw_late / 3) > 4)`, [req.user.id]);
  res.json(rows);
}));

router.get('/sf2/:sectionId', asyncRoute(async (req, res) => {
  const { sectionId } = req.params;
  const [authCheck] = await pool.query(`SELECT 1 FROM subjects WHERE section_id = ? AND teacher_id = ? LIMIT 1`, [sectionId, req.user.id]);
  if (!authCheck.length) return res.status(403).json({ error: "Unauthorized" });

  const m = Number(req.query.month) || (new Date().getMonth() + 1);
  const y = Number(req.query.year) || new Date().getFullYear();

  const [rows] = await pool.query(`
    SELECT s.lrn, u.full_name,
           COALESCE(SUM(a.status = 'present'), 0) AS days_present, COALESCE(SUM(a.status = 'late'), 0) AS days_late,
           COALESCE(SUM(a.status = 'excused'), 0) AS days_excused, COALESCE(SUM(a.status = 'absent'), 0) AS days_absent
    FROM users u JOIN students s ON s.user_id = u.id
    LEFT JOIN attendance a ON a.student_id = u.id AND a.section_id = s.section_id AND MONTH(a.date) = ? AND YEAR(a.date) = ?
    WHERE s.section_id = ? GROUP BY u.id, s.lrn, u.full_name ORDER BY u.full_name`, [m, y, sectionId]);
  res.json(rows);
}));

// --- EXCEL EXPORT ---
router.get('/class-record/:subjectId/export', asyncRoute(async (req, res) => {
  const subjectId = Number(req.params.subjectId);
  const subjectType = req.query.type || 'Core Subjects';

  const [[meta]] = await pool.query(`SELECT sub.name AS subject_name, sec.name AS section, u.full_name AS teacher_name FROM subjects sub JOIN sections sec ON sec.id = sub.section_id JOIN users u ON u.id = sub.teacher_id WHERE sub.teacher_id = ? AND sub.id = ?`, [req.user.id, subjectId]);
  if (!meta) return res.status(404).json({ error: 'Subject not found' });

  const termRows = {};
  for (const term of [1, 2, 3]) {
    const [rows] = await pool.query(`
      SELECT u.id AS student_id, u.full_name, s.lrn, s.gender, g.*
      FROM subjects sub JOIN sections sec ON sec.id = sub.section_id JOIN students s ON s.section_id = sec.id JOIN users u ON u.id = s.user_id
      LEFT JOIN grades g ON g.student_id = u.id AND g.subject_id = sub.id AND g.term = ? WHERE sub.teacher_id = ? AND sub.id = ? ORDER BY u.full_name`, [term, req.user.id, subjectId]);
    termRows[term] = rows;
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'RNHS Teacher Portal';

  const wsLookup = wb.addWorksheet('Sheet2');
  wsLookup.getRow(1).values = ['SUBJECT TYPE', 'WWs', 'PTs', 'STs-TE']; wsLookup.getRow(1).font = { bold: true };
  Object.entries(SUBJECT_WEIGHTS).forEach(([k, w], i) => wsLookup.getRow(i + 2).values = [k, w[0], w[1], w[2]]);

  const wsTrans = wb.addWorksheet('Transmutation', { state: 'veryHidden' });
  TRANSMUTATION.forEach((t, i) => wsTrans.getRow(i + 2).values = t);
  const transFormula = (cell) => `LOOKUP(${cell}, Transmutation!$A$2:$A$42, Transmutation!$B$2:$B$42)`;
  const descFormula = (cell) => `IF(${cell}="","",IF(${cell}>89,"Advancing",IF(${cell}>79,"Benchmarking",IF(${cell}>74,"Connecting",IF(${cell}>64,"Developing",IF(${cell}>0,"Emerging",0))))))`;

  for (const term of [1, 2, 3]) {
    const ws = wb.addWorksheet(`TERM ${term}`, { views: [{ state: 'frozen', xSplit: 2, ySplit: 16 }] });
    const widths = { A: 6, B: 32, C: 6, D: 6, E: 6, F: 6, G: 6, H: 8, I: 8, J: 8, K: 6, L: 6, M: 6, N: 8, O: 8, P: 8, Q: 6, R: 6, S: 6, T: 8, U: 8, V: 8, W: 12, X: 12, Y: 15 };
    Object.entries(widths).forEach(([k, v]) => { ws.getColumn(k).width = v; });

    ws.mergeCells('A1:Y1'); ws.getCell('A1').value = `CLASS RECORD - TERM ${term}`; ws.getCell('A1').font = { bold: true, size: 14 };
    ws.mergeCells('A3:Y3'); ws.getCell('A3').value = '(Pursuant to DepEd Order 15 series of 2026)'; ws.getCell('A3').font = { italic: true, size: 10, color: { argb: 'FF666666' } };
    
    const headerData = [['C5','REGION:'], ['H5','I'], ['N5','DIVISION'], ['Q5','PANGASINAN II'], ['T5','SCHOOL ID'], ['W5','300341'], ['C7','SCHOOL NAME:'], ['H7','ROSALES NATIONAL HIGH SCHOOL'], ['S7','SCHOOL YEAR:'], ['W7','2026-2027'],
      ['A10',`TERM ${term}`], ['C10','GRADE LEVEL'], ['I10','11'], ['N10','TEACHER:'], ['Q10',meta.teacher_name], ['U10','SUBJECT:'], ['W10',meta.subject_name],
      ['C11','SECTION'], ['I11',meta.section], ['N11','TRACK:'], ['Q11','ACADEMIC'], ['U11','SUBJECT TYPE:'], ['W11',subjectType]];
    headerData.forEach(([c, v]) => ws.getCell(c).value = v);

    ws.getCell('C13').value = { formula: `VLOOKUP(W11,Sheet2!$A$2:$D$11,2,TRUE)` };
    ws.getCell('K13').value = { formula: `VLOOKUP(W11,Sheet2!$A$2:$D$11,3,TRUE)` };
    ws.getCell('Q13').value = { formula: `VLOOKUP(W11,Sheet2!$A$2:$D$11,4,TRUE)` };

    const catHeader = (range, text, color) => { ws.mergeCells(range); ws.getCell(range.split(':')[0]).value = text; ws.getCell(range.split(':')[0]).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }; ws.getCell(range.split(':')[0]).font = { bold: true }; };
    catHeader('C12:J12', 'WRITTEN/ORAL WORKS (WWs)', 'FFE0E7FF');
    catHeader('K12:P12', 'PRODUCT/PERFORMANCE TASKS (PTs)', 'FFDCFCE7');
    catHeader('Q12:V12', 'EXAMINATIONS (EXs)', 'FFFEF3C7');

    ['1','2','3','4','5','TOTAL','PS','WS'].forEach((h, i) => ws.getRow(14).getCell(3 + i).value = h);
    ['1','2','3','TOTAL','PS','WS'].forEach((h, i) => ws.getRow(14).getCell(11 + i).value = h);
    ['SA1','SA2','TE','TOTAL','PS','WS'].forEach((h, i) => ws.getRow(14).getCell(17 + i).value = h);
    ws.getRow(14).font = { bold: true }; ws.getRow(14).alignment = { horizontal: 'center' };

    ws.getCell('B15').value = 'HIGHEST POSSIBLE SCORE'; ws.getCell('B15').font = { bold: true };
    const hpsRef = termRows[term].find(r => r.ww1_hps !== null) || {};
    ['ww1','ww2','ww3','ww4','ww5'].forEach((f, i) => ws.getRow(15).getCell(3 + i).value = val(hpsRef[`${f}_hps`]) ?? 100);
    ['pt1','pt2','pt3'].forEach((f, i) => ws.getRow(15).getCell(11 + i).value = val(hpsRef[`${f}_hps`]) ?? 100);
    ['ex1','ex2','ex3'].forEach((f, i) => ws.getRow(15).getCell(17 + i).value = val(hpsRef[`${f}_hps`]) ?? 100);
    
    ws.getCell('H15').value = { formula: 'SUM(C15:G15)' }; ws.getCell('I15').value = 100; ws.getCell('J15').value = { formula: 'I15*$C$13' };
    ws.getCell('N15').value = { formula: 'SUM(K15:M15)' }; ws.getCell('O15').value = 100; ws.getCell('P15').value = { formula: 'O15*$K$13' };
    ws.getCell('T15').value = { formula: 'SUM(Q15:S15)' }; ws.getCell('U15').value = 100; ws.getCell('V15').value = { formula: 'U15*$Q$13' };

    ws.getCell('B16').value = "LEARNERS' NAMES"; ws.getCell('W16').value = 'Initial Grade'; ws.getCell('X16').value = 'Term Grade'; ws.getCell('Y16').value = 'Descriptor'; ws.getRow(16).font = { bold: true };

    const male = termRows[term].filter(r => normalizeGender(r.gender) === 'male');
    const female = termRows[term].filter(r => normalizeGender(r.gender) === 'female');
    let cursor = 17;

    const writeBlock = (label, list) => {
      ws.getCell(`A${cursor}`).value = label; ws.getCell(`A${cursor}`).font = { bold: true, italic: true }; cursor++;
      list.forEach((s, i) => {
        const row = ws.getRow(cursor);
        row.getCell(1).value = i + 1; row.getCell(2).value = s.full_name;
        for (let c = 3; c <= 7; c++) row.getCell(c).value = val(s[`ww${c-2}`]);
        for (let c = 11; c <= 13; c++) row.getCell(c).value = val(s[`pt${c-10}`]);
        for (let c = 17; c <= 19; c++) row.getCell(c).value = val(s[`ex${c-16}`]);
        
        row.getCell(8).value = { formula: `SUM(C${cursor}:G${cursor})` };
        row.getCell(9).value = { formula: `IF(H${cursor}="","",H${cursor}/$H$15*100)` };
        row.getCell(10).value = { formula: `IFERROR(I${cursor}*$C$13,"")` };
        
        row.getCell(14).value = { formula: `SUM(K${cursor}:M${cursor})` };
        row.getCell(15).value = { formula: `IF(N${cursor}="","",N${cursor}/$N$15*100)` };
        row.getCell(16).value = { formula: `IFERROR(O${cursor}*$K$13,"")` };
        
        row.getCell(20).value = { formula: `SUM(Q${cursor}:S${cursor})` };
        row.getCell(21).value = { formula: `IF(T${cursor}="","",T${cursor}/$T$15*100)` };
        row.getCell(22).value = { formula: `IFERROR(U${cursor}*$Q$13,"")` };
        
        row.getCell(23).value = { formula: `IF(OR(J${cursor}="",P${cursor}=""),"",SUM(J${cursor},P${cursor},V${cursor}))` };
        row.getCell(24).value = { formula: transFormula(`W${cursor}`) };
        row.getCell(25).value = { formula: descFormula(`X${cursor}`) };
        cursor++;
      });
    };

    writeBlock('MALE', male); writeBlock('FEMALE', female);

    const sig = cursor + 1;
    ws.getCell(`A${sig}`).value = 'Prepared by:'; ws.getCell(`F${sig}`).value = 'Checked by:'; ws.getCell(`T${sig}`).value = 'Approved:';
    ws.getCell(`B${sig + 1}`).value = meta.teacher_name; ws.getCell(`I${sig + 1}`).value = 'CONRADO C. AREOLA JR.'; ws.getCell(`V${sig + 1}`).value = 'ROWENA LEA G. MORENO';
    ws.getCell(`B${sig + 2}`).value = 'Subject Teacher'; ws.getCell(`I${sig + 2}`).value = 'SHS OIC Assistant Principal'; ws.getCell(`V${sig + 2}`).value = 'Principal IV';
  }

  const wsFinal = wb.addWorksheet('FINAL GRADE');
  const fWidths = { A: 6, B: 32, E: 12, F: 12, G: 12, H: 15, I: 18, J: 15 };
  Object.entries(fWidths).forEach(([k, v]) => { wsFinal.getColumn(k).width = v; });

  wsFinal.mergeCells('A2:J2'); wsFinal.getCell('A2').value = 'CLASS RECORD - FINAL GRADES'; wsFinal.getCell('A2').font = { bold: true, size: 14 };
  const fHeader = [['B5','REGION'],['C5','I'],['E5','DIVISION'],['F5','PANGASINAN II'],['H5','SCHOOL ID'],['I5','300341'],['B6','SCHOOL NAME'],['C6','ROSALES NATIONAL HIGH SCHOOL'],['H6','SCHOOL YEAR'],['I6','2026-2027'],
    ['A9','GRADE LEVEL'],['C9','11'],['F9','SUBJECT'],['G9',meta.subject_name],['A10','SECTION'],['C10',meta.section],['F10','TEACHER'],['G10',meta.teacher_name]];
  fHeader.forEach(([c, v]) => wsFinal.getCell(c).value = v);

  wsFinal.getRow(12).values = ['', '', '', '', 'TERM GRADES', '', '', 'FINAL GRADE', 'DESCRIPTOR', 'REMARK']; wsFinal.getRow(12).font = { bold: true };
  wsFinal.getRow(13).values = ['', '', '', '', 'TERM 1', 'TERM 2', 'TERM 3', '', '', '']; wsFinal.getRow(13).font = { bold: true };

  const fMale = termRows[1].filter(r => normalizeGender(r.gender) === 'male');
  const fFemale = termRows[1].filter(r => normalizeGender(r.gender) === 'female');
  let fCursor = 14;

  const writeFinalBlock = (label, list) => {
    wsFinal.getCell(`A${fCursor}`).value = label; wsFinal.getCell(`A${fCursor}`).font = { bold: true, italic: true }; fCursor++;
    list.forEach((s, i) => {
      const row = wsFinal.getRow(fCursor);
      row.getCell(1).value = i + 1; row.getCell(2).value = s.full_name;
      
      [1, 2, 3].forEach(t => {
        const termRow = termRows[t].find(r => r.student_id === s.student_id);
        row.getCell(4 + t).value = val(termRow?.term_grade);
      });
      
      row.getCell(8).value = { formula: `IFERROR(ROUND(AVERAGE(E${fCursor}:G${fCursor}),0),"")` };
      row.getCell(9).value = { formula: descFormula(`H${fCursor}`) };
      row.getCell(10).value = { formula: `IF(H${fCursor}="","",IF(H${fCursor}>=75,"PASSED","FAILED"))` };
      fCursor++;
    });
  };

  writeFinalBlock('MALE', fMale); writeFinalBlock('FEMALE', fFemale);

  const safe = (str) => str.replace(/[^a-z0-9]+/gi, '_');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ClassRecord_${safe(meta.subject_name)}_${safe(meta.section)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

module.exports = router;