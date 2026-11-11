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

  // Load HPS values into the header
  if (rows.length > 0 && rows[0].ww1_hps !== null) {
    const r = rows[0];
    ['ww1','ww2','ww3','ww4','ww5','pt1','pt2','pt3','ex1','ex2','ex3'].forEach(f => {
      document.getElementById(`hps-${f}`).value = r[`${f}_hps`];
    });
  } else {
    document.querySelectorAll('.hps-input').forEach(input => input.value = 100);
  }
  updateHpsTotals();
  
  document.getElementById('gradebookSearch').value = ''; 
  renderGradebook();
}

function updateHpsTotals() {
  const getVal = id => parseInt(document.getElementById(id).value) || 0;
  document.getElementById('hps-ww-total').textContent = getVal('hps-ww1') + getVal('hps-ww2') + getVal('hps-ww3') + getVal('hps-ww4') + getVal('hps-ww5');
  document.getElementById('hps-pt-total').textContent = getVal('hps-pt1') + getVal('hps-pt2') + getVal('hps-pt3');
  document.getElementById('hps-ex-total').textContent = getVal('hps-ex1') + getVal('hps-ex2') + getVal('hps-ex3');
}
document.querySelectorAll('.hps-input').forEach(el => el.addEventListener('input', updateHpsTotals));

function renderGradebook() {
  const searchQuery = document.getElementById('gradebookSearch').value.toLowerCase();
  let filtered = currentGradebookData;
  if (searchQuery) filtered = filtered.filter(r => r.full_name.toLowerCase().includes(searchQuery));

  if (filtered.length === 0) {
    document.getElementById('gradebookBody').innerHTML = '<tr><td colspan="25" style="text-align:center; padding: 20px;">No students found.</td></tr>';
    return;
  }

  document.getElementById('gradebookBody').innerHTML = filtered.map(r => {
    const originalIndex = currentGradebookData.findIndex(item => item.student_id === r.student_id);
    
    // Helper to generate input
    const makeInput = (field) => {
      const val = r[field] ?? '';
      return `<input type="number" min="0" data-idx="${originalIndex}" data-field="${field}" value="${val}" oninput="calculateRow(this)" onchange="markUnsaved()">`;
    };

    return `
    <tr id="row-${r.student_id}">
      <td style="text-align:left;">${r.full_name}</td>
      <!-- WW Inputs -->
      <td>${makeInput('ww1')}</td><td>${makeInput('ww2')}</td><td>${makeInput('ww3')}</td>
      <td>${makeInput('ww4')}</td><td>${makeInput('ww5')}</td>
      <!-- WW Computed (Calculated below) -->
      <td class="computed-cell" id="ww-total-${r.student_id}">0</td>
      <td class="computed-cell" id="ww-ps-${r.student_id}">0.00</td>
      <td class="computed-cell" id="ww-ws-${r.student_id}">0.00</td>
      
      <!-- PT Inputs -->
      <td>${makeInput('pt1')}</td><td>${makeInput('pt2')}</td><td>${makeInput('pt3')}</td>
      <!-- PT Computed -->
      <td class="computed-cell" id="pt-total-${r.student_id}">0</td>
      <td class="computed-cell" id="pt-ps-${r.student_id}">0.00</td>
      <td class="computed-cell" id="pt-ws-${r.student_id}">0.00</td>

      <!-- EX Inputs -->
      <td>${makeInput('ex1')}</td><td>${makeInput('ex2')}</td><td>${makeInput('ex3')}</td>
      <!-- EX Computed -->
      <td class="computed-cell" id="ex-total-${r.student_id}">0</td>
      <td class="computed-cell" id="ex-ps-${r.student_id}">0.00</td>
      <td class="computed-cell" id="ex-ws-${r.student_id}">0.00</td>

      <!-- Final Computed -->
      <td class="initial-cell" id="initial-${r.student_id}">0.00</td>
      <td class="term-grade-cell" id="term-${r.student_id}">0</td>
      <td class="descriptor-cell" id="desc-${r.student_id}">Emerging</td>
    </tr>`;
  }).join('');

  // *** THE FIX: Force calculation for every row immediately after rendering ***
  document.querySelectorAll('#gradebookBody input').forEach(input => {
    calculateRow(input);
  });
}

// Live calculation as teacher types
function calculateRow(input) {
  const tr = input.closest('tr');
  const studentId = tr.id.replace('row-', '');
  
  const getVal = (field) => {
    const el = tr.querySelector(`input[data-field="${field}"]`);
    return el ? (parseInt(el.value) || 0) : 0;
  };
  const getHps = (id) => parseInt(document.getElementById(id).value) || 100; 

  // 1. Calculate Totals
  const wwTotal = getVal('ww1')+getVal('ww2')+getVal('ww3')+getVal('ww4')+getVal('ww5');
  const ptTotal = getVal('pt1')+getVal('pt2')+getVal('pt3');
  const exTotal = getVal('ex1')+getVal('ex2')+getVal('ex3');

  // 2. Calculate PS
  const wwHps = getHps('hps-ww-total');
  const ptHps = getHps('hps-pt-total');
  const exHps = getHps('hps-ex-total');

  const wwPs = wwHps > 0 ? (wwTotal / wwHps) * 100 : 0;
  const ptPs = ptHps > 0 ? (ptTotal / ptHps) * 100 : 0;
  const exPs = exHps > 0 ? (exTotal / exHps) * 100 : 0;

  // 3. Calculate WS (20%, 50%, 30%)
  const wwWs = wwPs * 0.20;
  const ptWs = ptPs * 0.50;
  const exWs = exPs * 0.30;

  // 4. Calculate Initial & Term Grade
  const initialGrade = wwWs + ptWs + exWs;
  const termGrade = Math.round(initialGrade);

  // 5. Descriptor
  let desc = 'Emerging';
  if (termGrade > 89) desc = 'Advancing';
  else if (termGrade > 79) desc = 'Benchmarking';
  else if (termGrade > 74) desc = 'Connecting';
  else if (termGrade > 64) desc = 'Developing';

  // Update UI
  document.getElementById(`ww-total-${studentId}`).textContent = wwTotal;
  document.getElementById(`ww-ps-${studentId}`).textContent = wwPs.toFixed(2);
  document.getElementById(`ww-ws-${studentId}`).textContent = wwWs.toFixed(2);
  
  document.getElementById(`pt-total-${studentId}`).textContent = ptTotal;
  document.getElementById(`pt-ps-${studentId}`).textContent = ptPs.toFixed(2);
  document.getElementById(`pt-ws-${studentId}`).textContent = ptWs.toFixed(2);
  
  document.getElementById(`ex-total-${studentId}`).textContent = exTotal;
  document.getElementById(`ex-ps-${studentId}`).textContent = exPs.toFixed(2);
  document.getElementById(`ex-ws-${studentId}`).textContent = exWs.toFixed(2);

  document.getElementById(`initial-${studentId}`).textContent = initialGrade.toFixed(2);
  document.getElementById(`term-${studentId}`).textContent = termGrade;
  document.getElementById(`desc-${studentId}`).textContent = desc;
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