requireAuth('student');
document.getElementById('userChip').textContent = '🎓 ' + getUser().name;

function showView(name, el) {
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(`view-${name}`).style.display = 'block';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
  if (name === 'attendance') loadAttendance();
  if (name === 'notifs')     loadNotifs();
}

async function loadDashboard() {
  const subjects = await apiFetch('/student/subjects');
  
  document.getElementById('subjectsBody').innerHTML = subjects.map(s => {
    // Implement the recommendation: Hide numbers, show INC or Pass/Fail
    let statusBadge = '<span class="badge warn">INC / Not Submitted</span>';
    
    if (s.term_grade !== null && s.term_grade > 0) {
      if (s.term_grade >= 75) {
        statusBadge = '<span class="badge ok">Passed</span>';
      } else {
        statusBadge = '<span class="badge danger">Failed</span>';
      }
    }

    return `<tr>
      <td>${s.subject}</td>
      <td>${s.teacher}</td>
      <td><strong>${statusBadge}</strong></td>
    </tr>`;
  }).join('');
}

async function loadAttendance() {
  const a = await apiFetch('/student/attendance');
  document.getElementById('attStats').innerHTML = `
    <div class="stat-card success"><h4>Days Present</h4><div class="value">${a.present}</div></div>
    <div class="stat-card ${a.absent > 4 ? 'danger' : 'warn'}"><h4>Days Absent</h4><div class="value">${a.absent}</div></div>
    <div class="stat-card"><h4>Days Late</h4><div class="value">${a.late}</div></div>
    <div class="stat-card"><h4>Allowed Limit</h4><div class="value">20</div></div>
  `;
}

async function loadNotifs() {
  const rows = await apiFetch('/student/notifications');
  document.getElementById('notifsList').innerHTML = rows.map(n => `
    <div class="notif ${n.type}">
      <div>
        <strong>${n.title}</strong>
        <div style="font-size:12px;color:#6b7280;margin-top:4px">
          ${new Date(n.created_at).toLocaleString()}
          ${n.is_read ? '' : ' · <b>unread</b>'}
        </div>
        <div style="margin-top:6px;font-size:13px">${n.body || ''}</div>
      </div>
    </div>`).join('') || '<p>No notifications.</p>';
}

loadDashboard();