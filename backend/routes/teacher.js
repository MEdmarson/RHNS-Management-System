const router = require('express').Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const multer = require('multer');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const { Readable } = require('stream');

router.use(authenticate, authorize('teacher'));

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: err.message });
});

const upload = multer({ storage: multer.memoryStorage() });

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
// Make sure the finished-class columns exist (safe to run every boot; duplicate-column errors are ignored)
pool.query("ALTER TABLE subjects ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active'").catch(() => {});
pool.query("ALTER TABLE subjects ADD COLUMN finished_at DATETIME NULL").catch(() => {});
pool.query("ALTER TABLE subjects ADD COLUMN subject_type VARCHAR(100) NULL").catch(() => {});

// Keep the subject type (WW/PT/EX weights) in the database, so the at-risk checks and student alerts can use it
const saveSubjectType = async (subjectId, teacherId, type) => {
  if (!subjectId || !SUBJECT_WEIGHTS[type]) return;
  await pool.query('UPDATE subjects SET subject_type = ? WHERE id = ? AND teacher_id = ? AND (subject_type IS NULL OR subject_type <> ?)', [type, subjectId, teacherId, type]);
};

// ?status=active (default) | finished | all
router.get('/my-subjects', asyncRoute(async (req, res) => {
  const status = req.query.status;
  let where = 'sub.teacher_id = ?';
  if (status === 'finished') where += " AND sub.status = 'finished'";
  else if (status !== 'all') where += " AND sub.status = 'active'";
  const [rows] = await pool.query(`SELECT sub.id, sub.name, sub.code, sub.status, sub.finished_at, sub.subject_type, sec.id AS section_id, sec.name AS section FROM subjects sub JOIN sections sec ON sec.id = sub.section_id WHERE ${where} ORDER BY sub.name`, [req.user.id]);
  res.json(rows);
}));

// Mark a class finished (moves it to Past Classes) or reopen it
router.put('/subjects/:id/status', asyncRoute(async (req, res) => {
  const { status } = req.body;
  if (!['active', 'finished'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const [check] = await pool.query('SELECT id FROM subjects WHERE id = ? AND teacher_id = ?', [req.params.id, req.user.id]);
  if (!check.length) return res.status(403).json({ error: 'Unauthorized to update this subject' });
  await pool.query('UPDATE subjects SET status = ?, finished_at = ? WHERE id = ?',
    [status, status === 'finished' ? new Date() : null, req.params.id]);
  res.json({ ok: true, status });
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

router.put('/subjects/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { code, name, section_id } = req.body;
  try {
    const [check] = await pool.query('SELECT id FROM subjects WHERE id = ? AND teacher_id = ?', [id, req.user.id]);
    if (check.length === 0) return res.status(403).json({ error: 'Unauthorized to edit this subject' });

    await pool.query(
      'UPDATE subjects SET code = ?, name = ?, section_id = ? WHERE id = ?',
      [code, name, section_id, id]
    );
    res.json({ ok: true, message: 'Subject updated successfully' });
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
    SELECT u.id AS student_id, u.full_name, s.lrn, s.gender
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
      gender: s.gender,
      subject_id: Number(subject),
      term: term,
      ...g 
    };
  });

  res.json(rows);
}));

// --- IMPORT GRADES (class-record .xlsx, or CSV) ---
// Parse CSV text -> array of row objects (headers are upper-cased / trimmed / BOM-stripped)
const parseCsv = (text) => new Promise((resolve, reject) => {
  const rows = [];
  Readable.from([text])
    .pipe(csv({
      // NOTE: do NOT pass `headers: true` — csv-parser expects an array or false.
      // Leaving it out makes it read the first line as the header row.
      mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim().toUpperCase(),
      mapValues: ({ value }) => (typeof value === 'string' ? value.trim() : value)
    }))
    .on('data', (r) => rows.push(r))
    .on('end', () => resolve(rows))
    .on('error', reject);
});

// "BAÑAGA, MHIKE DAVE S." and "BANAGA MHIKE DAVE S" -> same key
const normName = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const normLrn = (s) => String(s || '').replace(/\D/g, '');

// Read the class-record .xlsx itself (the same file you download with "Download Excel").
// Converts the TERM sheet into the same row format the CSV import uses, including the HPS row.
function parseClassRecordXlsx(buffer, term) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const wanted = `TERM ${term}`;
  const sheetName = wb.SheetNames.find((n) => n.trim().toUpperCase() === wanted);
  if (!sheetName) throw new Error(`Sheet "${wanted}" was not found in the Excel file.`);
  const ws = wb.Sheets[sheetName];

  const val = (addr) => {
    const c = ws[addr];
    if (!c) return '';
    if (typeof c.v === 'number') return c.v;
    if (typeof c.v === 'string' && c.v.trim() !== '' && !isNaN(Number(c.v))) return Number(c.v);
    return '';
  };
  const COLS = {
    WW1: 'C', WW2: 'D', WW3: 'E', WW4: 'F', WW5: 'G',
    PT1: 'K', PT2: 'L', PT3: 'M',
    SA1: 'Q', SA2: 'R', TE: 'S'
  };
  const readRow = (r) => { const o = {}; for (const [k, col] of Object.entries(COLS)) o[k] = val(`${col}${r}`); return o; };

  // row 15 = HIGHEST POSSIBLE SCORE
  const rows = [{ LRN: '', 'FULL NAME': 'HIGHEST POSSIBLE SCORE', ...readRow(15) }];

  // students: column A has the running number, column B the name (MALE / FEMALE label rows are skipped)
  let withScores = 0;
  for (let r = 18; r <= 300; r++) {
    const a = ws[`A${r}`], b = ws[`B${r}`];
    if (!a || typeof a.v !== 'number' || !b || typeof b.v !== 'string' || !b.v.trim()) continue;
    const scores = readRow(r);
    if (Object.values(scores).some((x) => x !== '')) withScores++;
    rows.push({ LRN: '', 'FULL NAME': b.v.trim(), ...scores });
  }
  if (rows.length === 1) throw new Error(`No students found in sheet "${sheetName}".`);
  if (!withScores) throw new Error(`No scores found in sheet "${sheetName}". Choose the correct term, or fill in the sheet first.`);
  return rows;
}

router.post('/grades/import', upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { subject_id, term } = req.body;
  if (!subject_id || !term) return res.status(400).json({ error: 'Subject and Term required' });

  // 1. Subject must belong to this teacher
  const [subj] = await pool.query(
    'SELECT section_id FROM subjects WHERE id = ? AND teacher_id = ?',
    [subject_id, req.user.id]
  );
  if (subj.length) await saveSubjectType(subject_id, req.user.id, req.body.subject_type);
  if (!subj.length) return res.status(404).json({ error: 'Subject not found' });

  // 2. Parse the upload: the class-record .xlsx directly, or the CSV template
  const buf = req.file.buffer;
  const isXlsx = /\.xlsx?$/i.test(req.file.originalname || '') || (buf[0] === 0x50 && buf[1] === 0x4b); // "PK" = zip
  let rows;
  if (isXlsx) {
    try {
      rows = parseClassRecordXlsx(buf, term);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  } else {
    rows = await parseCsv(buf.toString('utf8'));
    if (!rows.length || !('LRN' in rows[0])) {
      return res.status(400).json({
        error: 'Could not read the file. Upload the class-record .xlsx, or a CSV with: LRN, Full Name, WW1..WW5, PT1..PT3, SA1, SA2, TE'
      });
    }
  }
  console.log(`[import] ${isXlsx ? 'xlsx' : 'csv'}: parsed ${rows.length} rows`);

  // 3. Load the section's students ONCE and build lookup maps (1 query instead of 3 per row)
  const [students] = await pool.query(`
    SELECT u.id AS student_id, u.full_name, s.lrn
    FROM students s JOIN users u ON u.id = s.user_id
    WHERE s.section_id = ?
  `, [subj[0].section_id]);

  const byLrn = new Map(), byName = new Map();
  students.forEach((s) => {
    if (s.lrn) byLrn.set(normLrn(s.lrn), s.student_id);
    byName.set(normName(s.full_name), s.student_id);
  });

  // 4. HPS: use the saved HPS for this subject/term (prefer a row where HPS is actually set)
  const [existing] = await pool.query(`
    SELECT ww1_hps, ww2_hps, ww3_hps, ww4_hps, ww5_hps, pt1_hps, pt2_hps, pt3_hps, ex1_hps, ex2_hps, ex3_hps
    FROM grades
    WHERE subject_id = ? AND term = ?
    ORDER BY (COALESCE(ww1_hps,0)+COALESCE(ww2_hps,0)+COALESCE(ww3_hps,0)+COALESCE(ww4_hps,0)+COALESCE(ww5_hps,0)
            + COALESCE(pt1_hps,0)+COALESCE(pt2_hps,0)+COALESCE(pt3_hps,0)
            + COALESCE(ex1_hps,0)+COALESCE(ex2_hps,0)+COALESCE(ex3_hps,0)) DESC
    LIMIT 1
  `, [subject_id, term]);

  const num = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? null : Number(v);
  const z = (v) => num(v) || 0;

  const hps = existing[0] || {};
  const H = {
    ww1: z(hps.ww1_hps), ww2: z(hps.ww2_hps), ww3: z(hps.ww3_hps), ww4: z(hps.ww4_hps), ww5: z(hps.ww5_hps),
    pt1: z(hps.pt1_hps), pt2: z(hps.pt2_hps), pt3: z(hps.pt3_hps),
    ex1: z(hps.ex1_hps), ex2: z(hps.ex2_hps), ex3: z(hps.ex3_hps)
  };

  // If the CSV has a "HIGHEST POSSIBLE SCORE" (or "HPS") row, it overrides the saved HPS,
  // so the website uses the exact same HPS as the Excel file.
  const isHpsRow = (r) => /HIGHEST\s+POSSIBLE\s+SCORE|^HPS$/i.test(`${r['LRN'] || ''} ${r['FULL NAME'] || ''}`.trim());
  const hpsRow = rows.find(isHpsRow);
  let hpsFromCsv = false;
  if (hpsRow) {
    const fromCsv = {
      ww1: z(hpsRow.WW1), ww2: z(hpsRow.WW2), ww3: z(hpsRow.WW3), ww4: z(hpsRow.WW4), ww5: z(hpsRow.WW5),
      pt1: z(hpsRow.PT1), pt2: z(hpsRow.PT2), pt3: z(hpsRow.PT3),
      ex1: z(hpsRow.SA1), ex2: z(hpsRow.SA2), ex3: z(hpsRow.TE)
    };
    if (Object.values(fromCsv).some((x) => x > 0)) { Object.assign(H, fromCsv); hpsFromCsv = true; }
  }
  const ww_hps = H.ww1 + H.ww2 + H.ww3 + H.ww4 + H.ww5;
  const pt_hps = H.pt1 + H.pt2 + H.pt3;
  const ex_hps = H.ex1 + H.ex2 + H.ex3;
  const hpsMissing = (ww_hps + pt_hps + ex_hps) === 0;

  const sql = `
    INSERT INTO grades (
      student_id, subject_id, term,
      ww1, ww2, ww3, ww4, ww5, pt1, pt2, pt3, ex1, ex2, ex3,
      initial_grade, term_grade, descriptor, missing_requirements,
      ww1_hps, ww2_hps, ww3_hps, ww4_hps, ww5_hps,
      pt1_hps, pt2_hps, pt3_hps, ex1_hps, ex2_hps, ex3_hps
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      ww1=VALUES(ww1), ww2=VALUES(ww2), ww3=VALUES(ww3), ww4=VALUES(ww4), ww5=VALUES(ww5),
      pt1=VALUES(pt1), pt2=VALUES(pt2), pt3=VALUES(pt3),
      ex1=VALUES(ex1), ex2=VALUES(ex2), ex3=VALUES(ex3),
      initial_grade=VALUES(initial_grade), term_grade=VALUES(term_grade), descriptor=VALUES(descriptor),
      missing_requirements=VALUES(missing_requirements),
      ww1_hps=VALUES(ww1_hps), ww2_hps=VALUES(ww2_hps), ww3_hps=VALUES(ww3_hps), ww4_hps=VALUES(ww4_hps), ww5_hps=VALUES(ww5_hps),
      pt1_hps=VALUES(pt1_hps), pt2_hps=VALUES(pt2_hps), pt3_hps=VALUES(pt3_hps),
      ex1_hps=VALUES(ex1_hps), ex2_hps=VALUES(ex2_hps), ex3_hps=VALUES(ex3_hps)
  `;

  let successCount = 0;
  const notFound = [];
  const errors = [];

  for (const row of rows) {
    const lrnRaw = row['LRN'] || '';
    const nameRaw = row['FULL NAME'] || '';

    // skip blank lines and the MALE / FEMALE divider rows
    if (!lrnRaw && !nameRaw) continue;
    if (isHpsRow(row)) continue;
    if (/^(MALE|FEMALE)$/i.test(lrnRaw) && !nameRaw) continue;

    // match by LRN first, then by normalized name
    const studentId = byLrn.get(normLrn(lrnRaw)) || byName.get(normName(nameRaw));
    if (!studentId) {
      notFound.push(nameRaw || lrnRaw);
      continue;
    }

    try {
      const v = {
        ww1: num(row.WW1), ww2: num(row.WW2), ww3: num(row.WW3), ww4: num(row.WW4), ww5: num(row.WW5),
        pt1: num(row.PT1), pt2: num(row.PT2), pt3: num(row.PT3),
        ex1: num(row.SA1), ex2: num(row.SA2), ex3: num(row.TE)
      };

      const missing = Object.keys(v).filter((k) => H[k] > 0 && v[k] === null).map((k) => k.toUpperCase());
      const hasAny = Object.values(v).some((x) => x !== null);

      let initialGrade = null, termGrade = null, descriptor = null;
      if (hasAny) {
        const ww_ps = ww_hps ? ((z(v.ww1) + z(v.ww2) + z(v.ww3) + z(v.ww4) + z(v.ww5)) / ww_hps) * 100 : 0;
        const pt_ps = pt_hps ? ((z(v.pt1) + z(v.pt2) + z(v.pt3)) / pt_hps) * 100 : 0;
        const ex_ps = ex_hps ? ((z(v.ex1) + z(v.ex2) + z(v.ex3)) / ex_hps) * 100 : 0;
        const [wWW, wPT, wEX] = SUBJECT_WEIGHTS[req.body.subject_type] || SUBJECT_WEIGHTS['Core Subjects'];
        const rawInitial = (ww_ps * wWW) + (pt_ps * wPT) + (ex_ps * wEX);   // unrounded, same as Excel
        initialGrade = Number(rawInitial.toFixed(2));                       // rounded only for storage/display
        termGrade = rawInitial === 0 ? 0 : transmute(rawInitial);
        descriptor = termGrade === 0 ? '' : termGrade > 89 ? 'Advancing' : termGrade > 79 ? 'Benchmarking'
                   : termGrade > 74 ? 'Connecting' : termGrade > 64 ? 'Developing' : 'Emerging';
      }

      await pool.query(sql, [
        studentId, subject_id, term,
        v.ww1, v.ww2, v.ww3, v.ww4, v.ww5, v.pt1, v.pt2, v.pt3, v.ex1, v.ex2, v.ex3,
        initialGrade, termGrade, descriptor, missing.length ? missing.join(', ') : null,
        H.ww1, H.ww2, H.ww3, H.ww4, H.ww5, H.pt1, H.pt2, H.pt3, H.ex1, H.ex2, H.ex3
      ]);
      successCount++;
    } catch (err) {
      console.error(`[import] failed for "${nameRaw || lrnRaw}":`, err.message);
      errors.push(`${nameRaw || lrnRaw}: ${err.message}`);
    }
  }

  console.log(`[import] success=${successCount} notFound=${notFound.length} errors=${errors.length}`);

  // If NOTHING saved, return a real error so the UI shows what went wrong
  if (successCount === 0) {
    return res.status(400).json({
      error: errors.length
        ? `Database error: ${errors[0]}`
        : `No students matched. Check that the CSV belongs to this class. Unmatched: ${notFound.slice(0, 3).join('; ')}`
    });
  }

  let message = `Imported ${successCount} students.`;
  if (notFound.length) message += ` Not found (${notFound.length}): ${notFound.slice(0, 3).join('; ')}${notFound.length > 3 ? '…' : ''}.`;
  if (errors.length) message += ` DB errors: ${errors.length}.`;
  if (hpsFromCsv) message += ' HPS taken from the file.';
  if (hpsMissing) message += ' ⚠️ HPS is not set for this term — enter the HPS values and click Save so grades compute.';

  res.json({ ok: true, message });
}));

router.post('/grades', asyncRoute(async (req, res) => {
  try {
    const g = req.body;
    if (!g.student_id) return res.json({ ok: true, skipped: true });
    await saveSubjectType(g.subject_id, req.user.id, g.subject_type);

    const n = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? null : Number(v);
    const calcN = (v) => n(v) || 0; 

    const ww1 = n(g.ww1), ww2 = n(g.ww2), ww3 = n(g.ww3), ww4 = n(g.ww4), ww5 = n(g.ww5);
    const pt1 = n(g.pt1), pt2 = n(g.pt2), pt3 = n(g.pt3);
    const ex1 = n(g.ex1), ex2 = n(g.ex2), ex3 = n(g.ex3);
    
    const ww_hps = calcN(g.ww1_hps) + calcN(g.ww2_hps) + calcN(g.ww3_hps) + calcN(g.ww4_hps) + calcN(g.ww5_hps);
    const pt_hps = calcN(g.pt1_hps) + calcN(g.pt2_hps) + calcN(g.pt3_hps);
    const ex_hps = calcN(g.ex1_hps) + calcN(g.ex2_hps) + calcN(g.ex3_hps);

    let missing = [];
    if (g.ww1_hps > 0 && ww1 === null) missing.push('WW1');
    if (g.ww2_hps > 0 && ww2 === null) missing.push('WW2');
    if (g.ww3_hps > 0 && ww3 === null) missing.push('WW3');
    if (g.ww4_hps > 0 && ww4 === null) missing.push('WW4');
    if (g.ww5_hps > 0 && ww5 === null) missing.push('WW5');
    if (g.pt1_hps > 0 && pt1 === null) missing.push('PT1');
    if (g.pt2_hps > 0 && pt2 === null) missing.push('PT2');
    if (g.pt3_hps > 0 && pt3 === null) missing.push('PT3');
    if (g.ex1_hps > 0 && ex1 === null) missing.push('EX1');
    if (g.ex2_hps > 0 && ex2 === null) missing.push('EX2');
    if (g.ex3_hps > 0 && ex3 === null) missing.push('EX3');
    
    const hasAnyGrade = [ww1, ww2, ww3, ww4, ww5, pt1, pt2, pt3, ex1, ex2, ex3].some(v => v !== null);

    let initialGrade = null;
    let termGrade = null;
    let descriptor = null;
    let missingReq = missing.length > 0 ? missing.join(', ') : null;

    if (hasAnyGrade) {
      const ww_ps = ww_hps === 0 ? 0 : ((calcN(ww1)+calcN(ww2)+calcN(ww3)+calcN(ww4)+calcN(ww5)) / ww_hps) * 100;
      const pt_ps = pt_hps === 0 ? 0 : ((calcN(pt1)+calcN(pt2)+calcN(pt3)) / pt_hps) * 100;
      const ex_ps = ex_hps === 0 ? 0 : ((calcN(ex1)+calcN(ex2)+calcN(ex3)) / ex_hps) * 100;

      const [wWW, wPT, wEX] = SUBJECT_WEIGHTS[g.subject_type] || SUBJECT_WEIGHTS['Core Subjects'];
      const rawInitial = (ww_ps * wWW) + (pt_ps * wPT) + (ex_ps * wEX);   // unrounded, same as Excel
      initialGrade = Number(rawInitial.toFixed(2));                       // rounded only for storage/display
      termGrade = rawInitial === 0 ? 0 : transmute(rawInitial);
      descriptor = termGrade === 0 ? '' : termGrade > 89 ? 'Advancing' : termGrade > 79 ? 'Benchmarking' : termGrade > 74 ? 'Connecting' : termGrade > 64 ? 'Developing' : 'Emerging';
    }

    const sql = `
      INSERT INTO grades (
        student_id, subject_id, term,
        ww1, ww2, ww3, ww4, ww5, pt1, pt2, pt3, ex1, ex2, ex3,
        initial_grade, term_grade, descriptor, missing_requirements,
        ww1_hps, ww2_hps, ww3_hps, ww4_hps, ww5_hps,
        pt1_hps, pt2_hps, pt3_hps, ex1_hps, ex2_hps, ex3_hps
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        ww1=VALUES(ww1), ww2=VALUES(ww2), ww3=VALUES(ww3), ww4=VALUES(ww4), ww5=VALUES(ww5),
        pt1=VALUES(pt1), pt2=VALUES(pt2), pt3=VALUES(pt3), ex1=VALUES(ex1), ex2=VALUES(ex2), ex3=VALUES(ex3),
        initial_grade=VALUES(initial_grade), term_grade=VALUES(term_grade), descriptor=VALUES(descriptor),
        missing_requirements=VALUES(missing_requirements),
        ww1_hps=VALUES(ww1_hps), ww2_hps=VALUES(ww2_hps), ww3_hps=VALUES(ww3_hps), ww4_hps=VALUES(ww4_hps), ww5_hps=VALUES(ww5_hps),
        pt1_hps=VALUES(pt1_hps), pt2_hps=VALUES(pt2_hps), pt3_hps=VALUES(pt3_hps), 
        ex1_hps=VALUES(ex1_hps), ex2_hps=VALUES(ex2_hps), ex3_hps=VALUES(ex3_hps)
    `;

    const vals = [
      g.student_id, g.subject_id, g.term,
      ww1, ww2, ww3, ww4, ww5, pt1, pt2, pt3, ex1, ex2, ex3,
      initialGrade, termGrade, descriptor, missingReq,
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
           MAX(CASE WHEN g.term = 3 THEN g.term_grade END) AS term3,
           MAX(g.missing_requirements) AS missing_requirements
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
  // status null / '' = clear the record for that day (toggle off)
  if (!status) {
    await pool.query('DELETE FROM attendance WHERE student_id = ? AND section_id = ? AND date = ?', [student_id, section_id, date]);
    return res.json({ ok: true, cleared: true });
  }
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

// --- AT-RISK (Early Warning) ---
// The rules live in routes/atRisk.js so the student portal's alert uses exactly the same logic.
const risk = require('./atRisk');

router.get('/at-risk', asyncRoute(async (req, res) => {
  // Subject type sets the WW/PT/EX weights. The page sends what the teacher picked: {"12":"Core Subjects",...}
  let typeMap = {};
  try { typeMap = JSON.parse(req.query.types || '{}') || {}; } catch (e) { typeMap = {}; }

  const [subjects] = await pool.query(`
    SELECT sub.id, sub.name, sub.subject_type, sub.section_id, sec.name AS section
    FROM subjects sub JOIN sections sec ON sec.id = sub.section_id
    WHERE sub.teacher_id = ? AND sub.status = 'active' ORDER BY sub.name`, [req.user.id]);
  if (!subjects.length) return res.json({ settings: risk.AT_RISK, subjects: [], students: [] });

  // Remember the chosen type in the database so students' notifications use the same weights
  for (const sub of subjects) {
    const picked = typeMap[sub.id];
    if (risk.isSubjectType(picked) && picked !== sub.subject_type) {
      await pool.query('UPDATE subjects SET subject_type = ? WHERE id = ? AND teacher_id = ?', [picked, sub.id, req.user.id]);
      sub.subject_type = picked;
    }
  }

  const [students] = await pool.query(`
    SELECT DISTINCT u.id AS student_id, u.full_name, s.lrn, s.section_id, sec.name AS section
    FROM subjects sub
    JOIN students s ON s.section_id = sub.section_id
    JOIN users u ON u.id = s.user_id
    JOIN sections sec ON sec.id = s.section_id
    WHERE sub.teacher_id = ? AND sub.status = 'active'
    ORDER BY u.full_name`, [req.user.id]);

  const [gradeRows] = await pool.query(`
    SELECT g.* FROM grades g JOIN subjects sub ON sub.id = g.subject_id
    WHERE sub.teacher_id = ? AND sub.status = 'active'`, [req.user.id]);

  const [attRows] = await pool.query(`
    SELECT a.student_id, a.date, a.status
    FROM attendance a
    JOIN students s ON s.user_id = a.student_id AND s.section_id = a.section_id
    JOIN subjects sub ON sub.section_id = s.section_id AND sub.teacher_id = ? AND sub.status = 'active'
    WHERE a.date >= DATE_SUB(CURDATE(), INTERVAL ${risk.AT_RISK.WINDOW_DAYS} DAY)
    GROUP BY a.student_id, a.date, a.status
    ORDER BY a.student_id, a.date`, [req.user.id]);

  // subject -> term -> student -> row
  const bySubject = {};
  for (const g of gradeRows) {
    if (!bySubject[g.subject_id]) bySubject[g.subject_id] = {};
    if (!bySubject[g.subject_id][g.term]) bySubject[g.subject_id][g.term] = {};
    bySubject[g.subject_id][g.term][g.student_id] = g;
  }
  const attByStudent = {};
  for (const a of attRows) { if (!attByStudent[a.student_id]) attByStudent[a.student_id] = []; attByStudent[a.student_id].push(a); }

  const result = [];
  for (const st of students) {
    const failing = [];
    for (const sub of subjects.filter(s => s.section_id === st.section_id)) {
      const entry = risk.evaluateSubject(sub, bySubject[sub.id] || {}, st.student_id, risk.weightsFor(sub.subject_type));
      if (entry) failing.push(entry);
    }
    const dropping = risk.evaluateAttendance(attByStudent[st.student_id]);
    if (!failing.length && !dropping) continue;

    result.push({
      student_id: st.student_id, full_name: st.full_name, lrn: st.lrn,
      section_id: st.section_id, section: st.section,
      failing, dropping,
      worst_grade: failing.length ? Math.min(...failing.map(f => f.term_grade ?? 100)) : null,
      severity: risk.severityOf(failing, dropping)
    });
  }

  res.json({
    settings: risk.AT_RISK,
    subjects: subjects.map(s => ({ id: s.id, name: s.name, section: s.section, section_id: s.section_id })),
    students: result
  });
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
// Class-record Excel download lives in routes/classRecordExport.js (fills templates/class-record-template.xlsx)
router.use(require('./classRecordExport'));
router.use(require('./sf2Export'));   // GET /sf2/:sectionId/export (fills templates/sf2-template.xlsx)

module.exports = router;