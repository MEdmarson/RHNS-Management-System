requireAuth('admin');
document.getElementById('userChip').textContent = '🛡️ ' + getUser().name;

const escHtml = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const agoText = (d) => (d === null || d === undefined ? 'Never' : d === 0 ? 'Today' : d === 1 ? '1 day ago' : d + ' days ago');

let allUsersData = []; 
let allSubjectsData = []; 
let currentUserFilter = 'all'; 

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '❌' : '⚠️'}</span> ${escHtml(message)}`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); }, 3000);
}

function showView(name, el) {
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(`view-${name}`).style.display = 'block';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
  
  const titles = {
    'dashboard': 'Administrator Dashboard: School-Wide Oversight', 'users': 'Manage Users', 'subjects': 'Manage Subjects',
    'atrisk': 'At-Risk Students', 'compliance': 'Teacher Compliance', 'reports': 'Reports'
  };
  document.getElementById('pageTitle').textContent = titles[name] || 'Admin Portal';

  if (name === 'dashboard')  loadDashboard();
  if (name === 'users')      { loadUsersList(); loadDropdowns(); }
  if (name === 'subjects')   { loadSubjectsList(); loadDropdowns(); }
  if (name === 'atrisk')     loadAtRisk();
  if (name === 'compliance') loadCompliance();
}

function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
window.onclick = function(event) { if (event.target.classList.contains('modal')) event.target.style.display = 'none'; }

function toggleStudentFields() {
  const role = document.getElementById('userRole').value;
  document.getElementById('studentFields').style.display = role === 'student' ? 'grid' : 'none';
}

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

async function loadUsersList() {
  allUsersData = await apiFetch('/admin/all-users');
  renderUsers();
}

function renderUsers() {
  const searchQuery = document.getElementById('userSearch').value.toLowerCase();
  let filtered = allUsersData;
  if (currentUserFilter !== 'all') filtered = filtered.filter(u => u.role === currentUserFilter);
  if (searchQuery) {
    filtered = filtered.filter(u => 
      u.full_name.toLowerCase().includes(searchQuery) || (u.email || '').toLowerCase().includes(searchQuery) || (u.lrn && u.lrn.includes(searchQuery))
    );
  }

  if (filtered.length === 0) {
    document.getElementById('usersListBody').innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px;">No users found.</td></tr>';
    return;
  }

  document.getElementById('usersListBody').innerHTML = filtered.map(u => `
    <tr>
      <td><strong>${escHtml(u.full_name)}</strong></td>
      <td>${escHtml(u.email)}</td>
      <td>${u.role === 'teacher' ? '<span class="badge ok">Teacher</span>' : '<span class="badge warn">Student</span>'}</td>
      <td>${u.role === 'student' ? `${escHtml(u.section || 'No Section')} / ${escHtml(u.lrn)}` : '—'}</td>
      <td>
        <button class="btn-edit" onclick="editUser(${u.id})">Edit</button>
        <button class="btn-delete" onclick="deleteUser(${u.id})">Delete</button>
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
      s.name.toLowerCase().includes(searchQuery) || (s.code || '').toLowerCase().includes(searchQuery) || (s.teacher_name && s.teacher_name.toLowerCase().includes(searchQuery))
    );
  }

  if (filtered.length === 0) {
    document.getElementById('subjectsListBody').innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px;">No subjects found.</td></tr>';
    return;
  }

  document.getElementById('subjectsListBody').innerHTML = filtered.map(s => `
    <tr>
      <td><strong>${escHtml(s.code)}</strong></td>
      <td>${escHtml(s.name)}</td>
      <td>${s.teacher_name ? escHtml(s.teacher_name) : '<span style="color:red;">Unassigned</span>'}</td>
      <td>${s.section_name ? escHtml(s.section_name) : '<span style="color:red;">Unassigned</span>'}</td>
      <td>
        <button class="btn-edit" onclick="editSubject(${s.id})">Edit</button>
        <button class="btn-delete" onclick="deleteSubject(${s.id})">Delete</button>
      </td>
    </tr>
  `).join('');
}

async function loadDropdowns() {
  try {
    const teachers = await apiFetch('/admin/teachers');
    const sections = await apiFetch('/admin/sections');
    document.getElementById('subjTeacher').innerHTML = teachers.map(t => `<option value="${t.id}">${escHtml(t.full_name)}</option>`).join('');
    document.getElementById('subjSection').innerHTML = sections.map(s => `<option value="${s.id}">${escHtml(s.name)}</option>`).join('');
    document.getElementById('studentSection').innerHTML = sections.map(s => `<option value="${s.id}">${escHtml(s.name)}</option>`).join('');
  } catch (err) { console.error("Failed to load dropdowns", err); }
}

document.getElementById('userForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msgDiv = document.getElementById('userMsg');
  const editId = document.getElementById('editUserId').value;
  msgDiv.textContent = 'Saving...'; msgDiv.style.color = 'var(--muted)';

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
      showToast('User updated successfully!');
    } else {
      await apiFetch('/admin/users', { method: 'POST', body: JSON.stringify(payload) });
      showToast('User created successfully!');
    }
    loadUsersList(); loadDropdowns();
    setTimeout(() => closeModal('userModal'), 1000);
  } catch (err) {
    msgDiv.textContent = '❌ ' + err.message; msgDiv.style.color = 'var(--danger)';
  }
});

document.getElementById('subjectForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msgDiv = document.getElementById('subjMsg');
  const editId = document.getElementById('editSubjectId').value;
  msgDiv.textContent = 'Saving...'; msgDiv.style.color = 'var(--muted)';

  const payload = {
    code: document.getElementById('subjCode').value,
    name: document.getElementById('subjName').value,
    teacher_id: document.getElementById('subjTeacher').value,
    section_id: document.getElementById('subjSection').value
  };

  try {
    if (editId) {
      await apiFetch(`/admin/subjects/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Subject updated successfully!');
    } else {
      await apiFetch('/admin/subjects', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Subject created successfully!');
    }
    loadSubjectsList();
    setTimeout(() => closeModal('subjectModal'), 1000);
  } catch (err) {
    msgDiv.textContent = '❌ ' + err.message; msgDiv.style.color = 'var(--danger)';
  }
});

async function deleteUser(id) {
  const user = allUsersData.find(u => u.id === id);
  const name = user ? user.full_name : 'this user';
  if (!confirm(`Are you sure you want to delete ${name}? This will also delete all their grades and attendance records.`)) return;
  try {
    await apiFetch(`/admin/users/${id}`, { method: 'DELETE' });
    showToast('User deleted.');
    loadUsersList();
  } catch (err) { showToast('Error deleting user.', 'error'); }
}

async function deleteSubject(id) {
  const subj = allSubjectsData.find(s => s.id === id);
  const name = subj ? subj.name : 'this subject';
  if (!confirm(`Are you sure you want to delete the subject ${name}? This will delete all grades associated with it.`)) return;
  try {
    await apiFetch(`/admin/subjects/${id}`, { method: 'DELETE' });
    showToast('Subject deleted.');
    loadSubjectsList();
  } catch (err) { showToast('Error deleting subject.', 'error'); }
}

async function loadDashboard() {
  // The dashboard is drawn by js/adminDashboard.js (loaded after this file; it loads itself the first time)
  if (typeof window.loadOverview === 'function') await window.loadOverview();
}

// ---------- AT-RISK (all grade levels) ----------
let atRiskData = [];

async function loadAtRisk() {
  atRiskData = await apiFetch('/admin/at-risk');
  const levels = [...new Set(atRiskData.map(r => r.grade_level))].sort((a, b) => a - b);
  const sel = document.getElementById('atRiskLevel');
  const keep = sel.value;
  sel.innerHTML = '<option value="all">All grade levels</option>' + levels.map(l => `<option value="${l}">Grade ${l}</option>`).join('');
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  renderAtRisk();
}

function renderAtRisk() {
  const q = document.getElementById('atRiskSearch').value.toLowerCase();
  const lvl = document.getElementById('atRiskLevel').value;
  const sev = document.getElementById('atRiskSeverity').value;
  const rows = atRiskData.filter(r =>
    (lvl === 'all' || String(r.grade_level) === lvl) &&
    (sev === 'all' || r.severity === sev) &&
    (!q || r.full_name.toLowerCase().includes(q) || (r.lrn || '').includes(q)));

  document.getElementById('atRiskCount').textContent = `Showing ${rows.length} of ${atRiskData.length}`;
  document.getElementById('atRiskBody').innerHTML = rows.map(r => {
    const avgDisplay = r.avg_grade !== null ? `<span class="badge ${r.avg_grade < 75 ? 'danger' : 'ok'}">${r.avg_grade}</span>` : '—';
    const absDisplay = r.absences > 0 ? `<span class="badge danger">${r.absences}</span>` : '0';
    const sevBadge = r.severity === 'high' ? '<span class="badge danger">High</span>' : '<span class="badge warn">Medium</span>';
    return `
      <tr>
        <td><strong>${escHtml(r.full_name)}</strong></td>
        <td>Grade ${escHtml(r.grade_level)}<br><span style="font-size:12px;color:var(--muted)">${escHtml(r.section || '—')}</span></td>
        <td style="font-weight:500">${r.reasons.map(escHtml).join('<br>')}</td>
        <td>${avgDisplay}</td>
        <td>${absDisplay}</td>
        <td>${sevBadge}</td>
      </tr>`;
  }).join('') || `<tr><td colspan="6" style="text-align:center; padding: 20px;">${atRiskData.length ? 'No students match these filters.' : '🎉 No at-risk students.'}</td></tr>`;
}

// ---------- TEACHER COMPLIANCE ----------
async function loadCompliance() {
  const rows = await apiFetch('/admin/compliance');
  const badge = {
    on_track: '<span class="badge ok">On track</span>',
    behind: '<span class="badge warn">Behind</span>',
    overdue: '<span class="badge danger">Overdue</span>',
    no_subjects: '<span class="badge" style="background:#e5e7eb;color:#374151">No active subjects</span>'
  };
  document.getElementById('complianceBody').innerHTML = rows.map(r => `<tr>
      <td>${escHtml(r.teacher)}</td>
      <td>${r.active_subjects}</td>
      <td>${r.last_update ? new Date(r.last_update).toLocaleDateString() : 'Never'}<br><span style="font-size:12px;color:var(--muted)">${r.last_update ? agoText(r.days_ago) : ''}</span></td>
      <td>${r.last_attendance ? new Date(r.last_attendance).toLocaleDateString() : 'Never'}<br><span style="font-size:12px;color:var(--muted)">${r.last_attendance ? agoText(r.attendance_days_ago) : ''}</span></td>
      <td>${badge[r.status] || ''}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="text-align:center; padding: 20px;">No teachers found.</td></tr>';
}

// ---------- REPORTS ----------
async function exportCSV() {
  const rows = await apiFetch('/admin/export');
  // Names are stored as "LAST, FIRST", so every value is quoted or the comma would split the column
  const q = (v) => { const t = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const header = ['LRN', 'Name', 'Grade Level', 'Section', 'Subject', 'Term', 'Final'];
  const lines = [header.join(',')];
  rows.forEach(r => lines.push([r.lrn, r.full_name, r.grade_level, r.section, r.subject, r.term, r.term_grade].map(q).join(',')));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'school_report.csv';
  a.click();
  showToast('CSV downloaded!');
}

loadDashboard();