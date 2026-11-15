// routes/sf2Export.js
// GET /api/teacher/sf2/:sectionId/export?month=11&year=2026
// Fills templates/sf2-template.xlsx (DepEd School Form 2) with the section's attendance for the month.
// The template is patched at the XML level, so the logo, merged cells, borders and print setup stay exactly as in the original file.
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');
const pool = require('../config/db');

// Fixed school details used on every SF2 (not editable from the website)
const SCHOOL_ID = '300341';
const SCHOOL_NAME = 'ROSALES NATIONAL HIGH SCHOOL';

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'sf2-template.xlsx');

// ---- template geometry (from the provided SF2 file) ----
const FIRST_DAY_COL = 4;                 // column D
const MAX_DAYS = 25;                     // D..AB
const DATE_ROW = 11, DAY_ROW = 12;
// Base template: 21 male rows (14-34), 25 female rows (36-60). Extra rows are inserted automatically for bigger sections.
const BASE_MALE_ROWS = 21, BASE_FEMALE_ROWS = 25;
const MAX_PER_GENDER = 70;
const MALE_CLONE_ROW = 33, FEMALE_CLONE_ROW = 59;        // plain learner rows used as the pattern for inserted rows
const ABSENT_COL = 'AC', TARDY_COL = 'AD';
const LATES_PER_ABSENCE = 3;             // same rule as the website

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY_LETTERS = ['SU','M','T','W','TH','F','S'];

const colName = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const round2 = (n) => Math.round(n * 100) / 100;

// ---------- styles.xml: clone a template style with centering / number format overrides ----------
// opts: { numFmtId, fontId, upright (drop text rotation), shrink (shrink text to fit) }
function makeStyleCenterer(stylesXml) {
  const m = stylesXml.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
  if (!m) throw new Error('Template styles not readable');
  const xfs = m[2].match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g) || [];
  const added = [];
  const cache = new Map();
  const setAttr = (tag, name, value) =>
    new RegExp(`\\s${name}="[^"]*"`).test(tag) ? tag.replace(new RegExp(`\\s${name}="[^"]*"`), ` ${name}="${value}"`)
                                                : tag.replace(/^<xf\b/, `<xf ${name}="${value}"`);
  const center = (id, opts = {}) => {
    const key = id + '|' + JSON.stringify(opts);
    if (cache.has(key)) return cache.get(key);
    let xf = xfs[id];
    if (!xf) return id;
    // alignment
    let attrs = ' horizontal="center" vertical="center"';
    const old = xf.match(/<alignment\b([^>]*?)\/>/);
    if (old) {
      attrs = old[1].replace(/\s+horizontal="[^"]*"/, '') + ' horizontal="center"';
      if (opts.upright) attrs = attrs.replace(/\s+textRotation="[^"]*"/, '');
      if (opts.shrink) attrs = attrs.replace(/\s+wrapText="[^"]*"/, '') + ' shrinkToFit="1"';
      xf = xf.replace(old[0], `<alignment${attrs}/>`);
    } else {
      const al = `<alignment${attrs}${opts.shrink ? ' shrinkToFit="1"' : ''}/>`;
      xf = /\/>$/.test(xf) ? xf.replace(/\/>$/, `>${al}</xf>`) : xf.replace(/^(<xf\b[^>]*>)/, `$1${al}`);
    }
    xf = setAttr(xf, 'applyAlignment', '1');
    if (opts.numFmtId !== undefined) { xf = setAttr(xf, 'numFmtId', opts.numFmtId); xf = setAttr(xf, 'applyNumberFormat', '1'); }
    if (opts.fontId !== undefined) { xf = setAttr(xf, 'fontId', opts.fontId); xf = setAttr(xf, 'applyFont', '1'); }
    const newId = xfs.length + added.length;
    added.push(xf);
    cache.set(key, newId);
    return newId;
  };
  const finish = () => stylesXml.replace(m[0],
    `<cellXfs count="${xfs.length + added.length}">${m[2]}${added.join('')}</cellXfs>`);
  return { center, finish };
}

// ---------- sheet XML cell writer ----------
function makeSheetEditor(sheetXml, centerer) {
  let xml = sheetXml;
  const set = (ref, value, opts = {}) => {
    const { center = false, ...styleOpts } = opts;
    if (value === null || value === undefined || value === '') return;
    const re = new RegExp(`<c r="${ref}"((?:\\s+[A-Za-z:]+="[^"]*")*)\\s*(?:/>|>[\\s\\S]*?</c>)`);
    const m = xml.match(re);
    if (!m) throw new Error(`SF2 template: cell ${ref} not found`);
    let s = (m[1].match(/\ss="(\d+)"/) || [])[1];
    if ((center || Object.keys(styleOpts).length) && s !== undefined) s = String(centerer.center(Number(s), styleOpts));
    const sAttr = s !== undefined ? ` s="${s}"` : '';
    const cell = typeof value === 'number'
      ? `<c r="${ref}"${sAttr}><v>${value}</v></c>`
      : `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
    xml = xml.replace(m[0], () => cell);
  };
  return { set, get xml() { return xml; } };
}

// ---------- grow the form: insert extra learner rows ----------
// Shifts every row below, merged cells and the drawing anchors (the male/female arrows), then clones a plain learner row.
function insertRows(xml, afterRow, count, srcRow) {
  if (count <= 0) return xml;
  const rowRe = /<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  const renum = (rowXml, n) => rowXml.replace(/<row r="\d+"/, `<row r="${n}"`).replace(/<c r="([A-Z]+)\d+"/g, `<c r="$1${n}"`);
  let src = null;
  xml = xml.replace(rowRe, (m, r) => {
    r = Number(r);
    if (r === srcRow) src = m;
    return r > afterRow ? renum(m, r + count) : m;
  });
  if (!src) throw new Error('SF2 template: pattern row not found');

  // insert the cloned rows right before the (shifted) row that followed afterRow
  const marker = `<row r="${afterRow + count + 1}"`;
  const at = xml.indexOf(marker);
  if (at < 0) throw new Error('SF2 template: insertion point not found');
  let copies = '';
  for (let i = 1; i <= count; i++) copies += renum(src, afterRow + i);
  xml = xml.slice(0, at) + copies + xml.slice(at);

  // merged cells
  const patternMerges = [];
  xml = xml.replace(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/g, (m, c1, r1, c2, r2) => {
    r1 = Number(r1); r2 = Number(r2);
    if (r1 === srcRow && r2 === srcRow) patternMerges.push([c1, c2]);
    if (r1 > afterRow) return `<mergeCell ref="${c1}${r1 + count}:${c2}${r2 + count}"/>`;
    if (r2 > afterRow) return `<mergeCell ref="${c1}${r1}:${c2}${r2 + count}"/>`;
    return m;
  });
  let extra = '';
  for (let i = 1; i <= count; i++) patternMerges.forEach(([c1, c2]) => { extra += `<mergeCell ref="${c1}${afterRow + i}:${c2}${afterRow + i}"/>`; });
  xml = xml.replace('</mergeCells>', extra + '</mergeCells>')
           .replace(/<mergeCells count="(\d+)">/, (m, n) => `<mergeCells count="${Number(n) + patternMerges.length * count}">`);

  // used range
  return xml.replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"\/>/, (m, a, c, r) => `<dimension ref="${a}:${c}${Number(r) + count}"/>`);
}

// arrows etc. are anchored by 0-based row index; move the ones at/below the insertion point
function shiftDrawingRows(drawingXml, afterRow, count) {
  if (count <= 0) return drawingXml;
  return drawingXml.replace(/<xdr:row>(\d+)<\/xdr:row>/g, (m, r) => Number(r) >= afterRow ? `<xdr:row>${Number(r) + count}</xdr:row>` : m);
}

// ---------- main builder (pure: template buffer + data -> xlsx buffer) ----------
async function buildSf2(templateBuf, d) {
  const zip = await JSZip.loadAsync(templateBuf);
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const DRAWING_PATH = 'xl/drawings/drawing1.xml';
  const centerer = makeStyleCenterer(await zip.file('xl/styles.xml').async('string'));
  const extraMale = Math.max(0, d.males.length - BASE_MALE_ROWS);
  const extraFemale = Math.max(0, d.females.length - BASE_FEMALE_ROWS);
  let sheetXml = await zip.file(sheetPath).async('string');
  let drawingXml = await zip.file(DRAWING_PATH).async('string');
  // female block first (it sits lower), then male, so the original row numbers stay valid for both inserts
  sheetXml = insertRows(sheetXml, FEMALE_CLONE_ROW, extraFemale, FEMALE_CLONE_ROW);
  drawingXml = shiftDrawingRows(drawingXml, FEMALE_CLONE_ROW, extraFemale);
  sheetXml = insertRows(sheetXml, MALE_CLONE_ROW, extraMale, MALE_CLONE_ROW);
  drawingXml = shiftDrawingRows(drawingXml, MALE_CLONE_ROW, extraMale);
  const shift = extraMale + extraFemale;
  const MALE = { first: 14, totalRow: 35 + extraMale };
  const FEMALE = { first: 36 + extraMale, totalRow: 61 + shift };
  const COMBINED_ROW = 62 + shift;
  const sheet = makeSheetEditor(sheetXml, centerer);

  const dates = d.dates.slice(0, MAX_DAYS);
  const days = dates.length;

  // header
  sheet.set('C6', d.schoolId);
  sheet.set('K6', d.schoolYear);
  sheet.set('X6', `${d.monthName} ${d.year}`);
  sheet.set('C8', d.schoolName);
  sheet.set('X8', d.gradeLevel);
  sheet.set('AC8', d.sectionName);

  // day headers (row 11 = date, row 12 = weekday)
  dates.forEach((iso, i) => {
    const col = colName(FIRST_DAY_COL + i);
    const [y, mo, da] = iso.split('-').map(Number);
    sheet.set(`${col}${DATE_ROW}`, da, { center: true });
    sheet.set(`${col}${DAY_ROW}`, DAY_LETTERS[new Date(Date.UTC(y, mo - 1, da)).getUTCDay()], { center: true });
  });

  const stats = { male: null, female: null };
  const fillGroup = (key, group, learners) => {
    const perDayPresent = new Array(days).fill(0);
    let absentSum = 0, tardySum = 0, consecutive5 = 0;

    learners.forEach((st, idx) => {
      const row = group.first + idx;
      sheet.set(`A${row}`, idx + 1, { center: true });
      sheet.set(`B${row}`, st.name);

      let late = 0, absent = 0, run = 0, maxRun = 0;
      dates.forEach((iso, i) => {
        const status = st.marks[iso];
        const col = colName(FIRST_DAY_COL + i);
        if (status === 'absent') { absent++; run++; maxRun = Math.max(maxRun, run); }
        else run = 0;
        if (status === 'late') late++;
        if (status === 'present' || status === 'late') perDayPresent[i]++;
        const mark = status === 'absent' ? 'x' : status === 'late' ? 'T' : status === 'excused' ? 'E' : '';
        if (mark) sheet.set(`${col}${row}`, mark, { center: true });
      });
      const absentTotal = absent + Math.floor(late / LATES_PER_ABSENCE);
      absentSum += absentTotal; tardySum += late;
      if (maxRun >= 5) consecutive5++;
      sheet.set(`${ABSENT_COL}${row}`, absentTotal, { center: true });
      sheet.set(`${TARDY_COL}${row}`, late, { center: true });
    });

    perDayPresent.forEach((n, i) => sheet.set(`${colName(FIRST_DAY_COL + i)}${group.totalRow}`, n, { center: true, upright: true }));
    sheet.set(`${ABSENT_COL}${group.totalRow}`, absentSum, { center: true, numFmtId: 1 });
    sheet.set(`${TARDY_COL}${group.totalRow}`, tardySum, { center: true, numFmtId: 1 });
    stats[key] = { registered: learners.length, perDayPresent, absentSum, tardySum, consecutive5 };
  };
  fillGroup('male', MALE, d.males);
  fillGroup('female', FEMALE, d.females);

  // combined row
  for (let i = 0; i < days; i++) {
    sheet.set(`${colName(FIRST_DAY_COL + i)}${COMBINED_ROW}`, stats.male.perDayPresent[i] + stats.female.perDayPresent[i], { center: true, upright: true });
  }
  sheet.set(`${ABSENT_COL}${COMBINED_ROW}`, stats.male.absentSum + stats.female.absentSum, { center: true, numFmtId: 1 });
  sheet.set(`${TARDY_COL}${COMBINED_ROW}`, stats.male.tardySum + stats.female.tardySum, { center: true, numFmtId: 1 });

  // summary block (columns AH = M, AI = F, AJ = TOTAL)
  const M = stats.male, F = stats.female;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const totalPresentM = sum(M.perDayPresent), totalPresentF = sum(F.perDayPresent);
  const adaM = days ? totalPresentM / days : 0, adaF = days ? totalPresentF / days : 0;
  const regT = M.registered + F.registered;
  const adaT = adaM + adaF;
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);   // one decimal, e.g. 82.1

  sheet.set('AD' + (64 + shift), d.monthName, { shrink: true });                   // AC64 stays empty so the "Month:" label can overflow into it
  sheet.set('AG' + (64 + shift), days, { center: true, numFmtId: 1 });
  const put = (row, m, f, t, numFmtId) => {
    const o = { upright: true, fontId: 5, numFmtId };
    const r = row + shift;
    sheet.set(`AH${r}`, m, o); sheet.set(`AI${r}`, f, o); sheet.set(`AJ${r}`, t, o);
  };
  put(66, M.registered, F.registered, regT, 1);                      // enrolment (no 1st-Friday snapshot is stored, so = registered)
  put(70, M.registered, F.registered, regT, 1);                      // registered at end of month
  put(72, pct(M.registered, M.registered), pct(F.registered, F.registered), pct(regT, regT), 0);
  put(74, round2(adaM), round2(adaF), round2(adaT), 2);              // average daily attendance
  put(75, pct(adaM, M.registered), pct(adaF, F.registered), pct(adaT, regT), 0);
  put(77, M.consecutive5, F.consecutive5, M.consecutive5 + F.consecutive5, 1);

  zip.file(sheetPath, sheet.xml);
  zip.file(DRAWING_PATH, drawingXml);
  zip.file('xl/styles.xml', centerer.finish());
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------- route ----------
const normalizeGender = (g) => String(g || '').trim().toLowerCase().startsWith('f') ? 'female' : 'male';

router.get('/sf2/:sectionId/export', async (req, res) => {
  try {
    const sectionId = Number(req.params.sectionId);
    const month = Number(req.query.month), year = Number(req.query.year);
    if (!sectionId || !(month >= 1 && month <= 12) || !year) return res.status(400).json({ error: 'Section, month and year are required.' });

    const [auth] = await pool.query('SELECT 1 FROM subjects WHERE section_id = ? AND teacher_id = ? LIMIT 1', [sectionId, req.user.id]);
    if (!auth.length) return res.status(403).json({ error: 'Unauthorized' });

    const [[section]] = await pool.query('SELECT name FROM sections WHERE id = ?', [sectionId]);
    const [students] = await pool.query(`
      SELECT u.id AS student_id, u.full_name, s.gender, s.grade_level
      FROM students s JOIN users u ON u.id = s.user_id
      WHERE s.section_id = ? ORDER BY u.full_name`, [sectionId]);
    const [records] = await pool.query(`
      SELECT student_id, DATE_FORMAT(date, '%Y-%m-%d') AS d, status
      FROM attendance WHERE section_id = ? AND MONTH(date) = ? AND YEAR(date) = ?
      ORDER BY date`, [sectionId, month, year]);

    const byStudent = new Map();
    const dateSet = new Set();
    records.forEach((r) => {
      dateSet.add(r.d);
      if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, {});
      byStudent.get(r.student_id)[r.d] = r.status;
    });
    const dates = [...dateSet].sort();

    const males = [], females = [];
    students.forEach((s) => {
      const row = { name: s.full_name, marks: byStudent.get(s.student_id) || {} };
      (normalizeGender(s.gender) === 'female' ? females : males).push(row);
    });
    if (males.length > MAX_PER_GENDER || females.length > MAX_PER_GENDER) {
      return res.status(400).json({ error: `Too many learners for one SF2 (${males.length} male / ${females.length} female).` });
    }

    if (!fs.existsSync(TEMPLATE_PATH)) return res.status(500).json({ error: 'SF2 template missing: put sf2-template.xlsx in the templates folder.' });
    const buf = await buildSf2(fs.readFileSync(TEMPLATE_PATH), {
      schoolId: SCHOOL_ID,
      schoolName: SCHOOL_NAME,
      schoolYear: month >= 6 ? `${year}-${year + 1}` : `${year - 1}-${year}`,
      monthName: MONTHS[month - 1], year,
      gradeLevel: students[0] && students[0].grade_level != null ? String(students[0].grade_level) : '',
      sectionName: section ? section.name : '',
      dates, males, females
    });

    const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_');
    const filename = `SF2_${safe(section && section.name)}_${MONTHS[month - 1]}${year}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    console.error('SF2 EXPORT ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.buildSf2 = buildSf2;