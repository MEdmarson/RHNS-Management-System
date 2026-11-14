// js/student-dashboard.js
requireAuth('student');
const user = getUser();
document.getElementById('userChip').textContent = '🎓 ' + user.name;
document.getElementById('welcomeName').textContent = `Welcome back, ${user.name.split(' ')[0]}!`;

// ---- Helpers ----
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function statusPill(status) {
  const map = {
    'Passed':              'passed',
    'Failed':              'failed',
    'INC / Not Submitted': 'inc',
    'In Progress':         'in-progress',
    'Not Started':         'in-progress',
  };
  const cls = map[status] || 'in-progress';
  return `<span class="status-pill ${cls}">${escapeHtml(status)}</span>`;
}

// Term cell: INC only if teacher actually set an HPS for a missing activity
function termCell(termNum, subj) {
  const st = subj.term_status?.[termNum];
  if (st === 'inc') {
    const missing = (subj.term_missing?.[termNum] || []).join(', ');
    return `<span class="term-inc" title="Missing: ${escapeHtml(missing)}">INC</span>`;
  }
  if (st === 'graded') {
    // If STUDENT_SHOW_RAW=true, backend sends the number; otherwise it sends null
    const v = subj[`term${termNum}`];
    return (v === null || v === undefined) ? '—' : v;
  }
  return '—';  // pending — teacher hasn't entered scores yet
}

// ---- Navigation ----
function showView(name, el) {
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(`view-${name}`).style.display = 'block';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el.classList.add('active');

  const titles = {
    'dashboard':  'Dashboard',
    'attendance': 'My Attendance',
    'notifs':     'Notifications',
  };
  document.getElementById('pageTitle').textContent = titles[name];

  if (name === 'attendance') loadAttendance();
  if (name === 'notifs')     loadNotifs();
}

// ---- Dashboard (NO attendance here — that's Attendance-tab only) ----
async function loadDashboard() {
  try {
    const [subjects, progress] = await Promise.all([
      apiFetch('/student/subjects'),
      apiFetch('/student/progress'),
    ]);

    // ---- Top stat cards ----
    document.getElementById('stats').innerHTML = `
      <div class="stat-card" style="border-left-color: var(--warning);">
        <h4>Subjects Enrolled</h4>
        <div class="value">${subjects.filter(s => s.is_active).length}</div>
      </div>
      <div class="stat-card success">
        <h4>Passed</h4>
        <div class="value">${subjects.filter(s => s.status === 'Passed').length}</div>
      </div>
      <div class="stat-card warn">
        <h4>INC / Pending</h4>
        <div class="value">${subjects.filter(s => s.has_inc).length}</div>
      </div>
    `;

    // ---- Progress card ----
    const progressCard = document.getElementById('progressCard');
    if (progressCard) {
      document.getElementById('progressBar').style.width = `${progress.pctComplete}%`;
      document.getElementById('progressText').textContent =
        `${progress.completed} of ${progress.total} subjects completed (${progress.pctComplete}%)`;
      document.getElementById('promotionStatus').textContent = progress.promotionStatus;
      document.getElementById('progressStats').innerHTML = `
        <div class="stat-card success"><h4>Passed</h4><div class="value">${progress.passed}</div></div>
        <div class="stat-card danger"><h4>Failed</h4><div class="value">${progress.failed}</div></div>
        <div class="stat-card warn"><h4>INC / Pending</h4><div class="value">${progress.inc}</div></div>
        <div class="stat-card"><h4>In Progress</h4><div class="value">${progress.inProgress}</div></div>
      `;
    }

    // ---- Active subjects table ----
    const active = subjects.filter(s => s.is_active);
    const past   = subjects.filter(s => !s.is_active);

    document.getElementById('activeSubjectsBody').innerHTML = active.map(s => `
      <tr class="clickable-row" data-id="${s.subject_id}" data-name="${escapeHtml(s.subject)}">
        <td><strong>${escapeHtml(s.subject)}</strong></td>
        <td>${escapeHtml(s.teacher)}</td>
        <td style="text-align:center;">${termCell(1, s)}</td>
        <td style="text-align:center;">${termCell(2, s)}</td>
        <td style="text-align:center;">${termCell(3, s)}</td>
        <td>${statusPill(s.status)}</td>
      </tr>
    `).join('') || '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--muted);">No active subjects.</td></tr>';

    // ---- Past subjects table ----
    document.getElementById('pastSubjectsBody').innerHTML = past.map(s => `
      <tr class="clickable-row" data-id="${s.subject_id}" data-name="${escapeHtml(s.subject)}">
        <td><strong>${escapeHtml(s.subject)}</strong></td>
        <td>${escapeHtml(s.teacher)}</td>
        <td style="text-align:center;">Grade ${s.grade_level ?? '—'}</td>
        <td style="text-align:center; font-weight:bold;">${s.term_grade ?? '—'}</td>
        <td>${statusPill(s.status)}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--muted);">No past subjects found.</td></tr>';

    // ---- Wire row clicks safely (no inline onclick with interpolation) ----
    document.querySelectorAll('.clickable-row[data-id]').forEach(tr => {
      tr.addEventListener('click', () => {
        openSubjectModal(Number(tr.dataset.id), tr.dataset.name);
      });
    });

  } catch (err) {
    console.error(err);
    document.getElementById('activeSubjectsBody').innerHTML =
      `<tr><td colspan="6" style="text-align:center; padding:20px; color:red;">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// ---- Subject modal ----
async function openSubjectModal(subjectId, subjectName) {
  document.getElementById('modalSubjectTitle').textContent = subjectName;
  document.getElementById('modalContent').innerHTML =
    '<p style="text-align:center; color:var(--muted);">Loading details...</p>';
  document.getElementById('subjectDetailModal').style.display = 'flex';

  try {
    const grades = await apiFetch(`/student/subjects/${subjectId}/details`);
    if (!grades.length) {
      document.getElementById('modalContent').innerHTML =
        '<p style="text-align:center; color:var(--muted);">No grades recorded yet.</p>';
      return;
    }

    const hasRaw = grades.some(g => g.activities !== undefined);

    let html = '<div style="overflow-x:auto;">';
    if (hasRaw) {
      html += `<table class="breakdown-table" style="width:100%; border-collapse:collapse;">
        <thead><tr>
          <th>Term</th><th class="bg-ww">WW</th><th class="bg-pt">PT</th>
          <th class="bg-ex">EX</th><th>Initial</th><th>Term Grade</th><th>Status</th>
        </tr></thead><tbody>`;

      grades.forEach(g => {
        const group = (prefix) => {
          const items = g.activities.filter(a => a.field.startsWith(prefix));
          return items.map(a => {
            if (a.missing) return '<span style="color:#92400e; font-weight:700;">MISS</span>';
            return a.score === null ? '—' : a.score;
          }).join(' / ');
        };
        const descColor =
          g.descriptor === 'Advancing'    ? 'green' :
          g.descriptor === 'Benchmarking' ? 'blue'  :
          g.descriptor === 'Connecting'   ? '#0369a1' :
          g.descriptor === 'Developing'   ? '#b45309' :
          g.descriptor === 'Emerging'     ? 'red'   : 'inherit';

        html += `<tr>
          <td style="text-align:center; font-weight:bold;">${g.term}</td>
          <td class="bg-ww" style="text-align:center;">${group('ww')}</td>
          <td class="bg-pt" style="text-align:center;">${group('pt')}</td>
          <td class="bg-ex" style="text-align:center;">${group('ex')}</td>
          <td style="text-align:center;">${g.initial_grade ?? '—'}</td>
          <td style="text-align:center; font-weight:bold; font-size:14px;">
            ${g.term_grade ?? '—'}<br>
            <span style="font-size:11px; color:${descColor}; font-weight:600;">${escapeHtml(g.descriptor || '')}</span>
          </td>
          <td style="text-align:center;">${escapeHtml(g.qualitative || '—')}</td>
        </tr>`;
      });
      html += '</tbody></table>';
    } else {
      // No raw data — qualitative only
      html += `<table class="breakdown-table" style="width:100%; border-collapse:collapse;">
        <thead><tr>
          <th>Term</th><th>Status</th><th>Missing Activities</th>
        </tr></thead><tbody>`;
      grades.forEach(g => {
        html += `<tr>
          <td style="text-align:center; font-weight:bold;">${g.term}</td>
          <td style="text-align:center;">${escapeHtml(g.qualitative || '—')}</td>
          <td style="text-align:center; font-size:12px;">
            ${g.missing_activities?.length ? escapeHtml(g.missing_activities.join(', ')) : '—'}
          </td>
        </tr>`;
      });
      html += '</tbody></table>';
    }
    html += '</div>';

    document.getElementById('modalContent').innerHTML = html;
  } catch (err) {
    document.getElementById('modalContent').innerHTML =
      `<p style="text-align:center; color:red;">Error: ${escapeHtml(err.message)}</p>`;
  }
}

function closeSubjectModal() {
  document.getElementById('subjectDetailModal').style.display = 'none';
}

// ---- Attendance tab (this is the ONLY place absences appear) ----
async function loadAttendance() {
  const a = await apiFetch('/student/attendance');
  const absences = parseInt(a.absent) || 0;
  const limit = 20;
  const percentage = Math.min((absences / limit) * 100, 100);

  let color = 'var(--success)';
  if (percentage > 50) color = 'var(--warning)';
  if (percentage > 75) color = 'var(--danger)';

  document.getElementById('attStats').innerHTML = `
    <div class="stat-card success"><h4>Days Present</h4><div class="value">${a.present || 0}</div></div>
    <div class="stat-card ${absences > 4 ? 'danger' : 'warn'}"><h4>Days Absent</h4><div class="value">${absences}</div></div>
    <div class="stat-card"><h4>Days Late</h4><div class="value">${a.late || 0}</div></div>
  `;

  const bar = document.getElementById('attProgressBar');
  bar.style.width = `${percentage}%`;
  bar.style.background = color;
  bar.textContent = percentage > 15 ? `${Math.round(percentage)}%` : '';
  document.getElementById('attProgressText').textContent = `${absences} / ${limit} Absences`;
}

// ---- Notifications ----
async function loadNotifs() {
  const rows = await apiFetch('/student/notifications');
  document.getElementById('notifsList').innerHTML = rows.map(n => `
    <div class="notif-preview">
      <div class="notif-icon">${n.type === 'warning' ? '⚠️' : n.type === 'error' ? '🚨' : '📢'}</div>
      <div style="flex:1;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong>${escapeHtml(n.title)}</strong>
          <span style="font-size:11px; color:#6b7280;">${new Date(n.created_at).toLocaleString()}</span>
        </div>
        <div style="margin-top:6px; font-size:13px;">${escapeHtml(n.body || '')}</div>
      </div>
    </div>
  `).join('') || '<p style="text-align:center; color:var(--muted); padding:20px;">No notifications yet.</p>';
}

loadDashboard();