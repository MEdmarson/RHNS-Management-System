requireAuth('admin');
document.getElementById('userChip').textContent = '🛡️ ' + getUser().name;

let allUsersData = []; 
let allSubjectsData = []; 
let currentUserFilter = 'all'; 

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

// --- OPEN MODAL FOR ADD ---
function openUserModal() {
  document.getElementById('userForm').reset();
  document.getElementById('editUserId').value = ''; 
  document.getElementById('userModalTitle').textContent = '➕ Add New User';
  document.getElementById('userPassword').required = true;
  document.getElementById('userMsg').textContent = '';
  document.getElementById('studentFields').style.display = 'none';
  openModal('userModal');
}

function openSubjectModal() {
  document.getElementById('subjectForm').reset();
  document.getElementById('editSubjectId').value = ''; 
  document.getElementById('subjectModalTitle').textContent = '➕ Add New Subject';
  document.getElementById('subjMsg').textContent = '';
  openModal('subjectModal');
}

// --- OPEN MODAL FOR EDIT ---
function editUser(id) {
  const user = allUsersData.find(u => u.id === id);
  if (!user) return;

  document.getElementById('editUserId').value = user.id;
  document.getElementById('userFullName').value = user.full_name;
  document.getElementById('userEmail').value = user.email;
  document.getElementById('userRole').value = user.role;
  document.getElementById('userPassword').value = ''; 
  document.getElementById('userPassword').required = false; 
  
  if (user.role === 'student') {
    document.getElementById('studentLRN').value = user.lrn || '';
    document.getElementById('studentSection').value = user.section_id || '';
    document.getElementById('studentFields').style.display = 'grid';
  } else {
    document.getElementById('studentFields').style.display = 'none';
  }

  document.getElementById('userModalTitle').textContent = '✏️ Edit User';
  document.getElementById('userMsg').textContent = '';
  openModal('userModal');
}

function editSubject(id) {
  const subj = allSubjectsData.find(s => s.id === id);
  if (!subj) return;

  document.getElementById('editSubjectId').value = subj.id;
  document.getElementById('subjCode').value = subj.code;
  document.getElementById('subjName').value = subj.name;
  document.getElementById('subjTeacher').value = subj.teacher_id || '';
  document.getElementById('subjSection').value = subj.section_id || '';
  
  document.getElementById('subjectModalTitle').textContent = '✏️ Edit Subject';
  document.getElementById('subjMsg').textContent = '';
  openModal('subjectModal');
}

// --- FETCH AND RENDER ---
async function loadUsersList() {
  allUsersData = await apiFetch('/admin/all-users');
  renderUsers();
}

function renderUsers() {
  const searchQuery = document.getElementById('userSearch').value.toLowerCase();
  let filtered = allUsersData;

  if (currentUserFilter !== 'all') {
    filtered = filtered.filter(u => u.role === currentUserFilter);
  }
  if (searchQuery) {
    filtered = filtered.filter(u => 
      u.full_name.toLowerCase().includes(searchQuery) || 
      u.email.toLowerCase().includes(searchQuery) ||
      (u.lrn && u.lrn.includes(searchQuery))
    );
  }

  if (filtered.length === 0) {
    document.getElementById('usersListBody').innerHTML = '<tr><td colspan="5" style="text-align:center;">No users found.</td></tr>';
    return;
  }

  document.getElementById('usersListBody').innerHTML = filtered.map(u => `
    <tr>
      <td><strong>${u.full_name}</strong></td>
      <td>${u.email}</td>
      <td>${u.role === 'teacher' ? '<span class="badge ok">Teacher</span>' : '<span class="badge warn">Student</span>'}</td>
      <td>${u.role === 'student' ? `${u.section || 'No Section'} / ${u.lrn}` : '—'}</td>
      <td>
        <button class="btn-edit" onclick="editUser(${u.id})">Edit</button>
        <button class="btn-delete" onclick="deleteUser(${u.id}, '${u.full_name}')">Delete</button>
      </td>
    </tr>
  `).join('');
}

function filterUsers(role, el) {
  currentUserFilter = role;
  document.querySelectorAll('.user-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderUsers();
}

async function loadSubjectsList() {
  allSubjectsData = await apiFetch('/admin/subjects');
  renderSubjects();
}

function renderSubjects() {
  const searchQuery = document.getElementById('subjSearch').value.toLowerCase();
  let filtered = allSubjectsData;

  if (searchQuery) {
    filtered = filtered.filter(s => 
      s.name.toLowerCase().includes(searchQuery) || 
      s.code.toLowerCase().includes(searchQuery) ||
      (s.teacher_name && s.teacher_name.toLowerCase().includes(searchQuery))
    );
  }

  if (filtered.length === 0) {
    document.getElementById('subjectsListBody').innerHTML = '<tr><td colspan="5" style="text-align:center;">No subjects found.</td></tr>';
    return;
  }

  document.getElementById('subjectsListBody').innerHTML = filtered.map(s => `
    <tr>
      <td><strong>${s.code}</strong></td>
      <td>${s.name}</td>
      <td>${s.teacher_name || '<span style="color:red;">Unassigned</span>'}</td>
      <td>${s.section_name || '<span style="color:red;">Unassigned</span>'}</td>
      <td>
        <button class="btn-edit" onclick="editSubject(${s.id})">Edit</button>
        <button class="btn-delete" onclick="deleteSubject(${s.id}, '${s.name}')">Delete</button>
      </td>
    </tr>
  `).join('');
}

// --- DROPDOWNS ---
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

// --- SUBMIT FORMS (HANDLES BOTH ADD AND EDIT) ---
document.getElementById('userForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msgDiv = document.getElementById('userMsg');
  const editId = document.getElementById('editUserId').value;
  msgDiv.textContent = 'Saving...';
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
    if (editId) {
      await apiFetch(`/admin/users/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
      msgDiv.textContent = '✅ User updated successfully!';
    } else {
      await apiFetch('/admin/users', { method: 'POST', body: JSON.stringify(payload) });
      msgDiv.textContent = '✅ User created successfully!';
    }
    msgDiv.style.color = 'var(--success)';
    loadUsersList(); 
    loadDropdowns();
    setTimeout(() => closeModal('userModal'), 1000);
  } catch (err) {
    msgDiv.textContent = '❌ ' + err.message;
    msgDiv.style.color = 'var(--danger)';
  }
});

document.getElementById('subjectForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msgDiv = document.getElementById('subjMsg');
  const editId = document.getElementById('editSubjectId').value;
  msgDiv.textContent = 'Saving...';
  msgDiv.style.color = 'var(--muted)';

  const payload = {
    code: document.getElementById('subjCode').value,
    name: document.getElementById('subjName').value,
    teacher_id: document.getElementById('subjTeacher').value,
    section_id: document.getElementById('subjSection').value
  };

  try {
    if (editId) {
      await apiFetch(`/admin/subjects/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
      msgDiv.textContent = '✅ Subject updated successfully!';
    } else {
      await apiFetch('/admin/subjects', { method: 'POST', body: JSON.stringify(payload) });
      msgDiv.textContent = '✅ Subject created successfully!';
    }
    msgDiv.style.color = 'var(--success)';
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