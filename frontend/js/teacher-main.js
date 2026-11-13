// js/teacher-main.js
requireAuth('teacher');
document.getElementById('userChip').textContent = '👩‍🏫 ' + getUser().name;

let mySubjectsData = []; 
let currentViewName = 'subjects';

window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedChanges) { e.preventDefault(); e.returnValue = ''; }
});

function pushViewState(name) {
  history.pushState({ view: name }, '', '#' + name);
}

window.addEventListener('popstate', async (e) => {
  if (!getToken()) {
    window.location.replace('index.html');
    return;
  }

  if (hasUnsavedChanges) {
    const leave = confirm('You have unsaved changes. Leave this page?');
    if (!leave) {
      history.pushState({ view: currentViewName }, '', '#' + currentViewName);
      return;
    }
    hasUnsavedChanges = false;
    document.getElementById('unsavedIndicator').style.display = 'none';
  }

  const targetView = e.state?.view;

  if (!targetView || targetView === 'subjects') {
    if (!targetView && currentViewName === 'subjects') {
      const doLogout = confirm('Do you want to log out?');
      if (doLogout) {
        logout();
      } else {
        history.pushState({ view: 'subjects' }, '', '#subjects');
      }
      return;
    }
    navigateToView('subjects', false);
    return;
  }

  navigateToView(targetView, false);
});

function confirmLogout() {
  if (hasUnsavedChanges) {
    const leave = confirm('You have unsaved changes. Log out anyway?');
    if (!leave) return;
  } else {
    const leave = confirm('Log out of the Teacher Portal?');
    if (!leave) return;
  }
  logout();
}

function showView(name, el) {
  if (hasUnsavedChanges && !confirm('You have unsaved changes. Are you sure you want to leave?')) return;
  hasUnsavedChanges = false;
  document.getElementById('unsavedIndicator').style.display = 'none';

  pushViewState(name);
  navigateToView(name, el);
}

function navigateToView(name, el) {
  currentViewName = name;

  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(`view-${name}`).style.display = 'block';

  if (el) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
  } else {
    const map = {
      subjects: 0, gradebook: 0,
      attendance: 1, 'attendance-sheet': 1, 'attendance-history': 1,
      warning: 2, sf2: 3
    };
    const idx = map[name];
    if (idx !== undefined) {
      const navs = document.querySelectorAll('.nav-item');
      navs.forEach(n => n.classList.remove('active'));
      if (navs[idx]) navs[idx].classList.add('active');
    }
  }

  const titles = {
    'subjects': 'My Classes', 'gradebook': 'Class Record', 'attendance': 'Attendance Dashboard',
    'attendance-sheet': 'Daily Attendance', 'attendance-history': 'Monthly History',
    'warning': 'Early Warning', 'sf2': 'SF2 Report'
  };
  document.getElementById('pageTitle').textContent = titles[name] || 'Teacher Portal';

  if (name === 'attendance') loadAttendanceDashboard();
  if (name === 'warning')    loadWarnings();
  if (name === 'sf2')        loadSF2();
}

// --- SUBJECT MANAGEMENT ---
async function openSubjectModal() {
  document.getElementById('subjectForm').reset();
  document.getElementById('subjMsg').textContent = '';
  
  try {
    const sections = await apiFetch('/teacher/sections');
    const select = document.getElementById('subjSection');
    select.innerHTML = sections.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    
    document.getElementById('subjectModal').style.display = 'flex';
  } catch (err) {
    showToast('Failed to load sections.', 'error');
  }
}

function closeSubjectModal() {
  document.getElementById('subjectModal').style.display = 'none';
}

document.getElementById('subjectForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msgDiv = document.getElementById('subjMsg');
  msgDiv.textContent = 'Saving...'; msgDiv.style.color = 'var(--muted)';

  const payload = {
    code: document.getElementById('subjCode').value.trim(),
    name: document.getElementById('subjName').value.trim(),
    section_id: document.getElementById('subjSection').value
  };

  try {
    await apiFetch('/teacher/subjects', { method: 'POST', body: JSON.stringify(payload) });
    showToast('Subject created successfully!');
    closeSubjectModal();
    initDashboard(); 
  } catch (err) {
    msgDiv.textContent = '❌ ' + err.message; msgDiv.style.color = 'var(--danger)';
  }
});

async function deleteSubject(event, subjectId, subjectName) {
  event.stopPropagation(); 
  
  if (!confirm(`Are you sure you want to delete "${subjectName}"? This will permanently delete all associated grades and attendance records.`)) return;
  
  try {
    await apiFetch(`/teacher/subjects/${subjectId}`, { method: 'DELETE' });
    showToast('Subject deleted.');
    initDashboard(); 
  } catch (err) {
    console.error("Delete failed:", err);
    showToast('Error: ' + (err.message || 'Could not delete subject.'), 'error');
  }
}

async function initDashboard() {
  const subjects = await apiFetch('/teacher/my-subjects');
  mySubjectsData = subjects; 
  const grid = document.getElementById('subjectsGrid');
  
  if (subjects.length === 0) { 
    grid.innerHTML = '<p style="text-align:center; width: 100%; padding: 20px; color: var(--muted);">No subjects assigned yet. Click "+ Create Subject" to start.</p>'; 
    return; 
  }

  grid.innerHTML = subjects.map(s => `
    <div class="subject-card" onclick="openClassRecord(${s.id})" style="position: relative;">
      
      <button onclick="deleteSubject(event, ${s.id}, '${s.name.replace(/'/g, "\\'")}')" 
              style="position: absolute; top: 12px; right: 12px; background: #fee2e2; color: #991b1b; border: none; border-radius: 4px; width: 28px; height: 28px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; transition: background 0.2s;"
              onmouseover="this.style.background='#fca5a5'" onmouseout="this.style.background='#fee2e2'"
              title="Delete Subject">
        🗑️
      </button>

      <h3 style="padding-right: 30px;">📚 ${s.name}</h3>
      <p>Section: ${s.section}</p>
      <div style="margin-top: 15px; font-size: 12px; font-weight: bold; color: var(--primary);">Open Class Record →</div>
    </div>
  `).join('');
}

function openClassRecord(subjectId) {
  const subj = mySubjectsData.find(s => s.id === subjectId);
  if (!subj) return;
  currentSubjectId = subjectId;
  initSubjectType(subj);

  document.getElementById('termSelect').value = '1';
  restoreGradebookLayout();

  document.getElementById('gradebookTitle').textContent = `${subj.name} — ${subj.section}`;
  showView('gradebook');
  loadGradebook();
}

// --- EXPORT TO EXCEL ---
async function downloadExcel() {
  if (!currentSubjectId) {
    showToast('Please open a class record first.', 'error');
    return;
  }

  if (hasUnsavedChanges) {
    const confirmSave = confirm("You have unsaved changes. Save them before downloading?");
    if (confirmSave) {
      await saveAllGrades();
    }
  }

  const btn = event?.target?.closest('button');
  const originalText = btn?.innerHTML;
  
  if (btn) {
    btn.innerHTML = '⏳ Generating...';
    btn.disabled = true;
  }

  try {
    const typeQuery = encodeURIComponent(currentSubjectType);
    const url = `/api/teacher/class-record/${currentSubjectId}/export?type=${typeQuery}`;
    const token = localStorage.getItem('token') || localStorage.getItem('authToken');

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    
    const cd = response.headers.get('Content-Disposition');
    let filename = `ClassRecord.xlsx`;
    if (cd && cd.includes('filename="')) {
      filename = cd.split('filename="')[1].split('"')[0];
    }

    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    
    a.remove();
    window.URL.revokeObjectURL(downloadUrl);
    
    showToast('Excel file downloaded successfully!');
  } catch (err) {
    console.error('Download error:', err);
    showToast('Failed to download Excel file.', 'error');
  } finally {
    if (btn) {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  }
}

// Seed initial state so Back/Forward work from the very start
history.replaceState({ view: 'subjects' }, '', '#subjects');

// Boot
document.getElementById('attDate').valueAsDate = new Date();
document.querySelectorAll('.hps-input').forEach(el => el.addEventListener('input', updateHpsTotals));
initDashboard();