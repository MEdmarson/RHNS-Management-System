requireAuth('teacher');
document.getElementById('userChip').textContent = '👩‍🏫 ' + getUser().name;

/* ==========================================================================
   STATE
   ========================================================================== */
let currentGradebookData = [];   // one model per student: { student_id, full_name, scores, status, dirty }
let hpsState = {};               // { ww1: 20, ... }
let currentSubjectId = null;
let currentSubjectType = 'Core Subjects';
let currentAttendanceData = [];
let currentAttendanceSubjectId = null;
let currentSectionId = null;
let currentHistorySubjectId = null;
let mySubjectsData = [];
let hasUnsavedChanges = false;
let forceSaveAll = false;        // HPS or subject type changed -> every row's saved grade is stale
let showCalc = false;
let lastTerm = '1';
let riskData = null;
let riskFilter = 'all';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ==========================================================================
   DEPED CLASS RECORD CONSTANTS  (keep in sync with routes/teacher.js)
   ========================================================================== */
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
const GROUPS = [
  { key: 'ww', title: 'WRITTEN / ORAL WORKS (WW)',       idx: 0 },
  { key: 'pt', title: 'PRODUCT / PERFORMANCE TASKS (PT)', idx: 1 },
  { key: 'ex', title: 'EXAMINATIONS (EX)',                idx: 2 }
];
const ACTIVITIES = [
  { key: 'ww1', g: 'ww', label: '1',   name: 'WW1' }, { key: 'ww2', g: 'ww', label: '2',   name: 'WW2' },
  { key: 'ww3', g: 'ww', label: '3',   name: 'WW3' }, { key: 'ww4', g: 'ww', label: '4',   name: 'WW4' },
  { key: 'ww5', g: 'ww', label: '5',   name: 'WW5' },
  { key: 'pt1', g: 'pt', label: '1',   name: 'PT1' }, { key: 'pt2', g: 'pt', label: '2',   name: 'PT2' },
  { key: 'pt3', g: 'pt', label: '3',   name: 'PT3' },
  { key: 'ex1', g: 'ex', label: 'SA1', name: 'SA1' }, { key: 'ex2', g: 'ex', label: 'SA2', name: 'SA2' },
  { key: 'ex3', g: 'ex', label: 'TE',  name: 'TE'  }
];
const PASSING = 75;

const TRANSMUTATION = [
  [99.49,100],[98.31,99],[97.13,98],[95.95,97],[94.77,96],[93.59,95],[92.41,94],[91.23,93],
  [90.05,92],[88.87,91],[87.69,90],[86.51,89],[85.33,88],[84.15,87],[82.97,86],[81.79,85],
  [80.61,84],[79.43,83],[78.25,82],[77.07,81],[75.89,80],[74.71,79],[73.53,78],[72.35,77],
  [71.17,76],[69.99,75],[65.33,74],[60.66,73],[56,72],[51.33,71],[46.66,70],[42,69],
  [37.33,68],[32.67,67],[28,66],[23.34,65],[18.67,64],[14,63],[9.34,62],[4.67,61],[0,60]
];
function transmute(initial) {
  for (const [min, grade] of TRANSMUTATION) if (initial > min) return grade;
  return 60;
}
function getDescriptor(term) {
  if (term > 89) return 'Advancing';
  if (term > 79) return 'Benchmarking';
  if (term > 74) return 'Connecting';
  if (term > 64) return 'Developing';
  return 'Emerging';
}

/**
 * blank  -> not yet recorded  -> left out of the grade
 * 'NS'   -> not submitted     -> counts as 0, flagged as missing
 * 'EX'   -> excused           -> left out of the grade
 * Weights are re-scaled over the components that already have data; the grade is
 * "provisional" until every weighted component has at least one score.
 */
function computeRow(m) {
  const weights = SUBJECT_WEIGHTS[currentSubjectType] || SUBJECT_WEIGHTS['Core Subjects'];
  const groups = {};
  let weighted = 0, used = 0, expected = 0;

  GROUPS.forEach(g => {
    let total = 0, max = 0;
    ACTIVITIES.filter(a => a.g === g.key).forEach(a => {
      const h = Number(hpsState[a.key]) || 0;
      const st = m.status[a.key];
      if (h <= 0 || st === 'EX') return;
      if (st === 'NS') { max += h; return; }
      const sc = m.scores[a.key];
      if (sc === null || sc === undefined) return;
      total += sc; max += h;
    });
    const w = weights[g.idx];
    const ps = max > 0 ? (total / max) * 100 : null;
    groups[g.key] = { total, max, ps, ws: ps === null ? null : ps * w };
    if (w > 0) expected += w;
    if (ps !== null && w > 0) { weighted += ps * w; used += w; }
  });

  const missing = ACTIVITIES.filter(a => m.status[a.key] === 'NS').map(a => a.name);
  const recorded = ACTIVITIES.some(a => m.status[a.key] || (m.scores[a.key] !== null && m.scores[a.key] !== undefined));
  if (used === 0) return { groups, initial: null, term: null, provisional: false, missing, recorded };

  const initial = weighted / used;
  return { groups, initial, term: transmute(initial), provisional: used < expected - 1e-9, missing, recorded };
}

/* ==========================================================================
   UI HELPERS
   ========================================================================== */
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '❌' : '⚠️'}</span> ${esc(message)}`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); }, 3000);
}

function markUnsaved() {
  hasUnsavedChanges = true;
  document.getElementById('unsavedIndicator').style.display = 'inline';
}
function clearUnsaved() {
  hasUnsavedChanges = false;
  forceSaveAll = false;
  document.getElementById('unsavedIndicator').style.display = 'none';
}
window.addEventListener('beforeunload', e => {
  if (hasUnsavedChanges) { e.preventDefault(); e.returnValue = ''; }
});

function showView(name, el) {
  if (hasUnsavedChanges && !confirm('You have unsaved changes. Are you sure you want to leave?')) return;
  clearUnsaved();

  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(`view-${name}`).style.display = 'block';

  if (el) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
  }

  const titles = {
    'subjects': 'My Classes', 'gradebook': 'Class Record', 'attendance': 'Attendance',
    'attendance-sheet': 'Daily Attendance', 'attendance-history': 'Monthly History',
    'warning': 'At-Risk Students', 'sf2': 'SF2 Report'
  };
  document.getElementById('pageTitle').textContent = titles[name] || 'Teacher Portal';

  if (name === 'attendance') loadAttendanceDashboard();
  if (name === 'warning')    loadWarnings();
  if (name === 'sf2')        initSF2();
}

/* ==========================================================================
   CLASS CARDS
   ========================================================================== */
function classCard(s, icon, action, cta) {
  const n = s.student_count != null ? ` · ${s.student_count} learners` : '';
  return `
    <div class="subject-card class-card" onclick="${action}(${s.id})">
      <h3>${icon} ${esc(s.name)}</h3>
      <div class="meta">${esc(s.section)}${n}</div>
      <div class="go">${cta} →</div>
    </div>`;
}

async function initDashboard() {
  const subjects = await apiFetch('/teacher/my-subjects');
  mySubjectsData = subjects;
  const grid = document.getElementById('subjectsGrid');
  if (!subjects.length) { grid.innerHTML = '<p>No subjects assigned yet.</p>'; return; }
  grid.innerHTML = subjects.map(s => classCard(s, '📚', 'openClassRecord', 'Open class record')).join('');
}

function openClassRecord(subjectId) {
  const subj = mySubjectsData.find(s => s.id === subjectId);
  if (!subj) return;
  currentSubjectId = subjectId;
  initSubjectType(subj);
  document.getElementById('gradebookTitle').textContent = subj.name;
  document.getElementById('gradebookSub').textContent = subj.section;
  showCalc = document.getElementById('showCalc').checked;
  showView('gradebook');
  loadGradebook();
}

/* ==========================================================================
   CLASS RECORD
   ========================================================================== */
function initSubjectType(subj) {
  const sel = document.getElementById('subjectTypeSelect');
  if (!sel.options.length) {
    sel.innerHTML = Object.keys(SUBJECT_WEIGHTS).map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
  }
  let type = subj.subject_type;
  if (!SUBJECT_WEIGHTS[type]) { try { type = localStorage.getItem(`subjectType-${subj.id}`); } catch (e) {} }
  if (!SUBJECT_WEIGHTS[type]) type = 'Core Subjects';
  sel.value = type;
  currentSubjectType = type;
}

function changeSubjectType() {
  currentSubjectType = document.getElementById('subjectTypeSelect').value;
  try { localStorage.setItem(`subjectType-${currentSubjectId}`, currentSubjectType); } catch (e) {}
  forceSaveAll = true; markUnsaved();
  updateHpsTotals();
}

function onTermChange() {
  const sel = document.getElementById('termSelect');
  if (hasUnsavedChanges && !confirm('You have unsaved changes for this term. Switch anyway?')) { sel.value = lastTerm; return; }
  lastTerm = sel.value;
  clearUnsaved();
  loadGradebook();
}

function toggleCalcColumns() {
  showCalc = document.getElementById('showCalc').checked;
  buildGradebookHeader();
  renderGradebook();
}

async function loadGradebook() {
  if (!currentSubjectId) return;
  const term = document.getElementById('termSelect').value;
  const data = await apiFetch(`/teacher/gradebook?term=${term}&subject=${currentSubjectId}`);

  hpsState = {};
  ACTIVITIES.forEach(a => { hpsState[a.key] = data.hps && data.hps[a.key] != null ? Number(data.hps[a.key]) : 100; });

  currentGradebookData = data.rows.map(r => {
    const scores = {};
    ACTIVITIES.forEach(a => { scores[a.key] = r[a.key] === null || r[a.key] === undefined ? null : Number(r[a.key]); });
    const status = { ...(r.activity_status || {}) };
    const hasNS = Object.values(status).includes('NS');
    return {
      student_id: r.student_id, full_name: r.full_name, scores, status, dirty: false,
      legacyMissing: !hasNS && r.missing_requirements ? r.missing_requirements : ''
    };
  });

  document.getElementById('gradebookSearch').value = '';
  buildGradebookHeader();
  renderGradebook();
}

/* ---- header (generated so the column structure can't drift out of sync) ---- */
function buildGradebookHeader() {
  const cols = ['<col class="col-name">'];
  let r1 = `<tr><th rowspan="3" class="name-col">LEARNERS' NAMES</th>`;
  let r2 = '<tr>', r3 = '<tr>';
  let r4 = `<tr class="hps-row"><th class="name-col hps-label">HIGHEST POSSIBLE SCORE</th>`;
  const weights = SUBJECT_WEIGHTS[currentSubjectType] || SUBJECT_WEIGHTS['Core Subjects'];

  GROUPS.forEach(g => {
    const acts = ACTIVITIES.filter(a => a.g === g.key);
    const span = acts.length + 1 + (showCalc ? 2 : 0);
    r1 += `<th colspan="${span}" class="grp-${g.key}">${g.title}</th>`;
    r2 += `<th colspan="${span}" class="grp-${g.key}" id="pct-${g.key}">${Math.round(weights[g.idx] * 10000) / 100}%</th>`;

    acts.forEach(a => {
      cols.push('<col>');
      r3 += `<th class="grp-${g.key}">${a.label}<span class="flag" data-act="${a.key}" title="Flag all blank ${a.name} cells as Not Submitted">⚑</span></th>`;
      r4 += `<th><input type="number" min="0" class="hps-input" id="hps-${a.key}" data-act="${a.key}" value="${hpsState[a.key] ?? 100}"></th>`;
    });
    if (showCalc) { cols.push('<col>'); r3 += '<th>TOTAL</th>'; r4 += `<th class="calc" id="hps-${g.key}-total">0</th>`; }
    cols.push('<col>'); r3 += '<th>PS</th>'; r4 += '<th>100</th>';
    if (showCalc) { cols.push('<col>'); r3 += '<th>WS</th>'; r4 += `<th id="hps-${g.key}-ws">${Math.round(weights[g.idx] * 10000) / 100}</th>`; }
  });

  cols.push('<col>', '<col>', '<col class="col-desc">', '<col class="col-miss">');
  r1 += `<th colspan="3">GRADES</th><th rowspan="3" style="background:#fee2e2;color:#991b1b;">NOT SUBMITTED</th></tr>`;
  r2 += `<th rowspan="2">INITIAL</th><th rowspan="2">TERM</th><th rowspan="2">DESCRIPTOR</th></tr>`;
  r3 += '</tr>';
  r4 += '<th colspan="4"></th></tr>';

  document.getElementById('gbCols').innerHTML = cols.join('');
  document.getElementById('gbHead').innerHTML = r1 + r2 + r3 + r4;
  updateHpsTotals();
}

function updateHpsTotals() {
  const weights = SUBJECT_WEIGHTS[currentSubjectType] || SUBJECT_WEIGHTS['Core Subjects'];
  const pct = v => Math.round(v * 10000) / 100;
  GROUPS.forEach(g => {
    const total = ACTIVITIES.filter(a => a.g === g.key).reduce((s, a) => s + (Number(hpsState[a.key]) || 0), 0);
    const t = document.getElementById(`hps-${g.key}-total`); if (t) t.textContent = total;
    const w = document.getElementById(`hps-${g.key}-ws`);    if (w) w.textContent = pct(weights[g.idx]);
    const p = document.getElementById(`pct-${g.key}`);       if (p) p.textContent = pct(weights[g.idx]) + '%';
  });
  recalcAllRows();
}

document.getElementById('gbHead').addEventListener('input', e => {
  const el = e.target;
  if (!el.classList.contains('hps-input')) return;
  hpsState[el.dataset.act] = parseInt(el.value) || 0;
  forceSaveAll = true; markUnsaved();
  updateHpsTotals();
});
document.getElementById('gbHead').addEventListener('click', e => {
  const flag = e.target.closest('.flag');
  if (flag) flagBlanks(flag.dataset.act);
});

/* ---- rows ---- */
function cellState(m, key) {
  const st = m.status[key];
  if (st === 'NS') return 'ns';
  if (st === 'EX') return 'ex';
  const sc = m.scores[key];
  if (sc === null || sc === undefined) return 'blank';
  return sc > (Number(hpsState[key]) || 0) ? 'over' : '';
}
function cellText(m, key) {
  const st = m.status[key];
  if (st) return st;
  const sc = m.scores[key];
  return sc === null || sc === undefined ? '' : sc;
}

function renderGradebook() {
  const q = document.getElementById('gradebookSearch').value.toLowerCase();
  const onlyMissing = document.getElementById('onlyMissing').checked;
  const tbody = document.getElementById('gradebookBody');
  const colCount = 1 + ACTIVITIES.length + GROUPS.length * (1 + (showCalc ? 2 : 0)) + 4;

  let list = currentGradebookData;
  if (q) list = list.filter(m => m.full_name.toLowerCase().includes(q));
  if (onlyMissing) list = list.filter(m => Object.values(m.status).includes('NS'));

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center; padding: 20px;">No students found.</td></tr>`;
    updateSummary();
    return;
  }

  tbody.innerHTML = list.map(m => {
    const id = m.student_id;
    const input = a => `<td><input type="text" inputmode="numeric" autocomplete="off" maxlength="4"
        class="score ${cellState(m, a.key)}" data-sid="${id}" data-act="${a.key}" value="${esc(cellText(m, a.key))}"></td>`;
    let cells = '';
    GROUPS.forEach(g => {
      cells += ACTIVITIES.filter(a => a.g === g.key).map(input).join('');
      if (showCalc) cells += `<td class="calc" id="${g.key}-total-${id}"></td>`;
      cells += `<td class="calc" id="${g.key}-ps-${id}"></td>`;
      if (showCalc) cells += `<td class="calc" id="${g.key}-ws-${id}"></td>`;
    });
    return `
    <tr id="row-${id}">
      <td>${esc(m.full_name)}</td>
      ${cells}
      <td class="initial-cell" id="initial-${id}"></td>
      <td class="term-grade-cell" id="term-${id}"></td>
      <td class="descriptor-cell" id="desc-${id}"></td>
      <td class="miss-cell" id="miss-${id}"></td>
    </tr>`;
  }).join('');

  recalcAllRows();
}

function recalcAllRows() {
  currentGradebookData.forEach(updateRowDisplay);
  updateSummary();
}

function updateRowDisplay(m) {
  const tr = document.getElementById(`row-${m.student_id}`);
  if (!tr) return;
  const id = m.student_id;
  const set = (name, text) => { const el = document.getElementById(`${name}-${id}`); if (el) el.textContent = text; };
  const f2 = v => v === null ? '' : v.toFixed(2);
  const c = computeRow(m);

  GROUPS.forEach(g => {
    const x = c.groups[g.key];
    set(`${g.key}-total`, x.max > 0 ? x.total : '');
    set(`${g.key}-ps`, f2(x.ps));
    set(`${g.key}-ws`, f2(x.ws));
  });
  set('initial', c.initial === null ? '' : Math.round(c.initial));

  const termEl = document.getElementById(`term-${id}`);
  termEl.textContent = c.term === null ? '' : c.term;
  termEl.className = 'term-grade-cell' + (c.term !== null && c.term < PASSING ? ' fail' : '') + (c.provisional ? ' prov' : '');
  termEl.title = c.provisional ? 'Provisional — some components have no scores yet' : '';

  const dEl = document.getElementById(`desc-${id}`);
  const desc = c.term === null ? '' : getDescriptor(c.term);
  dEl.textContent = desc;
  dEl.className = 'descriptor-cell' + (desc ? ' desc-' + desc.toLowerCase() : '');

  const missEl = document.getElementById(`miss-${id}`);
  missEl.innerHTML = c.missing.length
    ? c.missing.map(n => `<span class="chip ns">${n}</span>`).join('')
    : (m.legacyMissing ? `<span class="chip medium" title="Old free-text note. Flag the cells as NS to replace it.">${esc(m.legacyMissing)}</span>` : '');
  tr.classList.toggle('row-missing', c.missing.length > 0);
}

function updateSummary() {
  const all = currentGradebookData.map(computeRow);
  const graded = all.filter(c => c.term !== null);
  const avg = graded.length ? graded.reduce((s, c) => s + c.term, 0) / graded.length : null;
  const tile = (n, label, cls = '') => `<div class="gb-stat ${cls}"><b>${n}</b><span>${label}</span></div>`;
  const below = graded.filter(c => c.term < PASSING).length;
  const withMissing = all.filter(c => c.missing.length).length;
  const none = all.filter(c => !c.recorded).length;

  document.getElementById('gbSummary').innerHTML =
    tile(all.length, 'Learners') +
    tile(avg === null ? '—' : avg.toFixed(1), 'Class average (term grade)') +
    tile(below, `Below ${PASSING}`, below ? 'bad' : '') +
    tile(withMissing, 'With not-submitted work', withMissing ? 'warn' : '') +
    tile(none, 'Nothing recorded yet');
}

/* ---- cell editing (model-based: filtering/searching never loses edits) ---- */
const modelOf = sid => currentGradebookData.find(m => String(m.student_id) === String(sid));

function applyCellEdit(m) {
  m.dirty = true;
  markUnsaved();
  updateRowDisplay(m);
  updateSummary();
}
function refreshCellEl(el, m) {
  el.value = cellText(m, el.dataset.act);
  el.className = 'score ' + cellState(m, el.dataset.act);
}

const gbBody = document.getElementById('gradebookBody');

gbBody.addEventListener('input', e => {
  const el = e.target;
  if (!el.classList.contains('score')) return;
  const m = modelOf(el.dataset.sid), key = el.dataset.act;
  const raw = el.value.trim().toLowerCase();

  if (raw === '')                         { delete m.status[key]; m.scores[key] = null; }
  else if (/^\d{1,3}$/.test(raw))         { delete m.status[key]; m.scores[key] = Number(raw); }
  else if (/^(m|n|ns)$/.test(raw))        { m.status[key] = 'NS'; m.scores[key] = null; }
  else if (/^(x|e|ex)$/.test(raw))        { m.status[key] = 'EX'; m.scores[key] = null; }
  else return;                            // partial/invalid text: ignore until 'change' tidies it

  el.className = 'score ' + cellState(m, key);
  applyCellEdit(m, key);
});

gbBody.addEventListener('change', e => {            // blur: normalise what's displayed
  const el = e.target;
  if (el.classList.contains('score')) refreshCellEl(el, modelOf(el.dataset.sid));
});
gbBody.addEventListener('focusin', e => { if (e.target.classList.contains('score')) e.target.select(); });

gbBody.addEventListener('keydown', e => {           // Enter / ↓ / ↑ move through a column like a spreadsheet
  const el = e.target;
  if (!el.classList.contains('score')) return;
  if (!['Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  const tr = el.closest('tr');
  const next = e.key === 'ArrowUp' ? tr.previousElementSibling : tr.nextElementSibling;
  const target = next && next.querySelector(`input[data-act="${el.dataset.act}"]`);
  if (target) target.focus();
});

// double-click (desktop) / long-press (touch): blank → NS → EX → blank. Cells holding a score are left alone.
function cycleCell(el) {
  const m = modelOf(el.dataset.sid), key = el.dataset.act;
  if (m.scores[key] !== null && m.scores[key] !== undefined) return;
  const cur = m.status[key];
  if (!cur)             m.status[key] = 'NS';
  else if (cur === 'NS') m.status[key] = 'EX';
  else                  delete m.status[key];
  refreshCellEl(el, m);
  applyCellEdit(m, key);
}
gbBody.addEventListener('dblclick', e => { if (e.target.classList.contains('score')) cycleCell(e.target); });

let pressTimer = null;
gbBody.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' || !e.target.classList.contains('score')) return;
  const el = e.target;
  pressTimer = setTimeout(() => { pressTimer = null; el.blur(); cycleCell(el); }, 550);
});
['pointerup', 'pointercancel', 'pointermove'].forEach(ev =>
  gbBody.addEventListener(ev, () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }));

function flagBlanks(key) {
  const act = ACTIVITIES.find(a => a.key === key);
  const targets = currentGradebookData.filter(m => !m.status[key] && (m.scores[key] === null || m.scores[key] === undefined));
  if (!targets.length) { showToast(`No blank ${act.name} cells.`, 'warn'); return; }
  if (!confirm(`Mark ${targets.length} blank ${act.name} cell(s) as Not Submitted?\n\nThey will count as 0 and appear as missing work.`)) return;
  targets.forEach(m => { m.status[key] = 'NS'; m.dirty = true; });
  markUnsaved();
  renderGradebook();
}

async function saveAllGrades() {
  const btn = document.getElementById('saveBtn');
  const rows = currentGradebookData.filter(m => forceSaveAll || m.dirty);
  if (!rows.length) { showToast('Nothing to save.', 'warn'); return; }

  btn.textContent = 'Saving...';
  btn.disabled = true;
  try {
    await apiFetch('/teacher/grades/bulk', {
      method: 'POST',
      body: JSON.stringify({
        subject_id: currentSubjectId,
        term: document.getElementById('termSelect').value,
        subject_type: currentSubjectType,
        hps: hpsState,
        rows: rows.map(m => ({ student_id: m.student_id, scores: m.scores, status: m.status }))
      })
    });
    showToast(`Saved ${rows.length} learner${rows.length === 1 ? '' : 's'}.`);
    clearUnsaved();
    loadGradebook();
  } catch (err) {
    showToast('Error saving grades: ' + (err.message || ''), 'error');
  } finally {
    btn.textContent = '💾 Save changes';
    btn.disabled = false;
  }
}

/* ==========================================================================
   ATTENDANCE
   ========================================================================== */
const LATES_PER_ABSENCE = 3;
const EXCUSED_COUNTS_AS_ABSENT = false;

function computeAttendance({ present = 0, late = 0, excused = 0, absent = 0 } = {}) {
  present = +present || 0; late = +late || 0; excused = +excused || 0; absent = +absent || 0;
  const converted = Math.floor(late / LATES_PER_ABSENCE);
  return {
    present: present + late - converted,
    absent: absent + converted + (EXCUSED_COUNTS_AS_ABSENT ? excused : 0),
    late, excused, converted
  };
}

async function loadAttendanceDashboard() {
  const subjects = await apiFetch('/teacher/my-subjects');
  mySubjectsData = subjects;
  const grid = document.getElementById('attendanceGrid');
  if (!subjects.length) { grid.innerHTML = '<p>No subjects assigned yet.</p>'; return; }
  grid.innerHTML = subjects.map(s => classCard(s, '📋', 'openAttendanceSheet', 'Take attendance')).join('');
}

function openAttendanceSheet(subjectId) {
  const subj = mySubjectsData.find(s => s.id === subjectId);
  if (!subj) return;
  currentAttendanceSubjectId = subjectId;
  currentSectionId = subj.section_id;
  document.getElementById('attendanceTitle').textContent = `${subj.name} — ${subj.section}`;
  document.getElementById('attDate').valueAsDate = new Date();
  document.getElementById('attendanceSearch').value = '';
  showView('attendance-sheet');
  loadAttendanceSheet();
}

async function loadAttendanceSheet() {
  if (!currentAttendanceSubjectId) return;
  const date = document.getElementById('attDate').value || new Date().toISOString().slice(0, 10);
  currentAttendanceData = await apiFetch(`/teacher/attendance/${currentAttendanceSubjectId}/${date}`);
  renderAttendance();
}

const ATT_BUTTONS = [
  { status: 'present', label: 'Present', icon: '✓' },
  { status: 'late',    label: 'Late',    icon: '⏰' },
  { status: 'excused', label: 'Excused', icon: '📝' },
  { status: 'absent',  label: 'Absent',  icon: '✕' }
];

function renderAttendance() {
  const q = document.getElementById('attendanceSearch').value.toLowerCase();
  let list = currentAttendanceData;
  if (q) list = list.filter(r => r.full_name.toLowerCase().includes(q));

  if (!list.length) {
    document.getElementById('attendanceBody').innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">No students found.</td></tr>';
    return;
  }

  document.getElementById('attendanceBody').innerHTML = list.map(r => {
    const t = computeAttendance({ present: r.days_present, late: r.days_late, excused: r.days_excused, absent: r.days_absent });
    const lateNote = t.converted > 0 ? ` <span title="${LATES_PER_ABSENCE} lates = 1 absence" style="font-size:10px;">(${t.converted} from lates)</span>` : '';
    const warnLate = t.late > 0 ? ` <span style="font-size:10px; color: var(--muted);">${t.late % LATES_PER_ABSENCE}/${LATES_PER_ABSENCE}</span>` : '';

    const buttons = ATT_BUTTONS.map(b =>
      `<button class="btn btn-small att-btn att-${b.status} ${r.status === b.status ? 'active' : ''}" onclick="mark(${r.student_id},'${b.status}')"><span class="att-icon">${b.icon}</span> ${b.label}</button>`
    ).join('');

    return `
    <tr>
      <td style="text-align:left;">
        <strong>${esc(r.full_name)}</strong>
        <div class="mobile-stats" style="display: none;">
          <span class="badge ok">P: ${t.present}</span>
          <span class="badge warn">L: ${t.late}</span>
          <span class="badge" style="background:#dbeafe;color:#1e40af;">E: ${t.excused}</span>
          <span class="badge danger">A: ${t.absent}</span>
        </div>
      </td>
      <td class="hide-mobile"><span class="badge ok" style="font-size: 13px;">${t.present} Days</span></td>
      <td class="hide-mobile"><span class="badge warn" style="font-size: 13px;">${t.late}</span>${warnLate}</td>
      <td class="hide-mobile"><span class="badge" style="font-size: 13px; background:#dbeafe; color:#1e40af;">${t.excused}</span></td>
      <td class="hide-mobile"><span class="badge danger" style="font-size: 13px;">${t.absent} Days</span>${lateNote}</td>
      <td><div class="att-btns">${buttons}</div></td>
    </tr>`;
  }).join('');
}

async function mark(student_id, status) {
  const date = document.getElementById('attDate').value || new Date().toISOString().slice(0, 10);
  try {
    await apiFetch('/teacher/attendance', { method: 'POST', body: JSON.stringify({ student_id, section_id: currentSectionId, date, status }) });
    loadAttendanceSheet();
  } catch (err) {
    showToast('Error saving attendance: ' + err.message, 'error');
  }
}

async function markAllPresent() {
  const date = document.getElementById('attDate').value || new Date().toISOString().slice(0, 10);
  if (!confirm(`Mark all students as Present for ${date}?`)) return;
  try {
    await Promise.all(currentAttendanceData.map(r =>
      apiFetch('/teacher/attendance', { method: 'POST', body: JSON.stringify({ student_id: r.student_id, section_id: currentSectionId, date, status: 'present' }) })));
    showToast('All students marked present.');
  } catch (err) {
    showToast('Error saving attendance: ' + err.message, 'error');
  }
  loadAttendanceSheet();
}

/* ---- monthly history ---- */
function openAttendanceHistory() {
  currentHistorySubjectId = currentAttendanceSubjectId;
  document.getElementById('historyTitle').textContent = document.getElementById('attendanceTitle').textContent + ' — Monthly Log';
  const now = new Date();
  document.getElementById('historyMonth').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  showView('attendance-history');
  loadAttendanceHistory();
}

async function loadAttendanceHistory() {
  if (!currentHistorySubjectId) return;
  const monthVal = document.getElementById('historyMonth').value;
  if (!monthVal) return;
  const [year, month] = monthVal.split('-');
  const daysInMonth = new Date(year, month, 0).getDate();

  const [records, students] = await Promise.all([
    apiFetch(`/teacher/attendance-history/${currentHistorySubjectId}?month=${month}&year=${year}`),
    apiFetch(`/teacher/roster/${currentHistorySubjectId}`)
  ]);

  let head = `<th style="text-align:left; position: sticky; left:0; background:#f3f4f6; z-index:2;">Student Name</th>`;
  for (let i = 1; i <= daysInMonth; i++) head += `<th style="min-width: 30px; font-size: 11px;">${i}</th>`;
  head += `<th style="background:#dcfce7; min-width:60px;" title="Present + Late (minus lates converted to absences)">Present</th><th style="background:#fee2e2; min-width:60px;" title="Absent + converted lates">Absent</th>`;
  document.getElementById('historyHeaderRow').innerHTML = head;

  const map = {};
  students.forEach(s => map[s.student_id] = { name: s.full_name, days: {}, counts: { present: 0, late: 0, excused: 0, absent: 0 } });
  records.forEach(r => {
    const st = map[r.student_id];
    if (st && st.counts[r.status] !== undefined) {
      st.days[new Date(r.date).getDate()] = r.status;
      st.counts[r.status]++;
    }
  });

  const CELL = {
    present: { mark: '✅', color: '#dcfce7' }, late: { mark: '⏰', color: '#fef3c7' },
    excused: { mark: '📝', color: '#dbeafe' }, absent: { mark: '❌', color: '#fee2e2' }
  };

  document.getElementById('historyBody').innerHTML = Object.values(map).map(s => {
    const t = computeAttendance(s.counts);
    let row = `<tr><td style="text-align:left;">${esc(s.name)}</td>`;
    for (let i = 1; i <= daysInMonth; i++) {
      const c = CELL[s.days[i]];
      row += `<td style="background:${c ? c.color : ''};" title="${s.days[i] || ''}">${c ? c.mark : ''}</td>`;
    }
    const tip = `Late: ${t.late}, Excused: ${t.excused}` + (t.converted ? `, ${t.converted} absence(s) from lates` : '');
    row += `<td title="${tip}"><span class="badge ok">${t.present}</span></td>`;
    row += `<td title="${tip}"><span class="badge danger">${t.absent}</span>${t.converted ? '*' : ''}</td></tr>`;
    return row;
  }).join('');
}

/* ==========================================================================
   AT-RISK STUDENTS
   ========================================================================== */
async function loadWarnings() {
  try {
    riskData = await apiFetch('/teacher/at-risk');
    const sel = document.getElementById('riskSection');
    const sections = [...new Set(riskData.students.map(s => s.section))].sort();
    const keep = sel.value;
    sel.innerHTML = '<option value="">All sections</option>' + sections.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if (sections.includes(keep)) sel.value = keep;

    const t = riskData.thresholds;
    document.getElementById('riskRules').innerHTML =
      `<b>Academic:</b> term grade below ${t.PASSING} = failing, below ${t.WATCH} = borderline; ` +
      `${t.MISSING_HIGH}+ not-submitted activities in one subject = high, 1–${t.MISSING_HIGH - 1} = medium. ` +
      `Uses each learner's latest graded term per subject. <br>` +
      `<b>Attendance:</b> ${t.STREAK_HIGH}+ absences in a row = high (${t.STREAK_MEDIUM}+ = medium); ` +
      `attendance below ${t.RATE_HIGH}% = high, below ${t.RATE_MEDIUM}% = medium. ` +
      `Excused days aren't counted against; ${t.LATES_PER_ABSENCE} lates = 1 absence.`;

    renderRisk();
  } catch (err) {
    console.error(err);
    showToast('Failed to load at-risk students.', 'error');
  }
}

function setRiskFilter(f) {
  riskFilter = riskFilter === f ? 'all' : f;
  renderRisk();
}

function renderRisk() {
  if (!riskData) return;
  const s = riskData.summary;
  const tile = (key, n, label, cls = '') =>
    `<button class="risk-tile ${cls} ${riskFilter === key ? 'active' : ''}" onclick="setRiskFilter('${key}')"><b>${n}</b><span>${label}</span></button>`;
  document.getElementById('riskSummary').innerHTML =
    tile('high', s.high, 'High risk', 't-high') +
    tile('medium', s.medium, 'Medium risk', 't-medium') +
    tile('failing', s.failing, 'Failing / borderline grades') +
    tile('missing', s.missing, 'Not-submitted work') +
    tile('attendance', s.attendance, 'Attendance concerns');
  document.getElementById('riskClear').style.display = riskFilter === 'all' ? 'none' : 'inline-block';

  const section = document.getElementById('riskSection').value;
  const q = document.getElementById('riskSearch').value.toLowerCase();
  const list = riskData.students.filter(st => {
    if (section && st.section !== section) return false;
    if (q && !st.full_name.toLowerCase().includes(q)) return false;
    if (riskFilter === 'high' || riskFilter === 'medium') return st.level === riskFilter;
    if (riskFilter !== 'all') return st.categories.includes(riskFilter);
    return true;
  });

  const body = document.getElementById('riskBody');
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:20px; color: var(--success);">
      ${riskData.students.length ? 'No students match this filter.' : '🎉 No students are currently flagged.'}</td></tr>`;
    return;
  }

  const chips = flags => flags.map(f => `<span class="chip ${f.severity}">${esc(f.text)}</span>`).join('');
  body.innerHTML = list.map(st => {
    const academic = st.flags.filter(f => f.category !== 'attendance');
    const attFlags = st.flags.filter(f => f.category === 'attendance');
    const a = st.attendance;
    const attLine = a.recorded
      ? `${a.rate === null ? '—' : a.rate + '%'} attended · ${a.absent} absent${a.converted ? ` (+${a.converted} from lates)` : ''} · ${a.late} late · ${a.recorded} days recorded`
      : 'No attendance recorded';
    return `
    <tr class="lvl-${st.level}">
      <td data-label="Student"><strong>${esc(st.full_name)}</strong><div class="sub">${esc(st.section)}</div></td>
      <td data-label="Risk"><span class="chip ${st.level}">${st.level === 'high' ? 'High' : 'Medium'}</span></td>
      <td data-label="Grades & missing work">${academic.length ? chips(academic) : '<span class="chip ok">OK</span>'}</td>
      <td data-label="Attendance">${attFlags.length ? chips(attFlags) : '<span class="chip ok">OK</span>'}<div class="sub">${attLine}</div></td>
    </tr>`;
  }).join('');
}

/* ==========================================================================
   SF2
   ========================================================================== */
function initSF2() {
  const sel = document.getElementById('sf2Section');
  const seen = new Map();
  mySubjectsData.forEach(s => { if (!seen.has(s.section_id)) seen.set(s.section_id, s.section); });
  const keep = sel.value;
  sel.innerHTML = [...seen].map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('');
  if (keep && seen.has(Number(keep))) sel.value = keep;
  if (!seen.size) { document.getElementById('sf2Body').innerHTML = '<tr><td colspan="7">No sections assigned.</td></tr>'; return; }
  loadSF2();
}

async function loadSF2() {
  const sectionId = document.getElementById('sf2Section').value;
  if (!sectionId) return;
  const rows = await apiFetch(`/teacher/sf2/${sectionId}`);
  document.getElementById('sf2Body').innerHTML = rows.map(r => {
    const t = computeAttendance({ present: r.days_present, late: r.days_late, excused: r.days_excused, absent: r.days_absent });
    const note = t.converted ? ` <span style="font-size:11px; color: var(--muted);">(${t.converted} from lates)</span>` : '';
    return `
    <tr>
      <td>${esc(r.lrn)}</td><td>${esc(r.full_name)}</td><td>${t.present}</td><td>${t.late}</td><td>${t.excused}</td><td>${t.absent}${note}</td>
      <td>${t.absent > 4 ? 'Needs Intervention' : 'Good Standing'}</td>
    </tr>`;
  }).join('');
}

document.getElementById('attDate').valueAsDate = new Date();
initDashboard();