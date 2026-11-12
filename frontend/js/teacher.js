requireAuth('teacher');
document.getElementById('userChip').textContent = '👩‍🏫 ' + getUser().name;

let currentGradebookData = []; 
let currentAttendanceData = [];
let currentSubjectId = null;
let currentAttendanceSubjectId = null;
let currentSectionId = null;
let currentHistorySubjectId = null;
let mySubjectsData = []; 
let hasUnsavedChanges = false;

// --- DEPED CLASS RECORD CONSTANTS (mirrors Sheet2 + TERM sheets of the Excel ECR) ---
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

// Transmutation table from the Excel "Term Grade" column
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
  document.getElementById('gradebookTitle').textContent = `${subj.name} — ${subj.section}`;
  showView('gradebook');
  loadGradebook();
}

// --- GRADEBOOK LOGIC ---
async function loadGradebook() {
  if (!currentSubjectId) return;
  const term = document.getElementById('termSelect').value;
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
  const getVal = id => parseInt(document.getElementById(id).value) || 0;
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
      return `<input type="number" min="0" data-idx="${originalIndex}" data-field="${field}" value="${val}" oninput="calculateRow(this)" onchange="markUnsaved()">`;
    };

    return `
    <tr id="row-${r.student_id}">
      <td style="text-align:left;">${r.full_name}</td>
      <!-- WW -->
      <td>${makeInput('ww1')}</td><td>${makeInput('ww2')}</td><td>${makeInput('ww3')}</td>
      <td>${makeInput('ww4')}</td><td>${makeInput('ww5')}</td>
      <td class="computed-cell" id="ww-total-${r.student_id}"></td>
      <td class="computed-cell" id="ww-ps-${r.student_id}"></td>
      <td class="computed-cell" id="ww-ws-${r.student_id}"></td>
      
      <!-- PT -->
      <td>${makeInput('pt1')}</td><td>${makeInput('pt2')}</td><td>${makeInput('pt3')}</td>
      <td class="computed-cell" id="pt-total-${r.student_id}"></td>
      <td class="computed-cell" id="pt-ps-${r.student_id}"></td>
      <td class="computed-cell" id="pt-ws-${r.student_id}"></td>

      <!-- EX (SA1, SA2, TE) -->
      <td>${makeInput('ex1')}</td><td>${makeInput('ex2')}</td><td>${makeInput('ex3')}</td>
      <td class="computed-cell" id="ex-total-${r.student_id}"></td>
      <td class="computed-cell" id="ex-ps-${r.student_id}"></td>
      <td class="computed-cell" id="ex-ws-${r.student_id}"></td>

      <!-- Final -->
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
  const studentId = tr.id.replace('row-', '');
  const num = v => (v === '' || v === null || isNaN(v)) ? 0 : v;
  const getVal = field => {
    const el = tr.querySelector(`input[data-field="${field}"]`);
    return el ? num(parseInt(el.value)) : 0;
  };
  const getHps = f => parseInt(document.getElementById(`hps-${f}`).value) || 0;
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

  // *** THE FIX: Show as integer in UI, but keep the decimal math for the final grade ***
  set('initial', hasGrade ? Math.round(initial) : '');
  set('term', hasGrade ? termGrade : '');
  set('desc', hasGrade ? getDescriptor(termGrade) : '');
}

async function saveAllGrades() {
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

function renderAttendance() {
  const searchQuery = document.getElementById('attendanceSearch').value.toLowerCase();
  let filtered = currentAttendanceData;
  if (searchQuery) filtered = filtered.filter(r => r.full_name.toLowerCase().includes(searchQuery));

  if (filtered.length === 0) {
    document.getElementById('attendanceBody').innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px;">No students found.</td></tr>';
    return;
  }

  document.getElementById('attendanceBody').innerHTML = filtered.map(r => `
    <tr>
      <td style="text-align:left;">
        <strong>${r.full_name}</strong>
        <div class="mobile-stats" style="display: none;">
          <span class="badge ok">Present: ${r.days_present || 0}</span>
          <span class="badge danger">Absent: ${r.days_absent || 0}</span>
        </div>
      </td>
      <td class="hide-mobile"><span class="badge ok" style="font-size: 13px;">${r.days_present || 0} Days</span></td>
      <td class="hide-mobile"><span class="badge danger" style="font-size: 13px;">${r.days_absent || 0} Days</span></td>
      <td>
        <div style="display: flex; gap: 4px; justify-content: center;">
          <button class="btn btn-small ${r.status === 'present' ? 'btn-primary' : 'btn-secondary'}" onclick="mark(${r.student_id},'present')">Present</button>
          <button class="btn btn-small ${r.status === 'absent' ? 'btn-danger' : 'btn-secondary'}" onclick="mark(${r.student_id},'absent')">Absent</button>
        </div>
      </td>
    </tr>`).join('');
}

async function mark(student_id, status) {
  const date = document.getElementById('attDate').value || new Date().toISOString().slice(0,10);
  await apiFetch('/teacher/attendance', { method: 'POST', body: JSON.stringify({ student_id, section_id: currentSectionId, date, status }) });
  loadAttendanceSheet();
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
  headerHtml += `<th style="background: #dcfce7; min-width: 60px;">Present</th><th style="background: #fee2e2; min-width: 60px;">Absent</th>`;
  document.getElementById('historyHeaderRow').innerHTML = headerHtml;

  const studentMap = {};
  students.forEach(s => studentMap[s.student_id] = { name: s.full_name, days: {}, presentCount: 0, absentCount: 0 });

  records.forEach(r => {
    const day = new Date(r.date).getDate();
    if (studentMap[r.student_id]) {
      studentMap[r.student_id].days[day] = r.status;
      if (r.status === 'present') studentMap[r.student_id].presentCount++;
      if (r.status === 'absent') studentMap[r.student_id].absentCount++;
    }
  });

  document.getElementById('historyBody').innerHTML = Object.values(studentMap).map(s => {
    let rowHtml = `<tr><td style="text-align:left;">${s.name}</td>`;
    for (let i = 1; i <= daysInMonth; i++) {
      const status = s.days[i];
      let mark = '', color = '';
      if (status === 'present') { mark = '✅'; color = '#dcfce7'; }
      else if (status === 'absent') { mark = '❌'; color = '#fee2e2'; }
      rowHtml += `<td style="background: ${color};">${mark}</td>`;
    }
    rowHtml += `<td><span class="badge ok">${s.presentCount}</span></td><td><span class="badge danger">${s.absentCount}</span></td></tr>`;
    return rowHtml;
  }).join('');
}

// --- WARNINGS & SF2 ---
async function loadWarnings() {
  const rows = await apiFetch('/teacher/at-risk');
  document.getElementById('warningBody').innerHTML = rows.map(r => `
    <tr><td>${r.full_name}</td><td>${r.avg_grade ?? '—'}</td><td>${r.absences}</td></tr>
  `).join('') || '<tr><td colspan="3" style="text-align:center;">🎉 No at-risk students!</td></tr>';
}

async function loadSF2() {
  const rows = await apiFetch(`/teacher/sf2/1`);
  document.getElementById('sf2Body').innerHTML = rows.map(r => `
    <tr>
      <td>${r.lrn}</td><td>${r.full_name}</td><td>${r.days_present}</td><td>${r.days_absent}</td>
      <td>${r.days_absent > 4 ? 'Needs Intervention' : 'Good Standing'}</td>
    </tr>`).join('');
}

document.getElementById('attDate').valueAsDate = new Date();
initDashboard();