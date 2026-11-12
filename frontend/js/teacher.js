requireAuth('teacher');
document.getElementById('userChip').textContent = '👩‍🏫 ' + getUser().name;

let currentGradebookData = []; 
let currentFinalGradeData = [];
let currentAttendanceData = [];
let currentSubjectId = null;
let currentAttendanceSubjectId = null;
let currentSectionId = null;
let currentHistorySubjectId = null;
let mySubjectsData = []; 
let hasUnsavedChanges = false;
let currentGradebookMode = 'term'; // 'term' | 'final'

// --- DEPED CLASS RECORD CONSTANTS ---
const SUBJECT_WEIGHTS = {            
  'Academic Electives':                         [0.20, 0.50, 0.30],
  'Arts Apprenticeship':                        [0.15, 0.70, 0.15],
  'Arts, Sports, Health and Wellness Electives':[0.20, 0.60, 0.20],
  'Core Subjects':                              [0.20, 0.50, 0.30],
  'Creative Production and Innovation':         [0.15, 0.70, 0.15],
  'Design and Innovation':                      [0.40, 0.60, 0],
  'Field Exposure':                             [0.15, 0.70, 0.15],
  'Research Electives':                         [0.40, 0.60, 0],
  'TechPro Electives':                          [0.15, 0.65, 0.20],
  'Work Immersion':                             [0.20, 0.80, 0]
};
let currentSubjectType = 'Core Subjects';

const TRANSMUTATION = [
  [99.49,100],[98.31,99],[97.13,98],[95.95,97],[94.77,96],[93.59,95],[92.41,94],[91.23,93],
  [90.05,92],[88.87,91],[87.69,90],[86.51,89],[85.33,88],[84.15,87],[82.97,86],[81.79,85],
  [80.61,84],[79.43,83],[78.25,82],[77.07,81],[75.89,80],[74.71,79],[73.53,78],[72.35,77],
  [71.17,76],[69.99,75],[65.33,74],[60.66,73],[56,72],[51.33,71],[46.66,70],[42,69],
  [37.33,68],[32.67,67],[28,66],[23.34,65],[18.67,64],[14,63],[9.34,62],[4.67,61],[0,60]
];
function transmute(initial) {
  for (const [min, grade] of TRANSMUTATION) if (initial > min) return grade;
  return 0;
}
function getDescriptor(term) {
  if (term > 89) return 'Advancing';
  if (term > 79) return 'Benchmarking';
  if (term > 74) return 'Connecting';
  if (term > 64) return 'Developing';
  if (term > 0)  return 'Emerging';
  return '';
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '❌' : '⚠️'}</span> ${message}`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); }, 3000);
}

function markUnsaved() {
  hasUnsavedChanges = true;
  document.getElementById('unsavedIndicator').style.display = 'inline';
}
window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedChanges) { e.preventDefault(); e.returnValue = ''; }
});

function showView(name, el) {
  if (hasUnsavedChanges && !confirm('You have unsaved changes. Are you sure you want to leave?')) return;
  hasUnsavedChanges = false;
  document.getElementById('unsavedIndicator').style.display = 'none';

  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(`view-${name}`).style.display = 'block';
  
  if (el) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
  }
  
  const titles = {
    'subjects': 'My Classes', 'gradebook': 'Class Record', 'attendance': 'Attendance Dashboard',
    'attendance-sheet': 'Daily Attendance', 'attendance-history': 'Monthly History',
    'warning': 'Early Warning', 'sf2': 'SF2 Report'
  };
  document.getElementById('pageTitle').textContent = titles[name] || 'Teacher Portal';

  if (name === 'attendance') loadAttendanceDashboard();
  if (name === 'warning')    loadWarnings();
  if (name === 'sf2')        loadSF2();
}

// --- CLASS RECORD DASHBOARD ---
async function initDashboard() {
  const subjects = await apiFetch('/teacher/my-subjects');
  mySubjectsData = subjects; 
  const grid = document.getElementById('subjectsGrid');
  
  if (subjects.length === 0) { grid.innerHTML = '<p>No subjects assigned yet.</p>'; return; }

  grid.innerHTML = subjects.map(s => `
    <div class="subject-card" onclick="openClassRecord(${s.id})">
      <h3>📚 ${s.name}</h3>
      <p>Section: ${s.section}</p>
      <div style="margin-top: 15px; font-size: 12px; font-weight: bold; color: var(--primary);">Open Class Record →</div>
    </div>
  `).join('');
}

function openClassRecord(subjectId) {
  const subj = mySubjectsData.find(s => s.id === subjectId);
  if (!subj) return;
  currentSubjectId = subjectId;
  initSubjectType(subj);

  // Always start on Term 1 with the normal table layout
  document.getElementById('termSelect').value = '1';
  restoreGradebookLayout();

  document.getElementById('gradebookTitle').textContent = `${subj.name} — ${subj.section}`;
  showView('gradebook');
  loadGradebook();
}

// --- GRADEBOOK LOGIC ---
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

  if (rows.length > 0 && rows[0].ww1_hps !== null && rows[0].ww1_hps !== undefined) {
    const r = rows[0];
    HPS_FIELDS.forEach(f => {
      document.getElementById(`hps-${f}`).value = r[`${f}_hps`];
    });
  } else {
    document.querySelectorAll('.hps-input').forEach(input => input.value = 100);
  }
  updateHpsTotals();

  document.getElementById('gradebookSearch').value = ''; 
  renderGradebook();
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

function onGradebookSearch() {
  if (currentGradebookMode === 'final') renderFinalGrades();
  else renderGradebook();
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
document.querySelectorAll('.hps-input').forEach(el => el.addEventListener('input', updateHpsTotals));

function recalcAllRows() {
  if (currentGradebookMode === 'final') return;
  document.querySelectorAll('#gradebookBody tr[id^="row-"]').forEach(tr => calculateRowEl(tr));
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

async function saveAllGrades() {
  if (currentGradebookMode === 'final') return; 

  const btn = document.getElementById('saveBtn');
  btn.textContent = 'Saving...';
  btn.disabled = true;

  const term = document.getElementById('termSelect').value;
  const inputs = document.querySelectorAll('#gradebookBody input');
  
  const hpsValues = {};
  ['ww1','ww2','ww3','ww4','ww5','pt1','pt2','pt3','ex1','ex2','ex3'].forEach(f => {
    hpsValues[`${f}_hps`] = parseInt(document.getElementById(`hps-${f}`).value) || 0;
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

// --- ATTENDANCE RULES ---
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

// --- ATTENDANCE LOGIC ---
async function loadAttendanceDashboard() {
  const subjects = await apiFetch('/teacher/my-subjects');
  mySubjectsData = subjects;
  const grid = document.getElementById('attendanceGrid');
  if (subjects.length === 0) { grid.innerHTML = '<p>No subjects assigned yet.</p>'; return; }

  grid.innerHTML = subjects.map(s => `
    <div class="subject-card" onclick="openAttendanceSheet(${s.id})">
      <h3>📋 ${s.name}</h3>
      <p>Section: ${s.section}</p>
      <div style="margin-top: 15px; font-size: 12px; font-weight: bold; color: var(--primary);">Take Attendance →</div>
    </div>
  `).join('');
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
  const rows = await apiFetch(`/teacher/attendance/${currentAttendanceSubjectId}/${date}`);
  currentAttendanceData = rows;
  renderAttendance();
}

const ATT_BUTTONS = [
  { status: 'present', label: 'Present', icon: '✓' },
  { status: 'late',    label: 'Late',    icon: '⏰' },
  { status: 'excused', label: 'Excused', icon: '📝' },
  { status: 'absent',  label: 'Absent',  icon: '✕' }
];

function renderAttendance() {
  const searchQuery = document.getElementById('attendanceSearch').value.toLowerCase();
  let filtered = currentAttendanceData;
  if (searchQuery) filtered = filtered.filter(r => r.full_name.toLowerCase().includes(searchQuery));

  if (filtered.length === 0) {
    document.getElementById('attendanceBody').innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">No students found.</td></tr>';
    return;
  }

  document.getElementById('attendanceBody').innerHTML = filtered.map(r => {
    const t = computeAttendance({ present: r.days_present, late: r.days_late, excused: r.days_excused, absent: r.days_absent });
    const lateNote = t.converted > 0 ? ` <span title="${LATES_PER_ABSENCE} lates = 1 absence" style="font-size:10px;">(${t.converted} from lates)</span>` : '';
    const lateLeft = t.late % LATES_PER_ABSENCE;
    const warnLate = t.late > 0 ? ` <span style="font-size:10px; color: var(--muted);">${lateLeft}/${LATES_PER_ABSENCE}</span>` : '';

    const buttons = ATT_BUTTONS.map(b =>
      `<button class="btn btn-small att-btn att-${b.status} ${r.status === b.status ? 'active' : ''}" onclick="mark(${r.student_id},'${b.status}')"><span class="att-icon">${b.icon}</span> ${b.label}</button>`
    ).join('');

    return `
    <tr>
      <td style="text-align:left;">
        <strong>${r.full_name}</strong>
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
  const date = document.getElementById('attDate').value || new Date().toISOString().slice(0,10);
  try {
    await apiFetch('/teacher/attendance', { method: 'POST', body: JSON.stringify({ student_id, section_id: currentSectionId, date, status }) });
    loadAttendanceSheet();
  } catch (err) {
    showToast('Error saving attendance: ' + err.message, 'error');
  }
}

async function markAllPresent() {
  if (!confirm('Mark all students as Present for today?')) return;
  const date = document.getElementById('attDate').value || new Date().toISOString().slice(0,10);
  const promises = currentAttendanceData.map(r => apiFetch('/teacher/attendance', { method: 'POST', body: JSON.stringify({ student_id: r.student_id, section_id: currentSectionId, date, status: 'present' }) }));
  await Promise.all(promises);
  showToast('All students marked present.');
  loadAttendanceSheet();
}

// --- HISTORY ---
function openAttendanceHistory() {
  currentHistorySubjectId = currentAttendanceSubjectId;
  document.getElementById('historyTitle').textContent = document.getElementById('attendanceTitle').textContent + " — Monthly Log";
  const now = new Date();
  const monthStr = String(now.getMonth() + 1).padStart(2, '0');
  document.getElementById('historyMonth').value = `${now.getFullYear()}-${monthStr}`;
  showView('attendance-history');
  loadAttendanceHistory();
}

async function loadAttendanceHistory() {
  if (!currentHistorySubjectId) return;
  const monthVal = document.getElementById('historyMonth').value;
  if (!monthVal) return;
  const [year, month] = monthVal.split('-');
  const daysInMonth = new Date(year, month, 0).getDate(); 

  const records = await apiFetch(`/teacher/attendance-history/${currentHistorySubjectId}?month=${month}&year=${year}`);
  const students = await apiFetch(`/teacher/gradebook?term=1&subject=${currentHistorySubjectId}`);

  let headerHtml = `<th style="text-align:left; position: sticky; left:0; background:#f3f4f6; z-index:2;">Student Name</th>`;
  for (let i = 1; i <= daysInMonth; i++) headerHtml += `<th style="min-width: 30px; font-size: 11px;">${i}</th>`;
  headerHtml += `<th style="background: #dcfce7; min-width: 60px;" title="Present + Late (minus lates converted to absences)">Present</th><th style="background: #fee2e2; min-width: 60px;" title="Absent + converted lates">Absent</th>`;
  document.getElementById('historyHeaderRow').innerHTML = headerHtml;

  const studentMap = {};
  students.forEach(s => studentMap[s.student_id] = { name: s.full_name, days: {}, counts: { present: 0, late: 0, excused: 0, absent: 0 } });

  records.forEach(r => {
    const day = new Date(r.date).getDate();
    const st = studentMap[r.student_id];
    if (st && st.counts[r.status] !== undefined) {
      st.days[day] = r.status;
      st.counts[r.status]++;
    }
  });

  const CELL = {
    present: { mark: '✅', color: '#dcfce7' },
    late:    { mark: '⏰', color: '#fef3c7' },
    excused: { mark: '📝', color: '#dbeafe' },
    absent:  { mark: '❌', color: '#fee2e2' }
  };

  document.getElementById('historyBody').innerHTML = Object.values(studentMap).map(s => {
    const t = computeAttendance(s.counts);
    let rowHtml = `<tr><td style="text-align:left;">${s.name}</td>`;
    for (let i = 1; i <= daysInMonth; i++) {
      const c = CELL[s.days[i]];
      rowHtml += `<td style="background: ${c ? c.color : ''};" title="${s.days[i] || ''}">${c ? c.mark : ''}</td>`;
    }
    const tip = `Late: ${t.late}, Excused: ${t.excused}` + (t.converted ? `, ${t.converted} absence(s) from lates` : '');
    rowHtml += `<td title="${tip}"><span class="badge ok">${t.present}</span></td>`;
    rowHtml += `<td title="${tip}"><span class="badge danger">${t.absent}</span>${t.converted ? '*' : ''}</td></tr>`;
    return rowHtml;
  }).join('');
}

// --- WARNINGS & SF2 ---
async function loadWarnings() {
  const rows = await apiFetch('/teacher/at-risk');

  const failing = rows.filter(r =>
    r.avg_grade !== null && r.avg_grade !== undefined && Number(r.avg_grade) < 75
  );
  document.getElementById('failingBody').innerHTML = failing.map(r => `
    <tr>
      <td>${r.full_name}</td>
      <td><span class="badge danger">${r.avg_grade}</span></td>
    </tr>
  `).join('') || '<tr><td colspan="2" class="warning-empty">🎉 No students at risk of failing!</td></tr>';

  const dropping = rows.filter(r => {
    const t = computeAttendance({
      present: Number(r.raw_present) || 0,
      late:    Number(r.raw_late)    || 0,
      excused: Number(r.raw_excused) || 0,
      absent:  Number(r.raw_absent)  || 0
    });
    return t.absent > 4;
  }).map(r => {
    const t = computeAttendance({
      present: Number(r.raw_present) || 0,
      late:    Number(r.raw_late)    || 0,
      excused: Number(r.raw_excused) || 0,
      absent:  Number(r.raw_absent)  || 0
    });
    return { ...r, effective_absences: t.absent, converted: t.converted };
  });

  document.getElementById('droppingBody').innerHTML = dropping.map(r => `
    <tr>
      <td>${r.full_name}</td>
      <td>
        <span class="badge warn">${r.effective_absences}</span>
        ${r.converted ? `<span style="font-size:11px; color: var(--muted);">(${r.converted} from lates)</span>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="2" class="warning-empty">🎉 No students at risk of dropping!</td></tr>';
}

// *** UPDATED SF2 LOGIC ***
async function loadSF2() {
  try {
    // 1. Get the teacher's assigned subjects/sections
    const subjects = await apiFetch('/teacher/my-subjects');
    
    if (subjects.length === 0) {
      document.getElementById('sf2Body').innerHTML = '<tr><td colspan="7" style="text-align:center;">No sections assigned to you.</td></tr>';
      return;
    }

    // 2. Get the first section assigned to this teacher
    const activeSectionId = subjects[0].section_id;
    const sectionName = subjects[0].section;

    // 3. Update the page title to show which section is loaded
    document.querySelector('#view-sf2 h3').innerHTML = `🏫 School Form 2 (SF2) — ${sectionName}`;

    // 4. Fetch the data for this specific section
    const rows = await apiFetch(`/teacher/sf2/${activeSectionId}`);
    
    document.getElementById('sf2Body').innerHTML = rows.map(r => {
      const t = computeAttendance({ present: r.days_present, late: r.days_late, excused: r.days_excused, absent: r.days_absent });
      const note = t.converted ? ` <span style="font-size:11px; color: var(--muted);">(${t.converted} from lates)</span>` : '';
      return `
      <tr>
        <td>${r.lrn}</td>
        <td>${r.full_name}</td>
        <td>${t.present}</td>
        <td>${t.late}</td>
        <td>${t.excused}</td>
        <td>${t.absent}${note}</td>
        <td>${t.absent > 4 ? 'Needs Intervention' : 'Good Standing'}</td>
      </tr>`;
    }).join('');
    
  } catch (err) {
    console.error("SF2 Error:", err);
    showToast("Failed to load SF2 report.", "error");
  }
}

document.getElementById('attDate').valueAsDate = new Date();
initDashboard();