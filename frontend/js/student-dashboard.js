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

function showToast(message, type = 'info', onClick = null) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.style.cursor = onClick ? 'pointer' : 'default';
  
  const icon = type === 'warning' ? '⚠️' : type === 'error' ? '🚨' : '🔔';
  
  toast.innerHTML = `
    <div style="font-size: 20px;">${icon}</div>
    <div style="flex: 1;">
      <strong>${escapeHtml(message.title)}</strong>
      <div style="font-size: 12px; color: #4b5563; margin-top: 4px;">${escapeHtml(message.body)}</div>
    </div>
  `;

  if (onClick) {
    toast.addEventListener('click', () => {
      onClick();
      toast.remove();
    });
  }

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 6000);
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

function termCell(termNum, subj) {
  const st = subj.term_status?.[termNum];
  
  if (st === 'inc') {
    return `<span class="term-inc" title="Missing requirements">INC</span>`;
  }
  
  if (st === 'Passed') return `<span style="color: #166534; font-weight: 700; font-size: 12px;">Passed</span>`;
  if (st === 'Failed') return `<span style="color: #991b1b; font-weight: 700; font-size: 12px;">Failed</span>`;
  if (st === 'in-progress') return `<span style="color: #1e3a8a; font-weight: 700; font-size: 12px;">In Progress</span>`;
  
  return '—';
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
  
  if (name === 'notifs') {
    document.getElementById('notifBadge').style.display = 'none';
    loadNotifs(false);
  }
}

// ---- Dashboard ----
async function loadDashboard() {
  try {
    const [subjects, progress] = await Promise.all([
      apiFetch('/student/subjects'),
      apiFetch('/student/progress'),
    ]);

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

    document.getElementById('pastSubjectsBody').innerHTML = past.map(s => `
      <tr class="clickable-row" data-id="${s.subject_id}" data-name="${escapeHtml(s.subject)}">
        <td><strong>${escapeHtml(s.subject)}</strong></td>
        <td>${escapeHtml(s.teacher)}</td>
        <td style="text-align:center;">Grade ${s.grade_level ?? '—'}</td>
        <td style="text-align:center; font-weight:bold;">${s.term_grade ?? '—'}</td>
        <td>${statusPill(s.status)}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--muted);">No past subjects found.</td></tr>';

    document.querySelectorAll('.clickable-row[data-id]').forEach(tr => {
      tr.addEventListener('click', () => {
        openSubjectModal(Number(tr.dataset.id), tr.dataset.name);
      });
    });

    loadNotifs(true);

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

    // We use max-width: 800px so the longer headers fit nicely
    let html = '<div style="overflow-x: auto;"><table class="breakdown-table" style="width:100%; border-collapse:collapse;">';
    
    // UPDATED HEADERS
    html += `<thead><tr>
        <th style="text-align:center; width: 60px;">Term</th>
        <th class="bg-ww" style="text-align:center;">WRITTEN / ORAL WORKS</th>
        <th class="bg-pt" style="text-align:center;">PRODUCT / PERFORMANCE TASKS</th>
        <th class="bg-ex" style="text-align:center;">EXAMINATIONS</th>
        <th style="text-align:center; width: 90px;">Term Grade</th>
        <th style="text-align:center; width: 100px;">Status</th>
      </tr></thead><tbody>`;

    grades.forEach(g => {
      // NEW FORMATTING: Show scores vertically for better readability
      const formatGroup = (prefix) => {
        if (!g.activities) return '—';
        const items = g.activities.filter(a => a.field.startsWith(prefix));
        
        return items.map(a => {
          if (a.score !== null && a.score !== undefined) {
             return `<div style="margin-bottom: 2px;"><strong style="color:var(--primary);">${a.score}</strong> <span style="color:var(--muted); font-size:11px;">/ ${a.hps || 0}</span></div>`;
          } else if (a.hps > 0) {
             return `<div style="margin-bottom: 2px; color:#b45309; font-size:11px;">— / ${a.hps}</div>`;
          }
          return null; 
        }).filter(Boolean).join('') || '—';
      };

      // Determine if the term is fully completed (Passed or Failed)
      const isFinished = g.qualitative === 'Passed' || g.qualitative === 'Failed';
      
      const descColor =
        g.descriptor === 'Advancing'    ? 'green' :
        g.descriptor === 'Benchmarking' ? '#1e3a8a'  :
        g.descriptor === 'Connecting'   ? '#0369a1' :
        g.descriptor === 'Developing'   ? '#b45309' :
        g.descriptor === 'Emerging'     ? 'red'   : 'inherit';

      let statusText = '—';
      if (g.qualitative === 'Passed') statusText = '<span style="color:#166534; font-weight:700;">Passed</span>';
      if (g.qualitative === 'Failed') statusText = '<span style="color:#991b1b; font-weight:700;">Failed</span>';
      if (g.qualitative === 'INC / Not Submitted') statusText = '<span style="color:#92400e; font-weight:700;">INC</span>';
      if (g.qualitative === 'In Progress') statusText = '<span style="color:#1e3a8a; font-weight:700;">In Progress</span>';

      html += `<tr>
        <td style="text-align:center; font-weight:bold; font-size:14px; background:#f9fafb;">${g.term}</td>
        <td class="bg-ww" style="text-align:center; font-size:13px; vertical-align:top;">${formatGroup('ww')}</td>
        <td class="bg-pt" style="text-align:center; font-size:13px; vertical-align:top;">${formatGroup('pt')}</td>
        <td class="bg-ex" style="text-align:center; font-size:13px; vertical-align:top;">${formatGroup('ex')}</td>
        <td style="text-align:center; font-weight:bold; font-size:16px; vertical-align:top; background:#f9fafb;">
          ${isFinished ? (g.term_grade ?? '—') : '—'}<br>
          <span style="font-size:11px; color:${descColor}; font-weight:600;">
            ${isFinished ? escapeHtml(g.descriptor || '') : ''}
          </span>
        </td>
        <td style="text-align:center; vertical-align:top; background:#f9fafb;">${statusText}</td>
      </tr>`;
    });
    
    html += '</tbody></table></div>';
    
    // Add a slight note for students to understand the format
    html += `<p style="font-size:11px; color:var(--muted); margin-top:12px; text-align:center;">Scores are displayed as <strong>Your Score</strong> / Max Possible Score (HPS)</p>`;
    
    document.getElementById('modalContent').innerHTML = html;
  } catch (err) {
    document.getElementById('modalContent').innerHTML =
      `<p style="text-align:center; color:red;">Error: ${escapeHtml(err.message)}</p>`;
  }
}

function closeSubjectModal() {
  document.getElementById('subjectDetailModal').style.display = 'none';
}

// ---- Attendance ----
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
async function loadNotifs(showPopup = false) {
  try {
    const rows = await apiFetch('/student/notifications');
    
    const unreadCount = rows.filter(n => !n.is_read || n.type === 'warning').length;
    const badge = document.getElementById('notifBadge');
    
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 9 ? '9+' : unreadCount; 
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }

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

    if (showPopup && rows.length > 0) {
      const latest = rows.find(n => !n.is_read || n.type === 'warning');
      if (latest) {
        showToast(
          { title: latest.title, body: latest.body || 'Click to view all notifications.' },
          latest.type === 'warning' ? 'warning' : 'info',
          () => {
            const notifBtn = document.getElementById('navNotifs');
            if (notifBtn) showView('notifs', notifBtn);
          }
        );
      }
    }
  } catch (err) {
    console.error('Failed to load notifications:', err);
  }
}

// Fetch notifications immediately to show the badge on login
loadNotifs(false); 
loadDashboard();