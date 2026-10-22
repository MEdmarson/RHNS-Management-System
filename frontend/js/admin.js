requireAuth('admin');
document.getElementById('userChip').textContent = '🛡️ ' + getUser().name;

function showView(name, el) {
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(`view-${name}`).style.display = 'block';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
  if (name === 'atrisk')     loadAtRisk();
  if (name === 'compliance') loadCompliance();
}

async function loadDashboard() {
  const d = await apiFetch('/admin/dashboard');
  document.getElementById('stats').innerHTML = `
    <div class="stat-card"><h4>Total Students</h4><div class="value">${d.total_students}</div></div>
    <div class="stat-card success"><h4>School Average</h4><div class="value">${d.avg_grade ?? '—'}</div></div>
    <div class="stat-card danger"><h4>At-Risk</h4><div class="value">${d.at_risk}</div></div>
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
      <td>${r.last_update || 'Never'}</td>
      <td>${overdue
        ? '<span class="badge danger">Overdue</span>'
        : '<span class="badge ok">Up to date</span>'}</td>
    </tr>`;
  }).join('');
}

async function exportCSV() {
  const rows = await apiFetch('/admin/export');
  const header = ['LRN','Name','Section','Subject','Q1','Q2','Activity','Exam','Final'];
  const lines = [header.join(',')];
  rows.forEach(r => lines.push([
    r.lrn, r.full_name, r.section, r.subject,
    r.quiz1, r.quiz2, r.activity, r.exam, r.final_grade
  ].join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'school_report.csv';
  a.click();
}

loadDashboard();