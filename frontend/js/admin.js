requireAuth('admin');
document.getElementById('userChip').textContent = '🛡️ ' + getUser().name;

function showView(name, el) {
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(`view-${name}`).style.display = 'block';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
  
  const titles = {
    'dashboard': 'Administrator Dashboard',
    'users': 'Manage Users',
    'subjects': 'Manage Subjects',
    'atrisk': 'At-Risk Students',
    'compliance': 'Teacher Compliance',
    'reports': 'Reports'
  };
  document.getElementById('pageTitle').textContent = titles[name] || 'Admin Portal';

  if (name === 'dashboard')  loadDashboard();
  if (name === 'users')      { loadUsersList(); loadDropdowns(); }
  if (name === 'subjects')   { loadSubjectsList(); loadDropdowns(); }
  if (name === 'atrisk')     loadAtRisk();
  if (name === 'compliance') loadCompliance();
}

// --- MODAL CONTROLS ---
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
window.onclick = function(event) {
  if (event.target.classList.contains('modal')) {
    event.target.style.display = 'none';
  }
}

function toggleStudentFields() {
  const role = document.getElementById('userRole').value;
  document.getElementById('studentFields').style.display = role === 'student' ? 'grid' : 'none';
}

// --- LOAD DATA FOR TABLES ---
async function loadUsersList() {
  const rows = await apiFetch('/admin/all-users');
  document.getElementById('usersListBody').innerHTML = rows.map(u => `
    <tr>
      <td><strong>${u.full_name}</strong></td>
      <td>${u.email}</td>
      <td>${u.role === 'teacher' ? '<span class="badge ok">Teacher</span>' : '<span class="badge warn">Student</span>'}</td>
      <td>${u.role === 'student' ? `${u.section || 'No Section'} / ${u.lrn}` : '—'}</td>
      <td><button class="btn-delete" onclick="deleteUser(${u.id}, '${u.full_name}')">Delete</button></td>
    </tr>
  `).join('');
}

async function loadSubjectsList() {
  const rows = await apiFetch('/admin/subjects');
  document.getElementById('subjectsListBody').innerHTML = rows.map(s => `
    <tr>
      <td><strong>${s.code}</strong></td>
      <td>${s.name}</td>
      <td>${s.teacher_name || 'Unassigned'}</td>
      <td>${s.section_name || 'Unassigned'}</td>
      <td><button class="btn-delete" onclick="deleteSubject(${s.id}, '${s.name}')">Delete</button></td>
    </tr>
  `).join('');
}

async function loadDropdowns() {
  try {
    const teachers = await apiFetch('/admin/teachers');
    const sections = await apiFetch('/admin/sections');

    document.getElementById('subjTeacher').innerHTML = teachers.map(t => `<option value="${t.id}">${t.full_name}</option>`).join('');
    document.getElementById('subjSection').innerHTML = sections.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    document.getElementById('studentSection').innerHTML = sections.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  } catch (err) {
    console.error("Failed to load dropdowns", err);
  }
}

// --- HANDLE FORMS ---
document.getElementById('addUserForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msgDiv = document.getElementById('userMsg');
  msgDiv.textContent = 'Creating...';
  msgDiv.style.color = 'var(--muted)';

  const payload = {
    full_name: document.getElementById('userFullName').value,
    email: document.getElementById('userEmail').value,
    role: document.getElementById('userRole').value,
    password: document.getElementById('userPassword').value,
    lrn: document.getElementById('studentLRN').value,
    section_id: document.getElementById('studentSection').value
  };

  try {
    await apiFetch('/admin/users', { method: 'POST', body: JSON.stringify(payload) });
    msgDiv.textContent = '✅ User created successfully!';
    msgDiv.style.color = 'var(--success)';
    document.getElementById('addUserForm').reset();
    toggleStudentFields();
    loadUsersList(); 
    loadDropdowns();
    setTimeout(() => closeModal('userModal'), 1000);
  } catch (err) {
    msgDiv.textContent = '❌ ' + err.message;
    msgDiv.style.color = 'var(--danger)';
  }
});

document.getElementById('addSubjectForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msgDiv = document.getElementById('subjMsg');
  msgDiv.textContent = 'Creating...';
  msgDiv.style.color = 'var(--muted)';

  const payload = {
    code: document.getElementById('subjCode').value,
    name: document.getElementById('subjName').value,
    teacher_id: document.getElementById('subjTeacher').value,
    section_id: document.getElementById('subjSection').value
  };

  try {
    await apiFetch('/admin/subjects', { method: 'POST', body: JSON.stringify(payload) });
    msgDiv.textContent = '✅ Subject created and assigned!';
    msgDiv.style.color = 'var(--success)';
    document.getElementById('addSubjectForm').reset();
    loadSubjectsList();
    setTimeout(() => closeModal('subjectModal'), 1000);
  } catch (err) {
    msgDiv.textContent = '❌ ' + err.message;
    msgDiv.style.color = 'var(--danger)';
  }
});

// --- DELETE ACTIONS ---
async function deleteUser(id, name) {
  if (!confirm(`Are you sure you want to delete ${name}? This will also delete all their grades and attendance records.`)) return;
  try {
    await apiFetch(`/admin/users/${id}`, { method: 'DELETE' });
    loadUsersList();
  } catch (err) {
    alert('Error deleting user: ' + err.message);
  }
}

async function deleteSubject(id, name) {
  if (!confirm(`Are you sure you want to delete the subject ${name}? This will delete all grades associated with it.`)) return;
  try {
    await apiFetch(`/admin/subjects/${id}`, { method: 'DELETE' });
    loadSubjectsList();
  } catch (err) {
    alert('Error deleting subject: ' + err.message);
  }
}

// --- EXISTING DASHBOARD LOGIC ---
async function loadDashboard() {
  const d = await apiFetch('/admin/dashboard');
  document.getElementById('stats').innerHTML = `
    <div class="stat-card"><h4>Total Students</h4><div class="value">${d.total_students || 0}</div></div>
    <div class="stat-card success"><h4>School Average</h4><div class="value">${d.avg_grade || '—'}</div></div>
    <div class="stat-card danger"><h4>At-Risk</h4><div class="value">${d.at_risk || 0}</div></div>
  `;
}

async function loadAtRisk() {
  const rows = await apiFetch('/admin/at-risk');
  document.getElementById('atRiskBody').innerHTML = rows.map(r => `
    <tr>
      <td>${r.full_name}</td>
      <td>${r.section || '—'}</td>
      <td>${r.avg_grade ?? '—'}</td>
      <td>${r.absences}</td>
    </tr>`).join('') || '<tr><td colspan="4">🎉 No at-risk students.</td></tr>';
}

async function loadCompliance() {
  const rows = await apiFetch('/admin/compliance');
  document.getElementById('complianceBody').innerHTML = rows.map(r => {
    const overdue = r.days_ago == null || r.days_ago > 7;
    return `<tr>
      <td>${r.teacher}</td>
      <td>${r.last_update ? new Date(r.last_update).toLocaleString() : 'Never'}</td>
      <td>${overdue
        ? '<span class="badge danger">Overdue</span>'
        : '<span class="badge ok">Up to date</span>'}</td>
    </tr>`;
  }).join('');
}

async function exportCSV() {
  const rows = await apiFetch('/admin/export');
  const header = ['LRN','Name','Section','Subject','Term','Final'];
  const lines = [header.join(',')];
  rows.forEach(r => lines.push([
    r.lrn, r.full_name, r.section, r.subject, r.term, r.term_grade
  ].join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'school_report.csv';
  a.click();
}

// Init
loadDashboard();