// js/teacher-main.js
requireAuth('teacher');
document.getElementById('userChip').textContent = '👩‍🏫 ' + getUser().name;

let mySubjectsData = []; 

window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedChanges) { e.preventDefault(); e.returnValue = ''; }
});

function showView(name, el) {
  if (hasUnsavedChanges && !confirm('You have unsaved changes. Are you sure you want to leave?')) return;
  hasUnsavedChanges = false;
  document.getElementById('unsavedIndicator').style.display = 'none';

  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(`view-${name}`).style.display = 'block';
  
  if (el) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
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

async function initDashboard() {
  const subjects = await apiFetch('/teacher/my-subjects');
  mySubjectsData = subjects; 
  const grid = document.getElementById('subjectsGrid');
  
  if (subjects.length === 0) { grid.innerHTML = '<p>No subjects assigned yet.</p>'; return; }

  grid.innerHTML = subjects.map(s => `
    <div class="subject-card" onclick="openClassRecord(${s.id})">
      <h3>📚 ${s.name}</h3>
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

// Boot
document.getElementById('attDate').valueAsDate = new Date();
document.querySelectorAll('.hps-input').forEach(el => el.addEventListener('input', updateHpsTotals));
initDashboard();