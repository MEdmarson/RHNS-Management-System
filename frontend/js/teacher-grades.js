// js/teacher-grades.js
let currentGradebookData = []; 
let currentFinalGradeData = [];
let currentSubjectId = null;
let currentGradebookMode = 'term'; 
let hasUnsavedChanges = false;

const HPS_FIELDS = ['ww1','ww2','ww3','ww4','ww5','pt1','pt2','pt3','ex1','ex2','ex3'];

function initSubjectType(subj) {
  const sel = document.getElementById('subjectTypeSelect');
  if (!sel.options.length) {
    sel.innerHTML = Object.keys(SUBJECT_WEIGHTS).map(k => `<option value="${k}">${k}</option>`).join('');
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
  updateHpsTotals();
}

function updateHpsTotals() {
  if (currentGradebookMode === 'final') return; 
  const getVal = id => { const el = document.getElementById(id); return el ? (parseInt(el.value) || 0) : 0; };
  const [wWW, wPT, wEX] = SUBJECT_WEIGHTS[currentSubjectType] || SUBJECT_WEIGHTS['Core Subjects'];
  const pct = v => Math.round(v * 10000) / 100;

  document.getElementById('hps-ww-total').textContent = getVal('hps-ww1') + getVal('hps-ww2') + getVal('hps-ww3') + getVal('hps-ww4') + getVal('hps-ww5');
  document.getElementById('hps-pt-total').textContent = getVal('hps-pt1') + getVal('hps-pt2') + getVal('hps-pt3');
  document.getElementById('hps-ex-total').textContent = getVal('hps-ex1') + getVal('hps-ex2') + getVal('hps-ex3');

  document.getElementById('hps-ww-ws').textContent = pct(wWW);
  document.getElementById('hps-pt-ws').textContent = pct(wPT);
  document.getElementById('hps-ex-ws').textContent = pct(wEX);
  document.getElementById('pct-ww').textContent = pct(wWW) + '%';
  document.getElementById('pct-pt').textContent = pct(wPT) + '%';
  document.getElementById('pct-ex').textContent = pct(wEX) + '%';

  recalcAllRows();
}

function recalcAllRows() {
  if (currentGradebookMode === 'final') return;
  document.querySelectorAll('#gradebookBody tr[id^="row-"]').forEach(tr => calculateRowEl(tr));
}

function calculateRow(input) {
  calculateRowEl(input.closest('tr'));
}

function calculateRowEl(tr) {
  if (currentGradebookMode === 'final') return;
  const studentId = tr.id.replace('row-', '');
  const num = v => (v === '' || v === null || isNaN(v)) ? 0 : v;
  const getVal = field => {
    const el = tr.querySelector(`input[data-field="${field}"]`);
    return el ? num(parseInt(el.value)) : 0;
  };
  const getHps = f => { const el = document.getElementById(`hps-${f}`); return el ? (parseInt(el.value) || 0) : 0; };
  const [wWW, wPT, wEX] = SUBJECT_WEIGHTS[currentSubjectType] || SUBJECT_WEIGHTS['Core Subjects'];

  const group = (fields, weight) => {
    const total = fields.reduce((s, f) => s + getVal(f), 0);
    const hps   = fields.reduce((s, f) => s + getHps(f), 0);
    const ps = (total === 0 || hps === 0) ? null : (total / hps) * 100;
    const ws = ps === null ? null : ps * weight;
    return { total, ps, ws };
  };

  const ww = group(['ww1','ww2','ww3','ww4','ww5'], wWW);
  const pt = group(['pt1','pt2','pt3'], wPT);
  const ex = group(['ex1','ex2','ex3'], wEX);

  let initial = null;
  if (ww.ws !== 0 && pt.ws !== 0) initial = (ww.ws || 0) + (pt.ws || 0) + (ex.ws || 0);

  const hasGrade = initial !== null && initial > 0;
  const termGrade = initial === null ? null : transmute(initial);

  const fmt2 = v => v === null ? '' : v.toFixed(2);
  const set = (id, text) => { document.getElementById(`${id}-${studentId}`).textContent = text; };

  set('ww-total', ww.total || '');  set('ww-ps', fmt2(ww.ps));  set('ww-ws', fmt2(ww.ws));
  set('pt-total', pt.total || '');  set('pt-ps', fmt2(pt.ps));  set('pt-ws', fmt2(pt.ws));
  set('ex-total', ex.total || '');  set('ex-ps', fmt2(ex.ps));  set('ex-ws', fmt2(ex.ws));

  set('initial', hasGrade ? Math.round(initial) : '');
  set('term', hasGrade ? termGrade : '');
  set('desc', hasGrade ? getDescriptor(termGrade) : '');
  const dEl = document.getElementById(`desc-${studentId}`);
  dEl.className = 'descriptor-cell' + (hasGrade ? ' desc-' + getDescriptor(termGrade).toLowerCase() : '');
}

async function loadGradebook() {
  if (!currentSubjectId) return;
  const term = document.getElementById('termSelect').value;

  if (term === 'final') {
    await loadFinalGrades();
    return;
  }

  if (currentGradebookMode === 'final') {
    restoreGradebookLayout();
  }

  const rows = await apiFetch(`/teacher/gradebook?term=${term}&subject=${currentSubjectId}`);
  currentGradebookData = rows;

  // FIX: Find the first row that actually has HPS data, not just the first student
  const hpsRow = rows.find(r => r.ww1_hps !== null && r.ww1_hps !== undefined);
  
  if (hpsRow) {
    HPS_FIELDS.forEach(f => {
      document.getElementById(`hps-${f}`).value = hpsRow[`${f}_hps`];
    });
  } else {
    // Only default to 100 if the database has absolutely no HPS data
    document.querySelectorAll('.hps-input').forEach(input => input.value = 100);
  }
  updateHpsTotals();

  document.getElementById('gradebookSearch').value = ''; 
  renderGradebook();
}

function renderGradebook() {
  const searchQuery = document.getElementById('gradebookSearch').value.toLowerCase();
  let filtered = currentGradebookData;
  if (searchQuery) filtered = filtered.filter(r => r.full_name.toLowerCase().includes(searchQuery));

  if (filtered.length === 0) {
    document.getElementById('gradebookBody').innerHTML = '<tr><td colspan="24" style="text-align:center; padding: 20px;">No students found.</td></tr>';
    return;
  }

  document.getElementById('gradebookBody').innerHTML = filtered.map(r => {
    const originalIndex = currentGradebookData.findIndex(item => item.student_id === r.student_id);
    
    const makeInput = (field) => {
      const val = r[field] ?? '';
      return `<input type="number" inputmode="numeric" pattern="[0-9]*" min="0" data-idx="${originalIndex}" data-field="${field}" value="${val}" oninput="calculateRow(this)" onchange="markUnsaved()">`;
    };

    return `
    <tr id="row-${r.student_id}">
      <td style="text-align:left;">${r.full_name}</td>
      <td>${makeInput('ww1')}</td><td>${makeInput('ww2')}</td><td>${makeInput('ww3')}</td>
      <td>${makeInput('ww4')}</td><td>${makeInput('ww5')}</td>
      <td class="computed-cell" id="ww-total-${r.student_id}"></td>
      <td class="computed-cell" id="ww-ps-${r.student_id}"></td>
      <td class="computed-cell" id="ww-ws-${r.student_id}"></td>
      
      <td>${makeInput('pt1')}</td><td>${makeInput('pt2')}</td><td>${makeInput('pt3')}</td>
      <td class="computed-cell" id="pt-total-${r.student_id}"></td>
      <td class="computed-cell" id="pt-ps-${r.student_id}"></td>
      <td class="computed-cell" id="pt-ws-${r.student_id}"></td>

      <td>${makeInput('ex1')}</td><td>${makeInput('ex2')}</td><td>${makeInput('ex3')}</td>
      <td class="computed-cell" id="ex-total-${r.student_id}"></td>
      <td class="computed-cell" id="ex-ps-${r.student_id}"></td>
      <td class="computed-cell" id="ex-ws-${r.student_id}"></td>

      <td class="initial-cell" id="initial-${r.student_id}"></td>
      <td class="term-grade-cell" id="term-${r.student_id}"></td>
      <td class="descriptor-cell" id="desc-${r.student_id}"></td>
    </tr>`;
  }).join('');

  recalcAllRows();
}

function restoreGradebookLayout() {
  currentGradebookMode = 'term';
  const table = document.getElementById('gradebookTable');
  table.classList.remove('final-mode');

  document.getElementById('subjectTypeLabel').style.display = '';
  document.getElementById('subjectTypeSelect').style.display = '';
  document.getElementById('saveBtn').style.display = '';

  document.getElementById('gradebookColgroup').innerHTML = `
    <col style="width: 160px;">
    <col style="width: 45px;"><col style="width: 45px;"><col style="width: 45px;"><col style="width: 45px;"><col style="width: 45px;">
    <col style="width: 50px;"><col style="width: 45px;"><col style="width: 45px;">
    <col style="width: 45px;"><col style="width: 45px;"><col style="width: 45px;">
    <col style="width: 50px;"><col style="width: 45px;"><col style="width: 45px;">
    <col style="width: 45px;"><col style="width: 45px;"><col style="width: 45px;">
    <col style="width: 50px;"><col style="width: 45px;"><col style="width: 45px;">
    <col style="width: 60px;"><col style="width: 60px;"><col style="width: 80px;">
  `;

  document.getElementById('gradebookThead').innerHTML = `
    <tr>
      <th rowspan="3" class="name-col">LEARNERS' NAMES</th>
      <th colspan="8" style="background:#e0e7ff;">WRITTEN/ORAL WORKS (WWs)</th>
      <th colspan="6" style="background:#dcfce7;">PRODUCT/PERFORMANCE TASKS (PTs)</th>
      <th colspan="6" style="background:#fef3c7;">EXAMINATIONS (EXs)</th>
      <th colspan="3" style="background:#f3f4f6;">GRADES</th>
    </tr>
    <tr>
      <th colspan="8" id="pct-ww" style="font-size: 10px; background:#e0e7ff;">20%</th>
      <th colspan="6" id="pct-pt" style="font-size: 10px; background:#dcfce7;">50%</th>
      <th colspan="6" id="pct-ex" style="font-size: 10px; background:#fef3c7;">30%</th>
      <th rowspan="3" style="font-size: 10px;">INITIAL<br>GRADE</th>
      <th rowspan="3" style="font-size: 10px;">TERM<br>GRADE</th>
      <th rowspan="3" style="font-size: 10px;">DESCRIPTOR</th>
    </tr>
    <tr>
      <th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>TOTAL</th><th>PS</th><th>WS</th>
      <th>1</th><th>2</th><th>3</th><th>TOTAL</th><th>PS</th><th>WS</th>
      <th>SA1</th><th>SA2</th><th>TE</th><th>TOTAL</th><th>PS</th><th>WS</th>
    </tr>
    <tr style="background:#fffbeb; font-size: 11px;">
      <th class="name-col" style="text-align: right; padding-right: 8px;">HIGHEST POSSIBLE SCORE</th>
      <th><input type="number" class="hps-input" id="hps-ww1" value="100"></th>
      <th><input type="number" class="hps-input" id="hps-ww2" value="100"></th>
      <th><input type="number" class="hps-input" id="hps-ww3" value="100"></th>
      <th><input type="number" class="hps-input" id="hps-ww4" value="100"></th>
      <th><input type="number" class="hps-input" id="hps-ww5" value="100"></th>
      <th class="computed-cell" id="hps-ww-total">0</th>
      <th>100</th>
      <th id="hps-ww-ws">20</th>
      <th><input type="number" class="hps-input" id="hps-pt1" value="100"></th>
      <th><input type="number" class="hps-input" id="hps-pt2" value="100"></th>
      <th><input type="number" class="hps-input" id="hps-pt3" value="100"></th>
      <th class="computed-cell" id="hps-pt-total">0</th>
      <th>100</th>
      <th id="hps-pt-ws">50</th>
      <th><input type="number" class="hps-input" id="hps-ex1" value="100"></th>
      <th><input type="number" class="hps-input" id="hps-ex2" value="100"></th>
      <th><input type="number" class="hps-input" id="hps-ex3" value="100"></th>
      <th class="computed-cell" id="hps-ex-total">0</th>
      <th>100</th>
      <th id="hps-ex-ws">30</th>
    </tr>
  `;

  document.querySelectorAll('.hps-input').forEach(el => el.addEventListener('input', updateHpsTotals));
}

async function loadFinalGrades() {
  currentGradebookMode = 'final';
  const table = document.getElementById('gradebookTable');
  table.classList.add('final-mode');

  document.getElementById('subjectTypeLabel').style.display = 'none';
  document.getElementById('subjectTypeSelect').style.display = 'none';
  document.getElementById('saveBtn').style.display = 'none';

  document.getElementById('gradebookColgroup').innerHTML = `
    <col style="width: 180px;">
    <col style="width: 70px;"><col style="width: 70px;"><col style="width: 70px;">
    <col style="width: 90px;"><col style="width: 110px;"><col style="width: 100px;">
  `;

  document.getElementById('gradebookThead').innerHTML = `
    <tr>
      <th rowspan="2" class="name-col">LEARNERS' NAMES</th>
      <th colspan="3" style="background:#e0e7ff;">TERM GRADES</th>
      <th rowspan="2" style="background:#dcfce7;">FINAL<br>GRADE</th>
      <th rowspan="2" style="background:#fef3c7;">DESCRIPTOR</th>
      <th rowspan="2" style="background:#f3f4f6;">REMARKS</th>
    </tr>
    <tr>
      <th style="background:#eef2ff; font-size:10px;">TERM 1</th>
      <th style="background:#eef2ff; font-size:10px;">TERM 2</th>
      <th style="background:#eef2ff; font-size:10px;">TERM 3</th>
    </tr>
  `;

  document.getElementById('gradebookSearch').value = '';
  const rows = await apiFetch(`/teacher/final-grades?subject=${currentSubjectId}`);
  currentFinalGradeData = rows;
  renderFinalGrades();
}

function renderFinalGrades() {
  const searchQuery = document.getElementById('gradebookSearch').value.toLowerCase();
  let filtered = currentFinalGradeData;
  if (searchQuery) filtered = filtered.filter(r => r.full_name.toLowerCase().includes(searchQuery));

  if (filtered.length === 0) {
    document.getElementById('gradebookBody').innerHTML =
      '<tr><td colspan="7" style="text-align:center; padding: 20px;">No students found.</td></tr>';
    return;
  }

  const fmt = v => (v === null || v === undefined || v === '') ? '' : v;

  document.getElementById('gradebookBody').innerHTML = filtered.map(r => {
    const final = r.final_grade;
    const hasFinal = final !== null && final !== undefined && final !== '';
    const remarks = hasFinal ? (Number(final) >= 75 ? 'PASSED' : 'FAILED') : '';
    const remarkClass = remarks === 'PASSED' ? 'remarks-passed' : (remarks === 'FAILED' ? 'remarks-failed' : '');
    const descriptor = r.descriptor || '';
    const descClass = descriptor ? ' desc-' + descriptor.toLowerCase() : '';

    return `
    <tr>
      <td style="text-align:left; font-weight:500;">${r.full_name}</td>
      <td class="initial-cell">${fmt(r.term1)}</td>
      <td class="initial-cell">${fmt(r.term2)}</td>
      <td class="initial-cell">${fmt(r.term3)}</td>
      <td class="final-grade-cell">${fmt(final)}</td>
      <td class="descriptor-cell${descClass}">${descriptor}</td>
      <td class="${remarkClass}" style="text-align:center;">${remarks}</td>
    </tr>`;
  }).join('');
}

function onGradebookSearch() {
  if (currentGradebookMode === 'final') renderFinalGrades();
  else renderGradebook();
}

function markUnsaved() {
  hasUnsavedChanges = true;
  document.getElementById('unsavedIndicator').style.display = 'inline';
}

async function saveAllGrades() {
  if (currentGradebookMode === 'final') return; 

  const btn = document.getElementById('saveBtn');
  btn.textContent = 'Saving...';
  btn.disabled = true;

  const term = document.getElementById('termSelect').value;
  const inputs = document.querySelectorAll('#gradebookBody input');
  
  const hpsValues = {};
  HPS_FIELDS.forEach(f => {
    // Ensure empty values become 0, and valid numbers stay numbers
    const el = document.getElementById(`hps-${f}`);
    hpsValues[`${f}_hps`] = el.value === '' ? 0 : parseInt(el.value) || 0;
  });

  const payload = {};
  inputs.forEach(input => {
    const idx = input.getAttribute('data-idx');
    const field = input.getAttribute('data-field');
    if (!payload[idx]) {
      payload[idx] = { student_id: currentGradebookData[idx].student_id, subject_id: currentSubjectId, term: term, ...hpsValues };
    }
    payload[idx][field] = input.value ? parseInt(input.value) : 0;
  });

  try {
    const promises = Object.values(payload).map(data => apiFetch('/teacher/grades', { method: 'POST', body: JSON.stringify(data) }));
    await Promise.all(promises);
    showToast('All grades saved successfully!');
    hasUnsavedChanges = false;
    document.getElementById('unsavedIndicator').style.display = 'none';
    loadGradebook(); 
  } catch (err) {
    showToast('Error saving grades.', 'error');
  } finally {
    btn.textContent = '💾 Save All Changes';
    btn.disabled = false;
  }
}