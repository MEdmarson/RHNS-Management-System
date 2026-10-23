requireAuth('teacher');
document.getElementById('userChip').textContent = '👩‍🏫 ' + getUser().name;

let currentGradebookData = []; 
let currentSubjectId = null;
let currentAttendanceSubjectId = null;
let currentSectionId = null;
let currentHistorySubjectId = null;
let mySubjectsData = []; // Global storage for subject data

function showView(name, el) {
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(`view-${name}`).style.display = 'block';
  
  if (el) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
  }
  
  const titles = {
    'subjects': 'My Classes',
    'gradebook': 'Class Record',
    'attendance': 'Attendance Dashboard',
    'attendance-sheet': 'Daily Attendance',
    'attendance-history': 'Monthly History',
    'warning': 'Early Warning',
    'sf2': 'SF2 Report'
  };
  document.getElementById('pageTitle').textContent = titles[name] || 'Teacher Portal';

  if (name === 'attendance') loadAttendanceDashboard();
  if (name === 'warning')    loadWarnings();
  if (name === 'sf2')        loadSF2();
}

// --- CLASS RECORD DASHBOARD ---
async function initDashboard() {
  const subjects = await apiFetch('/teacher/my-subjects');
  mySubjectsData = subjects; // Save for later lookups
  
  const grid = document.getElementById('subjectsGrid');
  
  if (subjects.length === 0) {
    grid.innerHTML = '<p>No subjects assigned yet.</p>';
    return;
  }

  // Pass ONLY the subjectId to avoid HTML string errors
  grid.innerHTML = subjects.map(s => `
    <div class="subject-card" onclick="openClassRecord(${s.id})">
      <h3>📚 ${s.name}</h3>
      <p>Section: ${s.section}</p>
      <div style="margin-top: 15px; font-size: 12px; font-weight: bold; color: var(--primary);">
        Open Class Record →
      </div>
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

// --- ATTENDANCE DASHBOARD ---
async function loadAttendanceDashboard() {
  const subjects = await apiFetch('/teacher/my-subjects');
  mySubjectsData = subjects;
  
  const grid = document.getElementById('attendanceGrid');
  
  if (subjects.length === 0) {
    grid.innerHTML = '<p>No subjects assigned yet.</p>';
    return;
  }

  // Pass ONLY the subjectId
  grid.innerHTML = subjects.map(s => `
    <div class="subject-card" onclick="openAttendanceSheet(${s.id})">
      <h3>📋 ${s.name}</h3>
      <p>Section: ${s.section}</p>
      <div style="margin-top: 15px; font-size: 12px; font-weight: bold; color: var(--primary);">
        Take Attendance →
      </div>
    </div>
  `).join('');
}

function openAttendanceSheet(subjectId) {
  const subj = mySubjectsData.find(s => s.id === subjectId);
  if (!subj) return;

  currentAttendanceSubjectId = subjectId;
  currentSectionId = subj.section_id; // Make sure your backend sends section_id in /my-subjects
  document.getElementById('attendanceTitle').textContent = `${subj.name} — ${subj.section}`;
  
  document.getElementById('attDate').valueAsDate = new Date();
  
  showView('attendance-sheet');
  loadAttendanceSheet();
}

async function loadAttendanceSheet() {
  if (!currentAttendanceSubjectId) return;
  
  const date = document.getElementById('attDate').value || new Date().toISOString().slice(0, 10);
  const rows = await apiFetch(`/teacher/attendance/${currentAttendanceSubjectId}/${date}`);
  
  document.getElementById('attendanceBody').innerHTML = rows.map(r => `
    <tr>
      <td style="text-align:left;">${r.full_name}</td>
      <td><span class="badge ok" style="font-size: 13px;">${r.days_present || 0} Days</span></td>
      <td><span class="badge danger" style="font-size: 13px;">${r.days_absent || 0} Days</span></td>
      <td>
        <button class="btn btn-small ${r.status === 'present' ? 'btn-primary' : 'btn-secondary'}" onclick="mark(${r.student_id},'present')">Present</button>
        <button class="btn btn-small ${r.status === 'absent' ? 'btn-danger' : 'btn-secondary'}" onclick="mark(${r.student_id},'absent')">Absent</button>
      </td>
    </tr>`).join('');
}

async function mark(student_id, status) {
  const date = document.getElementById('attDate').value || new Date().toISOString().slice(0,10);
  await apiFetch('/teacher/attendance', {
    method: 'POST',
    body: JSON.stringify({ student_id, section_id: currentSectionId, date, status })
  });
  loadAttendanceSheet();
}

// --- ATTENDANCE HISTORY (MONTHLY GRID) ---
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

  // Build Header
  let headerHtml = `<th style="text-align:left; position: sticky; left:0; background:#f3f4f6; z-index:2;">Student Name</th>`;
  for (let i = 1; i <= daysInMonth; i++) {
    headerHtml += `<th style="min-width: 30px; font-size: 11px;">${i}</th>`;
  }
  headerHtml += `<th style="background: #dcfce7; min-width: 60px;">Present</th>`;
  headerHtml += `<th style="background: #fee2e2; min-width: 60px;">Absent</th>`;
  document.getElementById('historyHeaderRow').innerHTML = headerHtml;

  // Group Records
  const studentMap = {};
  students.forEach(s => {
    studentMap[s.student_id] = {
      name: s.full_name,
      days: {},
      presentCount: 0,
      absentCount: 0
    };
  });

  records.forEach(r => {
    const day = new Date(r.date).getDate();
    if (studentMap[r.student_id]) {
      studentMap[r.student_id].days[day] = r.status;
      if (r.status === 'present') studentMap[r.student_id].presentCount++;
      if (r.status === 'absent') studentMap[r.student_id].absentCount++;
    }
  });

  // Render Table Body
  document.getElementById('historyBody').innerHTML = Object.values(studentMap).map(s => {
    let rowHtml = `<tr><td style="text-align:left;">${s.name}</td>`;
    
    for (let i = 1; i <= daysInMonth; i++) {
      const status = s.days[i];
      let mark = '';
      let color = '';
      
      if (status === 'present') { mark = '✅'; color = '#dcfce7'; }
      else if (status === 'absent') { mark = '❌'; color = '#fee2e2'; }
      
      rowHtml += `<td style="background: ${color};">${mark}</td>`;
    }
    
    rowHtml += `<td><span class="badge ok">${s.presentCount}</span></td>`;
    rowHtml += `<td><span class="badge danger">${s.absentCount}</span></td>`;
    rowHtml += `</tr>`;
    
    return rowHtml;
  }).join('');
}

// --- CLASS RECORD LOGIC ---
async function loadGradebook() {
  if (!currentSubjectId) return;
  const term = document.getElementById('termSelect').value;
  const rows = await apiFetch(`/teacher/gradebook?term=${term}&subject=${currentSubjectId}`);
  currentGradebookData = rows; 

  if (rows.length > 0 && rows[0].ww1_hps !== null) {
    const r = rows[0];
    document.getElementById('hps-ww1').value = r.ww1_hps;
    document.getElementById('hps-ww2').value = r.ww2_hps;
    document.getElementById('hps-ww3').value = r.ww3_hps;
    document.getElementById('hps-ww4').value = r.ww4_hps;
    document.getElementById('hps-ww5').value = r.ww5_hps;
    document.getElementById('hps-pt1').value = r.pt1_hps;
    document.getElementById('hps-pt2').value = r.pt2_hps;
    document.getElementById('hps-pt3').value = r.pt3_hps;
    document.getElementById('hps-ex1').value = r.ex1_hps;
    document.getElementById('hps-ex2').value = r.ex2_hps;
    document.getElementById('hps-ex3').value = r.ex3_hps;
  } else {
    document.querySelectorAll('.hps-input').forEach(input => input.value = 100);
  }
  
  document.getElementById('gradebookBody').innerHTML = rows.map((r, index) => `
    <tr>
      <td style="text-align:left;">${r.full_name}</td>
      <td><input type="number" data-idx="${index}" data-field="ww1" value="${r.ww1 ?? ''}"></td>
      <td><input type="number" data-idx="${index}" data-field="ww2" value="${r.ww2 ?? ''}"></td>
      <td><input type="number" data-idx="${index}" data-field="ww3" value="${r.ww3 ?? ''}"></td>
      <td><input type="number" data-idx="${index}" data-field="ww4" value="${r.ww4 ?? ''}"></td>
      <td><input type="number" data-idx="${index}" data-field="ww5" value="${r.ww5 ?? ''}"></td>
      <td><input type="number" data-idx="${index}" data-field="pt1" value="${r.pt1 ?? ''}"></td>
      <td><input type="number" data-idx="${index}" data-field="pt2" value="${r.pt2 ?? ''}"></td>
      <td><input type="number" data-idx="${index}" data-field="pt3" value="${r.pt3 ?? ''}"></td>
      <td><input type="number" data-idx="${index}" data-field="ex1" value="${r.ex1 ?? ''}"></td>
      <td><input type="number" data-idx="${index}" data-field="ex2" value="${r.ex2 ?? ''}"></td>
      <td><input type="number" data-idx="${index}" data-field="ex3" value="${r.ex3 ?? ''}"></td>
      <td class="term-grade-cell">${r.term_grade ?? '—'}</td>
      <td>${r.term_grade >= 75 ? '<span class="badge ok">Passed</span>' : r.term_grade ? '<span class="badge danger">Failed</span>' : '—'}</td>
    </tr>`).join('');
}

async function saveAllGrades() {
  const term = document.getElementById('termSelect').value;
  const inputs = document.querySelectorAll('#gradebookBody input');
  
  const hpsValues = {
    ww1_hps: parseInt(document.getElementById('hps-ww1').value) || 0,
    ww2_hps: parseInt(document.getElementById('hps-ww2').value) || 0,
    ww3_hps: parseInt(document.getElementById('hps-ww3').value) || 0,
    ww4_hps: parseInt(document.getElementById('hps-ww4').value) || 0,
    ww5_hps: parseInt(document.getElementById('hps-ww5').value) || 0,
    pt1_hps: parseInt(document.getElementById('hps-pt1').value) || 0,
    pt2_hps: parseInt(document.getElementById('hps-pt2').value) || 0,
    pt3_hps: parseInt(document.getElementById('hps-pt3').value) || 0,
    ex1_hps: parseInt(document.getElementById('hps-ex1').value) || 0,
    ex2_hps: parseInt(document.getElementById('hps-ex2').value) || 0,
    ex3_hps: parseInt(document.getElementById('hps-ex3').value) || 0,
  };

  const payload = {};
  
  inputs.forEach(input => {
    const idx = input.getAttribute('data-idx');
    const field = input.getAttribute('data-field');
    
    if (!payload[idx]) {
      payload[idx] = {
        student_id: currentGradebookData[idx].student_id,
        subject_id: currentSubjectId,
        term: term,
        ...hpsValues
      };
    }
    payload[idx][field] = input.value ? parseInt(input.value) : 0;
  });

  const promises = Object.values(payload).map(data => 
    apiFetch('/teacher/grades', { method: 'POST', body: JSON.stringify(data) })
  );

  await Promise.all(promises);
  alert('All grades saved successfully!');
  loadGradebook(); 
}

// --- WARNINGS & SF2 ---
async function loadWarnings() {
  const rows = await apiFetch('/teacher/at-risk');
  document.getElementById('warningBody').innerHTML = rows.map(r => `
    <tr>
      <td>${r.full_name}</td>
      <td>${r.avg_grade ?? '—'}</td>
      <td>${r.absences}</td>
    </tr>`).join('') || '<tr><td colspan="3">🎉 No at-risk students!</td></tr>';
}

async function loadSF2() {
  const rows = await apiFetch(`/teacher/sf2/1`);
  document.getElementById('sf2Body').innerHTML = rows.map(r => `
    <tr>
      <td>${r.lrn}</td>
      <td>${r.full_name}</td>
      <td>${r.days_present}</td>
      <td>${r.days_absent}</td>
      <td>${r.days_absent > 4 ? 'Needs Intervention' : 'Good Standing'}</td>
    </tr>`).join('');
}

document.getElementById('attDate').valueAsDate = new Date();
initDashboard();