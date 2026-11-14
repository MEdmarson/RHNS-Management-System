// js/teacher-attendance.js
let currentAttendanceData = [];
let currentAttendanceSubjectId = null;
let currentSectionId = null;
let currentHistorySubjectId = null;
let sf2Initialized = false;

const ATT_BUTTONS = [
  { status: 'present', label: 'Present', icon: '✓' },
  { status: 'late',    label: 'Late',    icon: '⏰' },
  { status: 'excused', label: 'Excused', icon: '📝' },
  { status: 'absent',  label: 'Absent',  icon: '✕' }
];

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

async function loadWarnings() {
  const rows = await apiFetch('/teacher/at-risk');

  // Filter for failing (grade < 75)
  const failing = rows.filter(r => r.avg_grade !== null && r.avg_grade !== undefined && Number(r.avg_grade) < 75);
  
  document.getElementById('failingBody').innerHTML = failing.map(r => {
    // If they have missing requirements, display a warning badge
    const missingBadge = r.missing_requirements 
      ? `<br><span style="font-size:10px; color:var(--danger);">Missing: ${r.missing_requirements}</span>` 
      : '';
      
    return `
    <tr>
      <td>${r.full_name} ${missingBadge}</td>
      <td><span class="badge danger">${r.avg_grade}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="2" class="warning-empty">🎉 No students at risk of failing!</td></tr>';

  // Filter for dropping (absences > 4)
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

async function loadSF2() {
  try {
    const sel = document.getElementById('sf2SubjectSelect');
    const monthInput = document.getElementById('sf2Month');

    if (!sf2Initialized || sel.options.length === 0) {
      const subjects = await apiFetch('/teacher/my-subjects');
      mySubjectsData = subjects;

      if (subjects.length === 0) {
        document.getElementById('sf2Body').innerHTML =
          '<tr><td colspan="7" style="text-align:center;">No subjects assigned to you.</td></tr>';
        return;
      }

      sel.innerHTML = subjects.map(s =>
        `<option value="${s.id}">${s.name} — ${s.section}</option>`
      ).join('');

      if (!monthInput.value) {
        const now = new Date();
        monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      }

      sf2Initialized = true;
    }

    const subjectId = Number(sel.value);
    const subj = mySubjectsData.find(s => s.id === subjectId);
    if (!subj) return;

    const monthVal = monthInput.value;
    if (!monthVal) return;
    const [year, month] = monthVal.split('-');

    document.getElementById('sf2Title').textContent =
      `🏫 School Form 2 (SF2) — ${subj.name} (${subj.section})`;

    const monthName = new Date(year, month - 1, 1)
      .toLocaleString('en-US', { month: 'long', year: 'numeric' });
    document.getElementById('sf2Range').textContent = `(${monthName})`;

    const rows = await apiFetch(
      `/teacher/sf2/${subj.section_id}?month=${month}&year=${year}`
    );

    document.getElementById('sf2Body').innerHTML = rows.map(r => {
      const t = computeAttendance({
        present: r.days_present,
        late: r.days_late,
        excused: r.days_excused,
        absent: r.days_absent
      });
      const note = t.converted
        ? ` <span style="font-size:11px; color: var(--muted);">(${t.converted} from lates)</span>`
        : '';
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
    }).join('') || '<tr><td colspan="7" style="text-align:center;">No attendance recorded for this month.</td></tr>';

  } catch (err) {
    console.error("SF2 Error:", err);
    showToast("Failed to load SF2 report.", "error");
  }
}