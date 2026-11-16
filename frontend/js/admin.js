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

// opts (optional) lets other parts of the page redirect here with filters already applied
function showView(name, el, opts) {
  opts = opts || {};
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(`view-${name}`).style.display = 'block';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (!el) el = [...document.querySelectorAll('.nav-item')].find(b => (b.getAttribute('onclick') || '').includes(`'${name}'`));
  if (el) el.classList.add('active');

  const titles = {
    'dashboard': 'Administrator Dashboard: School-Wide Oversight', 'users': 'Manage Users', 'subjects': 'Manage Subjects',
    'sections': 'Sections & Transfers', 'atrisk': 'At-Risk Students', 'compliance': 'Teacher Compliance', 'reports': 'Reports'
  };
  document.getElementById('pageTitle').textContent = titles[name] || 'Admin Portal';
  window.scrollTo({ top: 0 });

  if (name === 'dashboard')  loadDashboard();
  if (name === 'users') {
    if (opts.role) setUserFilter(opts.role);
    if (opts.q !== undefined) document.getElementById('userSearch').value = opts.q;
    loadUsersList(); loadDropdowns();
  }
  if (name === 'subjects') {
    if (opts.q !== undefined) document.getElementById('subjSearch').value = opts.q;
    loadSubjectsList(); loadDropdowns();
  }
  if (name === 'atrisk') {
    if (Object.keys(opts).length) {
      document.getElementById('atRiskSearch').value = opts.q || '';
      document.getElementById('atRiskSeverity').value = opts.severity || 'all';
      pendingRiskLevel = opts.level ? String(opts.level) : 'all';
    }
    loadAtRisk();
  }
  if (name === 'compliance') {
    if (Object.keys(opts).length) {
      document.getElementById('compStatus').value = opts.status || 'all';
      document.getElementById('compSearch').value = opts.q || '';
    }
    loadCompliance().then(() => { if (opts.teacherId) openTeacherRecords(opts.teacherId); });
  }
  if (name === 'sections') {
    if (Object.keys(opts).length) {
      pendingSecLevel = opts.level ? String(opts.level) : 'all';
      document.getElementById('secSearch').value = opts.q || '';
    }
    loadSections().then(() => { if (opts.sectionId) openSectionStudents(opts.sectionId); });
  }
}

// Redirect to another tab from anywhere (dashboard cards, bars, rows ...)
function goTo(view, opts) { showView(view, null, opts); }

function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
window.onclick = function(event) { if (event.target.classList.contains('modal')) event.target.style.display = 'none'; }

function toggleStudentFields() {
  const isStudent = document.getElementById('userRole').value === 'student';
  document.getElementById('studentFields').style.display = isStudent ? 'grid' : 'none';
  // Students log in with their LRN: email is optional, and the password defaults to the LRN
  document.getElementById('userEmail').required = !isStudent;
  document.getElementById('userEmailLabel').textContent = isStudent ? 'Email Address (optional)' : 'Email Address';
  document.getElementById('userEmail').placeholder = isStudent ? 'Leave blank if none' : 'email@school.edu';
  const adding = !document.getElementById('editUserId').value;
  document.getElementById('userPassword').required = adding && !isStudent;
  document.getElementById('userPassword').placeholder = isStudent && adding ? 'Blank = LRN' : 'Set a password';
}

function openUserModal() {
  document.getElementById('userForm').reset();
  document.getElementById('editUserId').value = ''; 
  document.getElementById('userModalTitle').textContent = '➕ Add New User';
  document.getElementById('userPassword').required = true;
  document.getElementById('userMsg').textContent = '';
  document.getElementById('studentFields').style.display = 'none';
  toggleStudentFields();
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
  toggleStudentFields();
  document.getElementById('userPassword').required = false;
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
      <td>${u.email ? escHtml(u.email) : '<span style="color:var(--muted)">—</span>'}</td>
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

function setUserFilter(role) {
  currentUserFilter = role;
  document.querySelectorAll('.user-tab').forEach(t => t.classList.toggle('active', (t.getAttribute('onclick') || '').includes(`'${role}'`)));
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
let pendingRiskLevel = null;   // set when another tab redirects here with a grade-level filter

async function loadAtRisk() {
  atRiskData = await apiFetch('/admin/at-risk');
  const levels = [...new Set(atRiskData.map(r => r.grade_level))].sort((a, b) => a - b);
  const sel = document.getElementById('atRiskLevel');
  const keep = sel.value;
  sel.innerHTML = '<option value="all">All grade levels</option>' + levels.map(l => `<option value="${l}">Grade ${l}</option>`).join('');
  const want = pendingRiskLevel !== null ? pendingRiskLevel : keep;
  pendingRiskLevel = null;
  if ([...sel.options].some(o => o.value === want)) sel.value = want;
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
let complianceData = [];
const COMP_BADGE = {
  on_track: '<span class="badge ok">On track</span>',
  behind: '<span class="badge warn">Behind</span>',
  overdue: '<span class="badge danger">Overdue</span>',
  no_subjects: '<span class="badge" style="background:#e5e7eb;color:#374151">No active subjects</span>'
};

async function loadCompliance() {
  complianceData = await apiFetch('/admin/compliance');
  renderCompliance();
}

function renderCompliance() {
  const q = document.getElementById('compSearch').value.toLowerCase();
  const st = document.getElementById('compStatus').value;
  const rows = complianceData.filter(r => (st === 'all' || r.status === st) && (!q || r.teacher.toLowerCase().includes(q)));
  document.getElementById('compCount').textContent = `Showing ${rows.length} of ${complianceData.length}`;
  document.getElementById('complianceBody').innerHTML = rows.map(r => `<tr class="clickable" tabindex="0" role="button"
      onclick="openTeacherRecords(${r.teacher_id})" onkeydown="if(event.key==='Enter')openTeacherRecords(${r.teacher_id})">
      <td><strong>${escHtml(r.teacher)}</strong></td>
      <td>${r.active_subjects}</td>
      <td>${r.last_update ? new Date(r.last_update).toLocaleDateString() : 'Never'}<br><span style="font-size:12px;color:var(--muted)">${r.last_update ? agoText(r.days_ago) : ''}</span></td>
      <td>${r.last_attendance ? new Date(r.last_attendance).toLocaleDateString() : 'Never'}<br><span style="font-size:12px;color:var(--muted)">${r.last_attendance ? agoText(r.attendance_days_ago) : ''}</span></td>
      <td>${COMP_BADGE[r.status] || ''}</td>
      <td><span class="go-hint">View records →</span></td>
    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center; padding: 20px;">No teachers match.</td></tr>';
}

// ---------- TEACHER RECORDS (read-only class records) ----------
let recCtx = { teacherId: null, teacherName: '', subjects: [], record: null, tab: 1 };
const fmtN = (v, d) => (v === null || v === undefined || v === '' ? '' : (d === undefined ? Number(v) : Number(v).toFixed(d)));

async function openTeacherRecords(teacherId) {
  const body = document.getElementById('recordBody');
  body.innerHTML = '<div class="dash-empty">Loading…</div>';
  openModal('recordModal');
  try {
    const r = await apiFetch(`/admin/teachers/${teacherId}/subjects`);
    recCtx = { teacherId, teacherName: r.teacher.full_name, subjects: r.subjects, record: null, tab: 1 };
    renderTeacherSubjects();
  } catch (err) { body.innerHTML = `<div class="error-msg">❌ ${escHtml(err.message)}</div>`; }
}

function renderTeacherSubjects() {
  const { teacherName, subjects } = recCtx;
  document.getElementById('recordBody').innerHTML = `
    <h3 style="margin-bottom:4px">👩‍🏫 ${escHtml(teacherName)}</h3>
    <div class="ro-banner">👁 View only — class records can be viewed and downloaded here but only the teacher can edit them.</div>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>Subject</th><th>Section</th><th>Status</th><th>Students graded</th><th>Last update</th><th></th></tr></thead>
      <tbody>${subjects.map(s => `<tr class="clickable" tabindex="0" onclick="openClassRecord(${s.id})" onkeydown="if(event.key==='Enter')openClassRecord(${s.id})">
        <td><strong>${escHtml(s.name)}</strong><br><span class="dash-sub">${escHtml(s.code || '')}</span></td>
        <td>${escHtml(s.section || '—')}</td>
        <td>${s.status === 'finished' ? '<span class="badge" style="background:#e5e7eb;color:#374151">Finished</span>' : '<span class="badge ok">Active</span>'}</td>
        <td>${s.graded_count} / ${s.student_count}</td>
        <td>${s.last_update ? new Date(s.last_update).toLocaleDateString() : 'Never'}</td>
        <td><span class="go-hint">Open class record →</span></td></tr>`).join('') ||
        '<tr><td colspan="6" style="text-align:center;padding:20px">This teacher has no subjects.</td></tr>'}</tbody>
    </table></div>`;
}

async function openClassRecord(subjectId) {
  const body = document.getElementById('recordBody');
  body.innerHTML = '<div class="dash-empty">Loading class record…</div>';
  try {
    recCtx.record = await apiFetch(`/admin/class-record/${subjectId}`);
    recCtx.tab = 1;
    renderClassRecord();
  } catch (err) { body.innerHTML = `<div class="error-msg">❌ ${escHtml(err.message)}</div>`; }
}

function setRecTab(t) { recCtx.tab = t; renderClassRecord(); }

function renderClassRecord() {
  const rec = recCtx.record, m = rec.meta, tab = recCtx.tab;
  const tabs = [1, 2, 3, 'final'].map(t => `<button class="rec-tab ${t === tab ? 'active' : ''}" onclick="setRecTab(${typeof t === 'number' ? t : "'final'"})">${t === 'final' ? 'Final Grades' : 'Term ' + t}</button>`).join('');
  const [wW, wP, wE] = m.weights || [0.2, 0.5, 0.3];
  let table;

  if (tab === 'final') {
    table = `<table class="rec-table"><thead><tr><th>#</th><th>Learner</th><th>LRN</th><th>Term 1</th><th>Term 2</th><th>Term 3</th><th>Final</th><th>Remarks</th></tr></thead><tbody>` +
      rec.final.map((r, i) => `<tr><td>${i + 1}</td><td class="name">${escHtml(r.full_name)}</td><td>${escHtml(r.lrn || '')}</td>
        <td>${fmtN(r.t1)}</td><td>${fmtN(r.t2)}</td><td>${fmtN(r.t3)}</td>
        <td class="calc ${r.passed === false ? 'fail' : ''}">${fmtN(r.final)}</td>
        <td>${r.passed === null ? '' : r.passed ? 'Passed' : 'Failed'}</td></tr>`).join('') + '</tbody></table>';
  } else {
    const rows = rec.terms[tab] || [];
    const hps = rows.find(r => r.ww1_hps !== null && r.ww1_hps !== undefined) || {};
    const WW = [1, 2, 3, 4, 5], PT = [1, 2, 3], EX = [1, 2, 3];
    const head = `<tr><th rowspan="2">#</th><th rowspan="2">Learner</th><th rowspan="2">LRN</th>
      <th colspan="${WW.length}">Written Work (${Math.round(wW * 100)}%)</th><th colspan="${PT.length}">Performance Tasks (${Math.round(wP * 100)}%)</th><th colspan="${EX.length}">Exam (${Math.round(wE * 100)}%)</th>
      <th rowspan="2">Initial</th><th rowspan="2">Term Grade</th><th rowspan="2">Descriptor</th></tr>
      <tr>${WW.map(i => `<th>WW${i}</th>`).join('')}${PT.map(i => `<th>PT${i}</th>`).join('')}${EX.map(i => `<th>EX${i}</th>`).join('')}</tr>`;
    const hpsRow = `<tr class="hps"><td></td><td class="name">Highest Possible Score</td><td></td>
      ${WW.map(i => `<td>${fmtN(hps['ww' + i + '_hps'])}</td>`).join('')}${PT.map(i => `<td>${fmtN(hps['pt' + i + '_hps'])}</td>`).join('')}${EX.map(i => `<td>${fmtN(hps['ex' + i + '_hps'])}</td>`).join('')}
      <td></td><td></td><td></td></tr>`;
    const bodyRows = rows.map((r, i) => `<tr><td>${i + 1}</td><td class="name">${escHtml(r.full_name)}</td><td>${escHtml(r.lrn || '')}</td>
      ${WW.map(n => `<td>${fmtN(r['ww' + n])}</td>`).join('')}${PT.map(n => `<td>${fmtN(r['pt' + n])}</td>`).join('')}${EX.map(n => `<td>${fmtN(r['ex' + n])}</td>`).join('')}
      <td class="calc">${fmtN(r.initial_grade, 2)}</td>
      <td class="calc ${r.term_grade !== null && r.term_grade !== undefined && Number(r.term_grade) < 75 ? 'fail' : ''}">${fmtN(r.term_grade)}</td>
      <td>${escHtml(r.descriptor || '')}</td></tr>`).join('');
    table = `<table class="rec-table"><thead>${head}</thead><tbody>${hpsRow}${bodyRows}</tbody></table>`;
  }

  document.getElementById('recordBody').innerHTML = `
    <div class="crumbs"><button onclick="renderTeacherSubjects()">← ${escHtml(recCtx.teacherName)}</button> / ${escHtml(m.subject_name)}</div>
    <div class="table-header" style="margin-bottom:6px">
      <h3>📘 ${escHtml(m.subject_name)} — ${escHtml(m.section)}</h3>
      <button class="btn" id="recDownload" onclick="downloadClassRecord(${m.id})">⬇ Download Excel</button>
    </div>
    <div class="dash-sub">Teacher: ${escHtml(m.teacher_name || '—')} · Type: ${escHtml(m.subject_type)} · ${rec.final.length} learners</div>
    <div class="ro-banner" style="margin-top:10px">👁 View only — grades cannot be edited from the admin portal.</div>
    <div class="rec-tabs">${tabs}</div>
    <div class="rec-wrap">${table}</div>`;
}

// Binary download: apiFetch only returns JSON, so use fetch with the same token
async function downloadClassRecord(subjectId) {
  const btn = document.getElementById('recDownload');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  try {
    const res = await fetch(`${API}/admin/class-record/${subjectId}/export`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (res.status === 401) return logout();
    if (!res.ok) {
      let msg = 'Download failed';
      try { msg = (await res.json()).error || msg; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const cd = res.headers.get('Content-Disposition') || '';
    const name = (/filename="?([^";]+)"?/.exec(cd) || [])[1] || 'ClassRecord.xlsx';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Class record downloaded!');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// ---------- SECTIONS & TRANSFERS ----------
let sectionsData = [];
let pendingSecLevel = null;
let openSectionId = null;
let sectionStudents = [];

async function loadSections() {
  sectionsData = await apiFetch('/admin/sections/summary');
  const sel = document.getElementById('secLevel');
  const levels = [...new Set(sectionsData.map(s => s.grade_level).filter(Boolean))].sort((a, b) => a - b);
  const keep = sel.value;
  sel.innerHTML = '<option value="all">All grade levels</option>' + levels.map(l => `<option value="${l}">Grade ${l}</option>`).join('');
  const want = pendingSecLevel !== null ? pendingSecLevel : keep;
  pendingSecLevel = null;
  if ([...sel.options].some(o => o.value === want)) sel.value = want;
  renderSections();
}

function renderSections() {
  const q = document.getElementById('secSearch').value.toLowerCase();
  const lvl = document.getElementById('secLevel').value;
  const rows = sectionsData.filter(s => (lvl === 'all' || String(s.grade_level) === lvl) && (!q || s.name.toLowerCase().includes(q)));
  document.getElementById('sectionsBody').innerHTML = rows.map(s => `<tr>
      <td><strong>${escHtml(s.name)}</strong></td>
      <td>${s.grade_level ? 'Grade ' + escHtml(s.grade_level) : '—'}</td>
      <td>${s.student_count}</td><td>${s.subject_count}</td>
      <td>
        <button class="btn-edit" onclick="openSectionStudents(${s.id})">Students</button>
        <button class="btn-edit" onclick="openSectionModal(${s.id})">Rename</button>
        <button class="btn-delete" onclick="deleteSection(${s.id})">Delete</button>
      </td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center;padding:20px">No sections found.</td></tr>';
}

function openSectionModal(id) {
  document.getElementById('sectionForm').reset();
  document.getElementById('sectionMsg').textContent = '';
  const s = id ? sectionsData.find(x => x.id === id) : null;
  document.getElementById('editSectionId').value = s ? s.id : '';
  document.getElementById('sectionName').value = s ? s.name : '';
  document.getElementById('sectionModalTitle').textContent = s ? '✏️ Rename Section' : '➕ New Section';
  openModal('sectionModal');
}

document.getElementById('sectionForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('sectionMsg');
  const id = document.getElementById('editSectionId').value;
  const payload = { name: document.getElementById('sectionName').value };
  msg.textContent = 'Saving...'; msg.style.color = 'var(--muted)';
  try {
    if (id) await apiFetch(`/admin/sections/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await apiFetch('/admin/sections', { method: 'POST', body: JSON.stringify(payload) });
    showToast(id ? 'Section renamed.' : 'Section created!');
    closeModal('sectionModal');
    loadSections(); loadDropdowns();
  } catch (err) { msg.textContent = '❌ ' + err.message; msg.style.color = 'var(--danger)'; }
});

async function deleteSection(id) {
  const s = sectionsData.find(x => x.id === id);
  if (!confirm(`Delete section ${s ? s.name : ''}? Only empty sections can be deleted.`)) return;
  try {
    await apiFetch(`/admin/sections/${id}`, { method: 'DELETE' });
    showToast('Section deleted.');
    if (openSectionId === id) closeSectionPanel();
    loadSections(); loadDropdowns();
  } catch (err) { showToast(err.message, 'error'); }
}

async function openSectionStudents(id) {
  openSectionId = Number(id);
  const s = sectionsData.find(x => x.id === openSectionId);
  document.getElementById('sectionPanelTitle').textContent = `Students — ${s ? s.name : ''}`;
  document.getElementById('sectionPanel').style.display = 'block';
  sectionStudents = await apiFetch(`/admin/sections/${openSectionId}/students`);
  document.getElementById('secSelectAll').checked = false;
  document.getElementById('sectionStudentsBody').innerHTML = sectionStudents.map(st => `<tr>
      <td><input type="checkbox" class="sec-check sec-student" value="${st.student_id}" onchange="updateTransferBtn()"></td>
      <td><strong>${escHtml(st.full_name)}</strong></td><td>${escHtml(st.lrn || '')}</td><td>${escHtml(st.gender || '')}</td></tr>`).join('')
    || '<tr><td colspan="4" style="text-align:center;padding:20px">No students in this section.</td></tr>';
  updateTransferBtn();
  document.getElementById('sectionPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeSectionPanel() { openSectionId = null; document.getElementById('sectionPanel').style.display = 'none'; }
const selectedStudentIds = () => [...document.querySelectorAll('.sec-student:checked')].map(c => Number(c.value));
function toggleAllSectionStudents(on) { document.querySelectorAll('.sec-student').forEach(c => { c.checked = on; }); updateTransferBtn(); }
function updateTransferBtn() {
  const n = selectedStudentIds().length;
  const b = document.getElementById('transferBtn');
  b.disabled = n === 0;
  b.textContent = n ? `↔ Transfer selected (${n})` : '↔ Transfer selected';
}

function openTransferModal() {
  const ids = selectedStudentIds();
  if (!ids.length) return;
  const from = sectionsData.find(x => x.id === openSectionId);
  document.getElementById('transferFrom').textContent = `${ids.length} student(s) from ${from ? from.name : ''}`;
  const others = sectionsData.filter(x => x.id !== openSectionId);
  document.getElementById('transferTo').innerHTML = '<option value="">— Choose section —</option>' + others.map(x => `<option value="${x.id}">${escHtml(x.name)}</option>`).join('');
  document.getElementById('transferPreview').textContent = 'Choose a destination section.';
  document.getElementById('transferConfirm').disabled = true;
  document.getElementById('transferMsg').textContent = '';
  openModal('transferModal');
}

async function previewTransfer() {
  const to = document.getElementById('transferTo').value;
  const box = document.getElementById('transferPreview');
  const btn = document.getElementById('transferConfirm');
  btn.disabled = true;
  if (!to) { box.textContent = 'Choose a destination section.'; return; }
  box.textContent = 'Checking…';
  try {
    const p = await apiFetch('/admin/sections/transfer', { method: 'POST', body: JSON.stringify({ student_ids: selectedStudentIds(), to_section_id: to, preview: true }) });
    box.innerHTML = `<b>${p.moving}</b> student(s) will move to <b>${escHtml(p.to_section)}</b>, which has <b>${p.destination_subjects}</b> subject(s).` +
      (p.grade_rows_left_behind ? `<br>⚠ ${p.grade_rows_left_behind} existing grade record(s) belong to subjects of the old section. They are <b>kept, not deleted</b>, but will no longer appear in the new section's class records.` : '') +
      `<br>Attendance already recorded stays with the old section; new attendance will be counted in the new section.`;
    btn.disabled = false;
  } catch (err) { box.textContent = '❌ ' + err.message; }
}

async function confirmTransfer() {
  const msg = document.getElementById('transferMsg');
  const btn = document.getElementById('transferConfirm');
  btn.disabled = true;
  try {
    const r = await apiFetch('/admin/sections/transfer', { method: 'POST', body: JSON.stringify({ student_ids: selectedStudentIds(), to_section_id: document.getElementById('transferTo').value }) });
    showToast(r.message || 'Students transferred.');
    closeModal('transferModal');
    await loadSections();
    openSectionStudents(openSectionId);
  } catch (err) { msg.textContent = '❌ ' + err.message; msg.style.color = 'var(--danger)'; btn.disabled = false; }
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