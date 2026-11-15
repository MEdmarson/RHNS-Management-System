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
      `<button type="button" class="att-btn att-${b.status} ${r.status === b.status ? 'active' : ''}" aria-pressed="${r.status === b.status}" onclick="mark(${r.student_id},'${b.status}')"><span class="att-icon">${b.icon}</span> ${b.label}</button>`
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
  // Clicking the already-active button clears the status
  const current = currentAttendanceData.find(r => r.student_id === student_id);
  const clearing = current && current.status === status;
  try {
    await apiFetch('/teacher/attendance', {
      method: 'POST',
      body: JSON.stringify({ student_id, section_id: currentSectionId, date, status: clearing ? null : status })
    });
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

// ---------- At-Risk (early warning) ----------
let riskData = { settings: {}, subjects: [], students: [] };
let riskTab = 'all';          // all | failing | dropping | both
const RISK_PAGE = 20;         // rows rendered at a time, so a long list stays fast
let riskLimit = RISK_PAGE;
const riskOpen = new Set();   // student ids whose details are expanded

const riskEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function loadWarnings() {
  const list = document.getElementById('riskList');
  list.innerHTML = '<div class="risk-empty">Loading…</div>';
  try {
    // the subject type (sets the WW/PT/EX weights) is remembered in this browser, so send it with the request
    const types = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith('subjectType-')) types[k.slice('subjectType-'.length)] = localStorage.getItem(k);
      }
    } catch (e) {}
    riskData = await apiFetch('/teacher/at-risk?types=' + encodeURIComponent(JSON.stringify(types)));
  } catch (err) {
    list.innerHTML = `<div class="risk-empty">❌ Could not load at-risk students. ${riskEsc(err.message || '')}</div>`;
    return;
  }

  const s = riskData.settings || {};
  document.getElementById('riskRules').innerHTML =
    `<strong>Failing:</strong> current term grade below ${s.PASSING_GRADE ?? 75}, or missed work worth ${s.MISSING_WEIGHT_PCT ?? 20}+ points of the term grade ` +
    `(or ${s.MISSING_COUNT ?? 3}+ missed activities) — one or two missed activities alone won't tag a student. ` +
    `<strong>Dropping:</strong> more than ${s.ABSENCE_LIMIT ?? 4} absences in the last ${s.WINDOW_DAYS ?? 30} days (every ${s.LATES_PER_ABSENCE ?? 3} lates = 1 absence).`;

  const sel = document.getElementById('riskSubject');
  const keep = sel.value;
  sel.innerHTML = '<option value="">All subjects</option>' +
    (riskData.subjects || []).map(x => `<option value="${x.id}">${riskEsc(x.name)} — ${riskEsc(x.section)}</option>`).join('');
  sel.value = (riskData.subjects || []).some(x => String(x.id) === keep) ? keep : '';

  riskLimit = RISK_PAGE;
  renderRisk();
}

function setRiskTab(tab) {
  riskTab = tab;
  riskLimit = RISK_PAGE;
  renderRisk();
}

function onRiskFilterChange() {
  riskLimit = RISK_PAGE;
  renderRisk();
}

function showMoreRisk() {
  riskLimit += RISK_PAGE;
  renderRisk();
}

function toggleRisk(id) {
  const el = document.getElementById('risk-' + id);
  if (!el) return;
  const open = el.classList.toggle('open');
  el.querySelector('.risk-head').setAttribute('aria-expanded', open);
  open ? riskOpen.add(id) : riskOpen.delete(id);
}

function toggleAllRisk(open) {
  document.querySelectorAll('#riskList .risk-row').forEach(el => {
    const id = Number(el.dataset.id);
    el.classList.toggle('open', open);
    el.querySelector('.risk-head').setAttribute('aria-expanded', open);
    open ? riskOpen.add(id) : riskOpen.delete(id);
  });
}

// one-line reason for a failing subject
function failReasonText(f) {
  const g = f.term_grade;
  const m = f.missing;
  if (f.cause === 'both') {
    return `Grade ${g} and missing ${m.count} of ${m.total} activities (up to ${m.weight_pct} pts of the term grade)`;
  }
  if (f.cause === 'missing') {
    return `Missing ${m.count} of ${m.total} activities — worth up to ${m.weight_pct} pts of the term grade` + (g !== null ? ` (current grade ${g})` : ' (no grade computed yet)');
  }
  let t = `Grade ${g} — below passing`;
  if (f.weakest) t += `, weakest in ${f.weakest.name} (${f.weakest.pct}%)`;
  t += m.count ? `; ${m.count} missed so far` : '; all activities handed in';
  return t;
}

function dropReasonText(d) {
  let t = `${d.effective_absences} absences in the last ${d.window_days} days`;
  if (d.converted) t += ` (${d.absent} absent + ${d.converted} from ${d.late} lates)`;
  if (d.streak >= 2) t += `; absent ${d.streak} days in a row`;
  return t;
}

function failDetailHtml(f) {
  const m = f.missing;
  const bars = ['ww', 'pt', 'ex'].filter(c => f.components[c] !== null).map(c => {
    const names = { ww: 'Written Work', pt: 'Performance Tasks', ex: 'Exams' };
    const pct = f.components[c];
    return `<div class="risk-comp"><span>${names[c]}</span><div class="risk-bar"><i class="${pct < (riskData.settings.PASSING_GRADE ?? 75) ? 'low' : ''}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></div><b>${pct}%</b></div>`;
  }).join('');
  const trend = f.previous.length
    ? `<div class="risk-note">Earlier terms: ${f.previous.map(p => `Term ${p.term}: <strong>${p.grade}</strong>`).join(' → ')} → Term ${f.term}: <strong>${f.term_grade ?? '—'}</strong></div>`
    : '';
  const chips = m.count
    ? `<div class="risk-chips">${m.items.map(i => `<span class="risk-chip" title="${riskEsc(i.label)}">${riskEsc(i.key)} · ${riskEsc(i.label)} (${i.hps} pts)</span>`).join('')}</div>`
    : '';
  return `
    <div class="risk-section">
      <h4>📚 ${riskEsc(f.subject)} <span class="badge ${f.low_grade ? 'danger' : 'warn'}" style="font-size:10px;">Term ${f.term} · ${f.term_grade ?? 'no grade'}</span></h4>
      <p class="why">${riskEsc(failReasonText(f))}</p>
      ${bars}
      ${m.count ? `<div style="font-size:12px; margin-top:8px;"><strong>Missing (${m.count} of ${m.total}):</strong></div>${chips}` : ''}
      ${trend}
    </div>`;
}

function dropDetailHtml(d) {
  const stat = (v, l) => `<div class="risk-stat"><b>${v}</b><span>${l}</span></div>`;
  return `
    <div class="risk-section">
      <h4>🚪 Attendance — last ${d.window_days} days</h4>
      <p class="why">${riskEsc(dropReasonText(d))}</p>
      <div class="risk-stats">
        ${stat(d.effective_absences, 'Effective absences')}
        ${stat(d.absent, 'Absent')}
        ${stat(d.late, 'Late')}
        ${stat(d.excused, 'Excused')}
        ${stat(d.absence_rate + '%', 'Of recorded days')}
        ${stat(d.streak, 'Current streak')}
      </div>
      ${d.recent_absences.length ? `<div class="risk-note">Recent absences: ${d.recent_absences.join(', ')}</div>` : ''}
    </div>`;
}

function renderRisk() {
  const q = document.getElementById('riskSearch').value.trim().toLowerCase();
  const subjId = document.getElementById('riskSubject').value;
  const sort = document.getElementById('riskSort').value;
  const subj = subjId ? riskData.subjects.find(x => String(x.id) === subjId) : null;

  // 1) search + subject filter (the tab counts reflect these)
  let rows = (riskData.students || []).map(s => {
    let failing = s.failing;
    let dropping = s.dropping;
    if (subj) {
      failing = failing.filter(f => String(f.subject_id) === subjId);
      if (s.section_id !== subj.section_id) dropping = null;   // attendance is per section
    }
    return { ...s, failing, dropping };
  }).filter(s => (s.failing.length || s.dropping) &&
                 (!q || s.full_name.toLowerCase().includes(q)));

  const isBoth = s => s.failing.length > 0 && !!s.dropping;
  const counts = {
    all: rows.length,
    failing: rows.filter(s => s.failing.length).length,
    dropping: rows.filter(s => s.dropping).length,
    both: rows.filter(isBoth).length
  };
  document.getElementById('riskCntAll').textContent = counts.all;
  document.getElementById('riskCntFailing').textContent = counts.failing;
  document.getElementById('riskCntDropping').textContent = counts.dropping;
  document.getElementById('riskCntBoth').textContent = counts.both;
  ['All', 'Failing', 'Dropping', 'Both'].forEach(n =>
    document.getElementById('riskTab' + n).classList.toggle('active', riskTab === n.toLowerCase()));

  // 2) tab filter
  if (riskTab === 'failing') rows = rows.filter(s => s.failing.length);
  else if (riskTab === 'dropping') rows = rows.filter(s => s.dropping);
  else if (riskTab === 'both') rows = rows.filter(isBoth);

  // 3) sort
  const sevRank = s => (s.severity === 'high' ? 0 : 1);
  const lowest = s => (s.failing.length ? Math.min(...s.failing.map(f => f.term_grade ?? 0)) : 999);
  const absences = s => (s.dropping ? s.dropping.effective_absences : -1);
  rows.sort((a, b) => {
    if (sort === 'name') return a.full_name.localeCompare(b.full_name);
    if (sort === 'grade') return lowest(a) - lowest(b) || a.full_name.localeCompare(b.full_name);
    if (sort === 'absences') return absences(b) - absences(a) || a.full_name.localeCompare(b.full_name);
    return sevRank(a) - sevRank(b) || lowest(a) - lowest(b) || absences(b) - absences(a) || a.full_name.localeCompare(b.full_name);
  });

  // 4) render (only the first riskLimit rows)
  const list = document.getElementById('riskList');
  const meta = document.getElementById('riskMeta');
  const more = document.getElementById('riskMore');

  if (!rows.length) {
    const none = { all: '🎉 No students are at risk right now.', failing: '🎉 No students at risk of failing.', dropping: '🎉 No students at risk of dropping.', both: 'No student is at risk in both areas.' };
    list.innerHTML = `<div class="risk-empty">${(q || subjId) ? 'No students match your search or filter.' : none[riskTab]}</div>`;
    meta.textContent = '';
    more.style.display = 'none';
    return;
  }

  const shown = rows.slice(0, riskLimit);
  list.innerHTML = shown.map(s => {
    const open = riskOpen.has(s.student_id);
    const reasons = [
      ...s.failing.map(f => `<div class="risk-reason"><span class="rk fail">📉 ${riskEsc(f.subject)}:</span>${riskEsc(failReasonText(f))}</div>`),
      ...(s.dropping ? [`<div class="risk-reason"><span class="rk drop">🚪 Attendance:</span>${riskEsc(dropReasonText(s.dropping))}</div>`] : [])
    ].join('');
    return `
    <div class="risk-row sev-${s.severity} ${open ? 'open' : ''}" id="risk-${s.student_id}" data-id="${s.student_id}">
      <button class="risk-head" onclick="toggleRisk(${s.student_id})" aria-expanded="${open}">
        <span class="risk-who"><strong>${riskEsc(s.full_name)}</strong><small>${riskEsc(s.section || '')}${isBoth(s) ? ' · at risk in both areas' : ''}</small></span>
        <span class="risk-reasons">${reasons}</span>
        <span class="risk-caret">▸</span>
      </button>
      <div class="risk-body">
        ${s.failing.map(failDetailHtml).join('')}
        ${s.dropping ? dropDetailHtml(s.dropping) : ''}
      </div>
    </div>`;
  }).join('');

  meta.textContent = `Showing ${shown.length} of ${rows.length} student${rows.length === 1 ? '' : 's'}`;
  if (rows.length > shown.length) {
    more.style.display = '';
    more.textContent = `Show ${Math.min(RISK_PAGE, rows.length - shown.length)} more (${rows.length - shown.length} remaining)`;
  } else {
    more.style.display = 'none';
  }
}

// ---------- SF2 report ----------
let sf2Filter = 'active'; // 'active' (current classes) | 'finished' (past classes)

function setSf2Filter(filter) {
  sf2Filter = filter;
  sf2Initialized = false;
  document.getElementById('sf2TabActive').classList.toggle('active', filter === 'active');
  document.getElementById('sf2TabFinished').classList.toggle('active', filter === 'finished');
  loadSF2();
}

async function loadSF2() {
  try {
    const sel = document.getElementById('sf2SubjectSelect');
    const monthInput = document.getElementById('sf2Month');

    if (!sf2Initialized) {
      const previous = sel.value;
      const subjects = await apiFetch(`/teacher/my-subjects?status=${sf2Filter}`);
      mySubjectsData = subjects;

      if (subjects.length === 0) {
        sel.innerHTML = '';
        document.getElementById('sf2Title').textContent = '🏫 School Form 2 (SF2)';
        document.getElementById('sf2Range').textContent = '';
        document.getElementById('sf2Body').innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 20px; color: var(--muted);">${
          sf2Filter === 'finished' ? 'No past classes yet. Mark a class as finished to see its SF2 here.' : 'No subjects assigned to you.'}</td></tr>`;
        return;
      }

      sel.innerHTML = subjects.map(s =>
        `<option value="${s.id}">${s.name} — ${s.section}</option>`
      ).join('');
      if (previous && subjects.some(s => String(s.id) === previous)) sel.value = previous;

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

// Download the official SF2 layout (.xlsx) for the selected class and month
async function downloadSF2() {
  const sel = document.getElementById('sf2SubjectSelect');
  const subj = mySubjectsData.find(s => s.id === Number(sel.value));
  const monthVal = document.getElementById('sf2Month').value;
  if (!subj || !monthVal) { showToast('Choose a class and a month first.', 'error'); return; }
  const [year, month] = monthVal.split('-');

  const btn = document.getElementById('sf2ExportBtn');
  const originalText = btn.innerHTML;
  btn.innerHTML = '⏳ Generating...';
  btn.disabled = true;

  try {
    const params = new URLSearchParams({ month, year });
    const token = localStorage.getItem('token') || localStorage.getItem('authToken');
    const response = await fetch(`/api/teacher/sf2/${subj.section_id}/export?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      let msg = `Server returned ${response.status}`;
      try { const j = await response.json(); if (j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const cd = response.headers.get('Content-Disposition');
    let filename = `SF2_${year}-${month}.xlsx`;
    if (cd && cd.includes('filename="')) filename = cd.split('filename="')[1].split('"')[0];

    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    window.URL.revokeObjectURL(url);
    showToast('SF2 downloaded successfully!');
  } catch (err) {
    console.error('SF2 download error:', err);
    showToast(err.message || 'Failed to download SF2.', 'error');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}