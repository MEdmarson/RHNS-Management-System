// utils/classRecordBuilder.js
//
// Builds the class-record .xlsx by FILLING YOUR REAL EXCEL FILE (templates/class-record-template.xlsx).
// Fonts, borders, colors, logos, column widths, print setup, validations and conditional formatting all
// come from the template itself, so the download matches the Excel exactly. Only the data rows are
// regenerated (so any number of students works) and the formulas are written with the same text the
// Excel uses.
//
// Needs: npm i jszip

const JSZip = require('jszip');

// ───────────────────────── constants (same as the Excel / website) ─────────────────────────
const SP = ' ';
const LEVELS = ['Advancing', 'Benchmarking', 'Connecting', 'Developing', 'Emerging'];

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

// The Excel's FINAL GRADE sheet leaves the REMARK column empty. The website shows PASSED/FAILED,
// so it is filled in here. Set to false to leave it blank exactly like the Excel.
const INCLUDE_REMARKS = true;

// Row layout of the template (1-based Excel rows)
const TERM_TPL  = { maleLabel: 17, male: 19, femaleLabel: 38, female: 40, tailStart: 66, tailEnd: 76 };
const FINAL_TPL = { maleLabel: 13, male: 14, femaleLabel: 34, female: 35, tailStart: 62, tailEnd: 70 };

// ───────────────────────── tiny XML helpers ─────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function colNum(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

function splitSheet(xml) {
  const a = xml.indexOf('<sheetData>');
  const b = xml.indexOf('</sheetData>');
  if (a < 0 || b < 0) throw new Error('Template sheet has no <sheetData>');
  return { head: xml.slice(0, a + 11), rows: xml.slice(a + 11, b), tail: xml.slice(b) };
}

function parseRows(rowsXml) {
  const map = new Map();
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let m;
  while ((m = rowRe.exec(rowsXml))) {
    const attrs = m[1];
    const r = Number(/\br="(\d+)"/.exec(attrs)[1]);
    const attrsNoR = attrs.replace(/\s*\br="\d+"/, '');
    const cells = [];
    const cellRe = /<c\b[^>]*?\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
    let c;
    while ((c = cellRe.exec(m[2] || ''))) {
      const a = /\br="([A-Z]+)\d+"/.exec(c[0]);
      cells.push({ col: a[1], xml: c[0] });
    }
    map.set(r, { r, attrs: attrsNoR, cells });
  }
  return map;
}

function serializeRows(map) {
  return [...map.keys()].sort((a, b) => a - b).map((r) => {
    const row = map.get(r);
    const cells = row.cells.map((c) => c.xml).join('');
    return cells ? `<row r="${r}"${row.attrs}>${cells}</row>` : `<row r="${r}"${row.attrs}/>`;
  }).join('');
}

const styleOf = (cellXml) => { const m = /^<c\b[^>]*?\ss="(\d+)"/.exec(cellXml); return m ? m[1] : null; };
const findCell = (row, col) => row && row.cells.find((c) => c.col === col);

// Build a <c> element.  o = { n } number | { s } text | { f, v } formula (+cached value) | {} empty
function cx(ref, s, o = {}) {
  const sa = s != null ? ` s="${s}"` : '';
  if (o.f !== undefined) {
    const f = `<f>${esc(o.f)}</f>`;
    if (o.v === undefined) return `<c r="${ref}"${sa}>${f}</c>`;
    if (typeof o.v === 'number') return `<c r="${ref}"${sa}>${f}<v>${o.v}</v></c>`;
    return `<c r="${ref}"${sa} t="str">${f}<v xml:space="preserve">${esc(o.v)}</v></c>`;
  }
  if (o.n !== undefined && o.n !== null) return `<c r="${ref}"${sa}><v>${o.n}</v></c>`;
  if (o.s !== undefined && o.s !== null) return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${esc(o.s)}</t></is></c>`;
  return `<c r="${ref}"${sa}/>`;
}

// Replace (or insert) one cell of a row
function putCell(row, col, xml) {
  const i = row.cells.findIndex((c) => c.col === col);
  if (i >= 0) { row.cells[i] = { col, xml }; return; }
  const n = colNum(col);
  let at = row.cells.findIndex((c) => colNum(c.col) > n);
  if (at < 0) at = row.cells.length;
  row.cells.splice(at, 0, { col, xml });
}

// Keep a template formula cell exactly (same <f>), only refresh its cached value
function withCached(cellXml, ref, v) {
  const f = /<f\b[^>]*?(?:\/>|>[\s\S]*?<\/f>)/.exec(cellXml);
  const s = styleOf(cellXml);
  const sa = s != null ? ` s="${s}"` : '';
  if (!f) return cellXml;
  if (v === undefined) return `<c r="${ref}"${sa}>${f[0]}</c>`;
  if (typeof v === 'number') return `<c r="${ref}"${sa}>${f[0]}<v>${v}</v></c>`;
  return `<c r="${ref}"${sa} t="str">${f[0]}<v xml:space="preserve">${esc(v)}</v></c>`;
}

// Copy a template row to a new row number. Formula cells are replaced by onFormula(col, newRow, xml) or emptied.
function moveRow(tplRow, newR, onFormula) {
  const cells = tplRow.cells.map(({ col, xml }) => {
    let out = xml.replace(/\br="([A-Z]+)\d+"/, `r="$1${newR}"`);
    if (/<f\b/.test(out)) {
      const rep = onFormula ? onFormula(col, newR, out) : null;
      const s = styleOf(out);
      out = rep != null ? rep : `<c r="${col}${newR}"${s != null ? ` s="${s}"` : ''}/>`;
    }
    return { col, xml: out };
  });
  return { r: newR, attrs: tplRow.attrs, cells };
}

// ───────────────────────── grade math (identical to the Excel formulas) ─────────────────────────
const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
const sum = (arr) => arr.reduce((a, b) => a + (b || 0), 0);

function transmute(w) {
  for (const [min, g] of TRANSMUTATION) if (w > min) return g;
  return 0;
}
function descriptor(x) {
  if (x > 89) return 'Advancing';
  if (x > 79) return 'Benchmarking';
  if (x > 74) return 'Connecting';
  if (x > 64) return 'Developing';
  if (x > 0) return 'Emerging';
  return 0;
}

// The value every formula in a student row evaluates to (undefined = Excel error, so no cached value)
function calcRow(sc, H, w) {
  const out = {};
  out.H = sum(sc.ww);
  out.I = out.H === 0 ? SP : (sum(H.ww) === 0 ? undefined : out.H / sum(H.ww) * 100);
  out.J = typeof out.I === 'number' ? out.I * w[0] : SP;
  out.N = sum(sc.pt);
  out.O = out.N === 0 ? SP : (sum(H.pt) === 0 ? undefined : out.N / sum(H.pt) * 100);
  out.P = typeof out.O === 'number' ? out.O * w[1] : SP;
  out.T = sum(sc.ex);
  out.U = out.T === 0 ? SP : (sum(H.ex) === 0 ? undefined : out.T / sum(H.ex) * 100);
  out.V = typeof out.U === 'number' ? out.U * w[2] : SP;
  if (out.J === 0 || out.P === 0) out.W = SP;
  else out.W = [out.J, out.P, out.V].reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  out.X = out.W === SP ? SP : transmute(out.W);
  out.Y = out.X === SP ? SP : descriptor(out.X);
  return out;
}

// ───────────────────────── formula text (copied from the Excel) ─────────────────────────
const NESTED_X = (r) => {
  let f = `IF(W${r}=" "," ",`;
  for (const [min, g] of TRANSMUTATION) f += `IF(W${r}>${min},${g},`;
  f += `IF(W${r}=0,0)`;
  f += ')'.repeat(TRANSMUTATION.length + 1);
  return f;
};
const DESC_F = (cell) =>
  `IF(${cell}=" "," ",IF(${cell}>89,"Advancing",IF(${cell}>79,"Benchmarking",IF(${cell}>74,"Connecting",IF(${cell}>64,"Developing",IF(${cell}>0,"Emerging",0))))))`;

// ───────────────────────── layouts ─────────────────────────
function termLayout(M, F) {
  const tail0 = 19 + M + F;
  const off = tail0 - TERM_TPL.tailStart;
  return { M, F, mStart: 18, mEnd: 17 + M, fLabel: 18 + M, fStart: 19 + M, fEnd: 18 + M + F, tail0, off, lastRow: TERM_TPL.tailEnd + off };
}
function finalLayout(M, F) {
  const tail0 = 15 + M + F;
  const off = tail0 - FINAL_TPL.tailStart;
  return { M, F, mStart: 14, mEnd: 13 + M, fLabel: 14 + M, fStart: 15 + M, fEnd: 14 + M + F, tail0, off, lastRow: FINAL_TPL.tailEnd + off };
}

// ───────────────────────── tail (merges / validations / conditional formats) ─────────────────────────
const rangeRows = (ref) => { const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(ref); return { c1: m[1], r1: +m[2], c2: m[3] || m[1], r2: +(m[4] || m[2]) }; };
const rangeStr = (c1, r1, c2, r2) => ((c1 === c2 && r1 === r2) ? `${c1}${r1}` : `${c1}${r1}:${c2}${r2}`);
const shiftRange = (ref, off) => { const g = rangeRows(ref); return rangeStr(g.c1, g.r1 + off, g.c2, g.r2 + off); };

function rewriteMerges(tail, keepUpToRow, tailFromRow, off, extraRefs) {
  return tail.replace(/<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/, (_, inner) => {
    const refs = [...inner.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((m) => m[1]);
    const out = [];
    for (const ref of refs) {
      const top = rangeRows(ref).r1;
      if (top <= keepUpToRow) out.push(ref);
      else if (top >= tailFromRow) out.push(shiftRange(ref, off));
    }
    out.push(...extraRefs);
    return `<mergeCells count="${out.length}">${out.map((r) => `<mergeCell ref="${r}"/>`).join('')}</mergeCells>`;
  });
}

// Score validations (whole number 1..HPS) and the "grey out exam columns" conditional format follow the student rows
function rewriteStudentRanges(tail, L) {
  const male = (c1, c2) => (L.M > 0 ? rangeStr(c1, L.mStart, c2, L.mEnd) : null);
  const female = (c1, c2) => (L.F > 0 ? rangeStr(c1, L.fStart, c2, L.fEnd) : null);

  tail = tail.replace(/<dataValidations\b[^>]*>([\s\S]*?)<\/dataValidations>/, (_, inner) => {
    const seen = new Set();
    const kept = [];
    for (const dv of inner.match(/<dataValidation\b[\s\S]*?<\/dataValidation>/g) || []) {
      const sq = /sqref="([^"]*)"/.exec(dv)[1].split(/\s+/).filter(Boolean);
      const studentOnly = sq.every((t) => rangeRows(t).r1 >= 17);
      if (!studentOnly) { kept.push(dv); continue; }
      const col = rangeRows(sq[0]).c1;
      if (seen.has(col)) continue;            // the Excel splits column E into two overlapping rules: merge them
      seen.add(col);
      const refs = [male(col, col), female(col, col)].filter(Boolean);
      if (!refs.length) continue;
      let fixed = dv.replace(/sqref="[^"]*"/, `sqref="${refs.join(' ')}"`);
      fixed = fixed.replace(/<formula2>[\s\S]*?<\/formula2>/, `<formula2>$${col}$15</formula2>`); // always "<= highest possible score"
      kept.push(fixed);
    }
    return `<dataValidations count="${kept.length}">${kept.join('')}</dataValidations>`;
  });

  tail = tail.replace(/<conditionalFormatting\b[^>]*>[\s\S]*?<\/conditionalFormatting>/g, (blk) => {
    const sq = /sqref="([^"]*)"/.exec(blk)[1].split(/\s+/).filter(Boolean);
    const out = [];
    for (const t of sq) {
      const g = rangeRows(t);
      if (g.r1 < 17) out.push(t);
      else if (g.r1 === 18) { const x = male(g.c1, g.c2); if (x) out.push(x); }
      else if (g.r1 === 39) { const x = female(g.c1, g.c2); if (x) out.push(x); }
    }
    if (!out.length) return '';
    return blk.replace(/sqref="[^"]*"/, `sqref="${out.join(' ')}"`);
  });
  return tail;
}

// open at the top-left of the sheet instead of wherever the template author left the cursor
function resetView(head) {
  return head.replace(/\s+topLeftCell="[^"]*"/, '').replace(/<selection\b[^>]*\/>/, '<selection activeCell="A1" sqref="A1"/>');
}
function setDimension(head, lastRow) {
  return head.replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)\d+"\/>/, `<dimension ref="$1:$2${lastRow}"/>`);
}

// ───────────────────────── TERM sheet ─────────────────────────
function buildTermSheet(xml, term, ctx) {
  const { male, female, hps, weights, meta, termLabel } = ctx;
  const L = termLayout(male.length, female.length);
  const sh = splitSheet(xml);
  const rows = parseRows(sh.rows);

  const tpl = {
    maleLabel: rows.get(TERM_TPL.maleLabel), male: rows.get(TERM_TPL.male),
    femaleLabel: rows.get(TERM_TPL.femaleLabel), female: rows.get(TERM_TPL.female)
  };
  if (!tpl.maleLabel || !tpl.male || !tpl.femaleLabel || !tpl.female) throw new Error('Template TERM sheet layout changed');
  const tailRows = [];
  for (let r = TERM_TPL.tailStart; r <= TERM_TPL.tailEnd; r++) if (rows.has(r)) tailRows.push(rows.get(r));

  // drop the template's sample data; keep header rows 1..16
  for (const r of [...rows.keys()]) if (r >= 17) rows.delete(r);

  // ── header ──
  const hdr = (r, col, fn) => {
    const row = rows.get(r); const c = findCell(row, col);
    if (c) putCell(row, col, fn(c.xml, `${col}${r}`, styleOf(c.xml)));
  };
  hdr(10, 'A', (x, ref, s) => cx(ref, s, { s: termLabel }));
  const gl = meta.gradeLevel;
  if (term === 1) {
    hdr(10, 'H', (x, ref, s) => cx(ref, s, typeof gl === 'number' ? { n: gl } : { s: String(gl) }));
    hdr(10, 'P', (x, ref, s) => cx(ref, s, { s: meta.teacher }));
    hdr(10, 'W', (x, ref, s) => cx(ref, s, { s: meta.subject }));
    hdr(11, 'H', (x, ref, s) => cx(ref, s, { s: meta.section }));
  } else {
    hdr(10, 'H', (x, ref) => withCached(x, ref, gl));
    hdr(10, 'P', (x, ref) => withCached(x, ref, meta.teacher));
    hdr(10, 'W', (x, ref) => withCached(x, ref, meta.subject));
    hdr(11, 'H', (x, ref) => withCached(x, ref, meta.section));
  }
  hdr(11, 'W', (x, ref, s) => cx(ref, s, { s: meta.subjectType }));
  hdr(13, 'C', (x, ref) => withCached(x, ref, weights[0]));
  hdr(13, 'K', (x, ref) => withCached(x, ref, weights[1]));
  hdr(13, 'Q', (x, ref) => withCached(x, ref, weights[2]));

  const putHps = (cols, vals) => cols.forEach((col, i) => hdr(15, col, (x, ref, s) => cx(ref, s, vals[i] > 0 ? { n: vals[i] } : {})));
  putHps(['C', 'D', 'E', 'F', 'G'], hps.ww);
  putHps(['K', 'L', 'M'], hps.pt);
  putHps(['Q', 'R', 'S'], hps.ex);
  const sw = sum(hps.ww), sp = sum(hps.pt), se = sum(hps.ex);
  hdr(15, 'H', (x, ref) => withCached(x, ref, sw));
  hdr(15, 'J', (x, ref) => withCached(x, ref, 100 * weights[0]));
  hdr(15, 'N', (x, ref) => withCached(x, ref, sp));
  hdr(15, 'P', (x, ref) => withCached(x, ref, 100 * weights[1]));
  hdr(15, 'T', (x, ref) => withCached(x, ref, se === 0 ? '' : se));
  hdr(15, 'V', (x, ref) => withCached(x, ref, 100 * weights[2]));

  // ── student rows ──
  rows.set(17, moveRow(tpl.maleLabel, 17, null));
  const calcs = { male: [], female: [] };

  const writeStudent = (r, i, st, tplRow, group) => {
    const S = (col) => styleOf(findCell(tplRow, col).xml);
    const c = calcRow(st.sc, hps, weights);
    calcs[group].push(c);
    const cells = [];
    const add = (col, o) => cells.push({ col, xml: cx(`${col}${r}`, S(col), o) });
    const sc = (arr, k) => (arr[k] === null ? {} : { n: arr[k] });

    add('A', { n: i });
    add('B', term === 1 ? { s: st.name } : { f: `'TERM 1'!B${r}`, v: st.name });
    ['C', 'D', 'E', 'F', 'G'].forEach((col, k) => add(col, sc(st.sc.ww, k)));
    add('H', { f: `SUM(C${r}:G${r})`, v: c.H });
    add('I', { f: `IF(OR(H${r}=0)," ",H${r}/$H$15*100)`, v: c.I });
    add('J', { f: `IFERROR(IF(OR(H${r}=" ")," ",I${r}*$C$13)," ")`, v: c.J });
    ['K', 'L', 'M'].forEach((col, k) => add(col, sc(st.sc.pt, k)));
    add('N', { f: `SUM(K${r}:M${r})`, v: c.N });
    add('O', { f: `IF(OR(N${r}=0)," ",N${r}/$N$15*100)`, v: c.O });
    add('P', { f: `IFERROR(O${r}*$K$13," ")`, v: c.P });
    ['Q', 'R', 'S'].forEach((col, k) => add(col, sc(st.sc.ex, k)));
    add('T', { f: `SUM(Q${r}:S${r})`, v: c.T });
    add('U', { f: `IF(OR(T${r}=0)," ",T${r}/$T$15*100)`, v: c.U });
    add('V', { f: `IFERROR(U${r}*$Q$13," ")`, v: c.V });
    add('W', { f: `IF(OR(J${r}=0,P${r}=0)," ",SUM(J${r},P${r},V${r}))`, v: c.W });
    add('X', { f: NESTED_X(r), v: c.X });
    add('Y', { f: DESC_F(`X${r}`), v: c.Y });
    rows.set(r, { r, attrs: tplRow.attrs, cells });
  };

  male.forEach((st, i) => writeStudent(L.mStart + i, i + 1, st, tpl.male, 'male'));
  rows.set(L.fLabel, moveRow(tpl.femaleLabel, L.fLabel, null));
  female.forEach((st, i) => writeStudent(L.fStart + i, i + 1, st, tpl.female, 'female'));

  // ── footer: signatures, STUDENTS' PERFORMANCE PROFILE, BASIC STATISTICS ──
  const p0 = 72 + L.off;                       // first proficiency row (Advancing)
  const levelCount = (list) => LEVELS.map((lv) => list.filter((c) => c.Y === lv).length);
  const mc = levelCount(calcs.male), fc = levelCount(calcs.female);
  const mT = sum(mc), fT = sum(fc);
  const tc = mc.map((n, i) => n + fc[i]), tT = sum(tc);
  const yM = L.M > 0 ? `$Y$${L.mStart}:$Y$${L.mEnd}` : '$Y$17:$Y$17';
  const yF = L.F > 0 ? `$Y$${L.fStart}:$Y$${L.fEnd}` : `$Y$${L.fLabel}:$Y$${L.fLabel}`;
  const pct = (n, tot) => (tot === 0 ? SP : n / tot * 100);

  const over = {};                              // keyed by the TEMPLATE address of each footer formula
  over.B67 = { f: 'P10', v: meta.teacher };
  LEVELS.forEach((lv, i) => {
    const t = 72 + i, rr = p0 + i;
    over[`C${t}`] = { f: `COUNTIF(${yM},"${lv}")`, v: mc[i] };
    over[`E${t}`] = { f: `IFERROR(C${rr}/SUM($C$${p0}:$C$${p0 + 4})*100," ")`, v: pct(mc[i], mT) };
    over[`G${t}`] = { f: `COUNTIF(${yF},"${lv}")`, v: fc[i] };
    over[`I${t}`] = { f: `IFERROR(G${rr}/SUM($G$${p0}:$G$${p0 + 4})*100," ")`, v: pct(fc[i], fT) };
    over[`J${t}`] = { f: `SUM(C${rr},G${rr})`, v: tc[i] };
    over[`K${t}`] = { f: `IFERROR(J${rr}/SUM($J$${p0}:$J$${p0 + 4})*100," ")`, v: pct(tc[i], tT) };
  });
  over.U72 = { f: `SUM(J${p0}:J${p0 + 2})`, v: tc[0] + tc[1] + tc[2] };
  over.U73 = { f: `SUM(J${p0 + 3}:J${p0 + 4})`, v: tc[3] + tc[4] };
  const all = [...male, ...female];
  ['Q', 'R', 'S'].forEach((col, k) => {
    const vals = all.map((s) => s.sc.ex[k]).filter((v) => v !== null);
    const mean = vals.length ? sum(vals) / vals.length : SP;
    over[`${col}73`] = { f: `IFERROR(AVERAGE(${col}${L.mStart}:${col}${L.fEnd})," ")`, v: mean };
    over[`${col}74`] = { f: `IFERROR(${col}${p0 + 1}/${col}15," ")`, v: (typeof mean === 'number' && hps.ex[k] > 0) ? mean / hps.ex[k] : SP };
  });

  for (const trow of tailRows) {
    const newR = trow.r + L.off;
    rows.set(newR, moveRow(trow, newR, (col, nr, x) => {
      const o = over[`${col}${trow.r}`];
      if (!o) { console.warn(`[classRecord] unhandled template formula at ${col}${trow.r}`); return null; }
      return cx(`${col}${nr}`, styleOf(x), o);
    }));
  }

  // ── assemble ──
  const head = setDimension(resetView(sh.head), L.lastRow);
  let tail = rewriteMerges(sh.tail, 17, TERM_TPL.tailStart, L.off, []);
  tail = rewriteStudentRanges(tail, L);
  return { xml: head + serializeRows(rows) + tail, layout: L, calcs };
}

// ───────────────────────── FINAL GRADE sheet ─────────────────────────
function buildFinalSheet(xml, ctx) {
  const { male, female, meta, termLayout: TL } = ctx;       // male/female: [{ name, X:[x1,x2,x3] }]
  const L = finalLayout(male.length, female.length);
  const sh = splitSheet(xml);
  const rows = parseRows(sh.rows);
  const tpl = { male: rows.get(FINAL_TPL.male), femaleLabel: rows.get(FINAL_TPL.femaleLabel), female: rows.get(FINAL_TPL.female) };
  if (!tpl.male || !tpl.femaleLabel || !tpl.female) throw new Error('Template FINAL GRADE layout changed');
  const tailRows = [];
  for (let r = FINAL_TPL.tailStart; r <= FINAL_TPL.tailEnd; r++) if (rows.has(r)) tailRows.push(rows.get(r));
  for (const r of [...rows.keys()]) if (r >= 14) rows.delete(r);

  const hdr = (r, col, v) => { const row = rows.get(r); const c = findCell(row, col); if (c) putCell(row, col, withCached(c.xml, `${col}${r}`, v)); };
  hdr(9, 'C', meta.gradeLevel);
  hdr(9, 'H', meta.subject);
  hdr(10, 'C', meta.section);
  hdr(10, 'H', meta.teacher);

  const T = ["'TERM 1'", "'TERM 2'", "'TERM 3'"];
  const writeStudent = (r, i, st, tplRow) => {
    const t = r + 4;                                         // the same student's row on the TERM sheets
    const S = (col) => styleOf(findCell(tplRow, col).xml);
    const nums = st.X.filter((x) => typeof x === 'number' && x !== 0);
    const avg = nums.length ? Math.round(sum(nums) / nums.length) : '';
    const cells = [];
    const add = (col, o) => cells.push({ col, xml: cx(`${col}${r}`, S(col), o) });
    add('A', { n: i });
    add('B', { f: `'TERM 1'!B${t}`, v: st.name });
    add('C', {}); add('D', {});
    ['E', 'F', 'G'].forEach((col, k) => add(col, { f: `IF(${T[k]}!X${t}=0,"",${T[k]}!X${t})`, v: st.X[k] === 0 ? '' : st.X[k] }));
    add('H', { f: `IFERROR(ROUND(AVERAGE(E${r}:G${r}),0),"")`, v: avg });
    add('I', { f: `IF(H${r}="","",IF(H${r}>89,"Advancing",IF(H${r}>79,"Benchmarking",IF(H${r}>74,"Connecting",IF(H${r}>64,"Developing",IF(H${r}>0,"Emerging",0))))))`,
               v: avg === '' ? '' : descriptor(avg) });
    if (INCLUDE_REMARKS) add('J', { f: `IF(H${r}="","",IF(H${r}>=75,"PASSED","FAILED"))`, v: avg === '' ? '' : (avg >= 75 ? 'PASSED' : 'FAILED') });
    else add('J', {});
    rows.set(r, { r, attrs: tplRow.attrs, cells });
  };

  male.forEach((st, i) => writeStudent(L.mStart + i, i + 1, st, tpl.male));
  rows.set(L.fLabel, moveRow(tpl.femaleLabel, L.fLabel, null));
  female.forEach((st, i) => writeStudent(L.fStart + i, i + 1, st, tpl.female));

  // footer: the signature cells link to the TERM 1 footer, which moved down by TL.off
  const o = TL.off;
  const over = {
    B65: { f: "'TERM 1'!P10", v: meta.teacher },
    G65: { f: `'TERM 1'!I${67 + o}`, v: meta.checkedBy },
    I65: { f: `'TERM 1'!V${67 + o}`, v: meta.approvedBy },
    B66: { f: `'TERM 1'!B${68 + o}`, v: meta.preparedTitle },
    G66: { f: `'TERM 1'!I${68 + o}`, v: meta.checkedTitle },
    I66: { f: `'TERM 1'!V${68 + o}`, v: meta.approvedTitle }
  };
  for (const trow of tailRows) {
    const newR = trow.r + L.off;
    rows.set(newR, moveRow(trow, newR, (col, nr, x) => {
      const ov = over[`${col}${trow.r}`];
      if (!ov) { console.warn(`[classRecord] unhandled FINAL formula at ${col}${trow.r}`); return null; }
      return cx(`${col}${nr}`, styleOf(x), ov);
    }));
  }

  // merges: header ones stay, every student row is merged B:D, footer merges move down
  const extra = [];
  for (let r = L.mStart; r <= L.mEnd; r++) extra.push(`B${r}:D${r}`);
  for (let r = L.fStart; r <= L.fEnd; r++) extra.push(`B${r}:D${r}`);
  const tail = rewriteMerges(sh.tail, 13, FINAL_TPL.tailStart, L.off, extra);
  const head = setDimension(resetView(sh.head), L.lastRow);
  return { xml: head + serializeRows(rows) + tail, layout: L };
}

// ───────────────────────── data preparation ─────────────────────────
function normalizeGender(g) {
  const v = String(g || '').trim().toLowerCase();
  return (v === 'female' || v === 'f') ? 'female' : 'male';
}
function pickHps(rows) {
  const keys = ['ww1', 'ww2', 'ww3', 'ww4', 'ww5', 'pt1', 'pt2', 'pt3', 'ex1', 'ex2', 'ex3'];
  const hit = rows.find((r) => keys.some((k) => Number(r[`${k}_hps`]) > 0)) || {};
  const g = (k) => Number(hit[`${k}_hps`]) || 0;
  return {
    ww: [1, 2, 3, 4, 5].map((i) => g(`ww${i}`)),
    pt: [1, 2, 3].map((i) => g(`pt${i}`)),
    ex: [1, 2, 3].map((i) => g(`ex${i}`))
  };
}
function scoresOf(r) {
  const g = (k) => (r ? num(r[k]) : null);
  return {
    ww: [1, 2, 3, 4, 5].map((i) => g(`ww${i}`)),
    pt: [1, 2, 3].map((i) => g(`pt${i}`)),
    ex: [1, 2, 3].map((i) => g(`ex${i}`))
  };
}
// "G11 - MAGALANG" -> grade level 11, section MAGALANG (the Excel shows them in separate cells)
function parseSection(section) {
  const m = /^\s*(?:G|Grade\s*)?(\d{1,2})\s*[-–—:]\s*(.+?)\s*$/i.exec(String(section || ''));
  return m ? { gradeLevel: Number(m[1]), section: m[2] } : { gradeLevel: 11, section: String(section || '') };
}

async function sheetPaths(zip) {
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const out = {};
  for (const m of wbXml.matchAll(/<sheet\b[^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)) {
    const relTag = (rels.match(/<Relationship\b[^>]*\/>/g) || []).find((t) => t.includes(`Id="${m[2]}"`));
    const target = /Target="([^"]+)"/.exec(relTag)[1];
    out[m[1]] = 'xl/' + target.replace(/^\/?(xl\/)?/, '');
  }
  return out;
}

// ───────────────────────── main ─────────────────────────
/**
 * @param {Buffer} templateBuf  the template .xlsx
 * @param {{subject_name:string, section:string, teacher_name:string}} meta
 * @param {string} subjectType  e.g. 'Core Subjects'
 * @param {{1:Array,2:Array,3:Array}} termRows  rows from fetchTermRows() for each term
 * @returns {Promise<Buffer>}
 */
async function buildClassRecord({ templateBuf, meta: dbMeta, subjectType, termRows }) {
  const zip = await JSZip.loadAsync(templateBuf);
  const paths = await sheetPaths(zip);

  const typeKey = SUBJECT_WEIGHTS[subjectType] ? subjectType : 'Core Subjects';
  const weights = SUBJECT_WEIGHTS[typeKey];
  const sec = parseSection(dbMeta.section);

  // signature names/titles come from the template itself (change them there, not in code)
  const tplSheet1 = await zip.file(paths['TERM 1']).async('string');
  const sig = parseRows(splitSheet(tplSheet1).rows);
  const sst = await zip.file('xl/sharedStrings.xml').async('string');
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const ssItems = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const tplText = (r, col) => {
    const c = findCell(sig.get(r), col);
    const v = c && /<v>([\s\S]*?)<\/v>/.exec(c.xml);
    if (!v) return '';
    return / t="s"/.test(c.xml) ? (ssItems[Number(v[1])] || '') : unesc(v[1]);
  };

  const meta = {
    teacher: String(dbMeta.teacher_name || '').toUpperCase(),
    subject: String(dbMeta.subject_name || '').toUpperCase(),
    subjectType: typeKey.toUpperCase(),
    section: sec.section,
    gradeLevel: sec.gradeLevel,
    checkedBy: tplText(67, 'I'), approvedBy: tplText(67, 'V'),
    preparedTitle: tplText(68, 'B'), checkedTitle: tplText(68, 'I'), approvedTitle: tplText(68, 'V')
  };

  // students: same list and order on every sheet
  const byId = {};
  for (const t of [1, 2, 3]) { byId[t] = new Map(); for (const r of termRows[t]) byId[t].set(r.student_id, r); }
  const base = termRows[1];
  const maleBase = base.filter((r) => normalizeGender(r.gender) === 'male');
  const femaleBase = base.filter((r) => normalizeGender(r.gender) === 'female');
  const mk = (list, t) => list.map((r) => ({ id: r.student_id, name: r.full_name, sc: scoresOf(byId[t].get(r.student_id)) }));

  const labels = { 1: 'FIRST TERM', 2: 'SECOND TERM', 3: 'THIRD TERM' };
  const built = {};
  for (const t of [1, 2, 3]) {
    const p = paths[`TERM ${t}`];
    const xml = await zip.file(p).async('string');
    const r = buildTermSheet(xml, t, {
      male: mk(maleBase, t), female: mk(femaleBase, t),
      hps: pickHps(termRows[t]), weights, meta, termLabel: labels[t]
    });
    zip.file(p, r.xml);
    built[t] = r;
  }

  const mkFinal = (list, g) => list.map((r, i) => ({ name: r.full_name, X: [1, 2, 3].map((t) => built[t].calcs[g][i].X) }));
  const fx = await zip.file(paths['FINAL GRADE']).async('string');
  const fr = buildFinalSheet(fx, {
    male: mkFinal(maleBase, 'male'), female: mkFinal(femaleBase, 'female'), meta, termLayout: built[1].layout
  });
  zip.file(paths['FINAL GRADE'], fr.xml);

  // workbook.xml: print areas follow the new last row, recalc on open; drop calcChain (its cell list is stale now)
  let wb = await zip.file('xl/workbook.xml').async('string');
  wb = wb.replace(/('TERM [123]'!\$A\$1:\$Y\$)\d+/g, `$1${built[1].layout.lastRow}`)
         .replace(/('FINAL GRADE'!\$A\$1:\$J\$)\d+/g, `$1${fr.layout.lastRow}`);
  wb = /<calcPr\b[^>]*\/>/.test(wb)
    ? wb.replace(/<calcPr\b([^>]*?)\/>/, (m, a) => `<calcPr${a.replace(/\s*fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`)
    : wb.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
  zip.file('xl/workbook.xml', wb);

  if (zip.file('xl/calcChain.xml')) {
    zip.remove('xl/calcChain.xml');
    const ct = await zip.file('[Content_Types].xml').async('string');
    zip.file('[Content_Types].xml', ct.replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ''));
    const rl = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    zip.file('xl/_rels/workbook.xml.rels', rl.replace(/<Relationship\b[^>]*calcChain[^>]*\/>/, ''));
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildClassRecord, SUBJECT_WEIGHTS };