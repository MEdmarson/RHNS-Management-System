// js/adminDashboard.js
// Administrator Dashboard: School-Wide Oversight
//   1. Macro Progress Monitoring   2. At-Risk Student Tracking
//   3. Teacher Compliance Tracker  4. Custom Report Generator
// Loaded AFTER js/api.js and js/admin.js. admin.js's showView() calls window.loadOverview() when the Dashboard tab opens.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d) => (v === null || v === undefined ? '—' : Number(v).toFixed(d === undefined ? 1 : d));
  const level = (n) => 'Grade ' + n;

  let data = null;          // last /admin/overview result

  async function api(path) {
    const r = await apiFetch(path);
    return r && typeof r.json === 'function' ? r.json() : r;
  }

  // ---------- click-through: anything with data-nav redirects to a tab (with filters) ----------
  const nav = (view, opts) => ` data-nav="${esc(JSON.stringify({ view, opts: opts || {} }))}" tabindex="0" role="button" title="Click to open"`;

  // ---------- small drawing helpers ----------
  function bar(label, sub, value, widthPct, cls, valueText, go) {
    const w = Math.max(0, Math.min(100, widthPct || 0));
    return `<div class="bar-row${go ? ' clickable' : ''}"${go || ''}>
      <div class="bar-label">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>
      <div class="bar-track"><div class="bar-fill ${cls || ''}" style="width:${w}%"></div></div>
      <div class="bar-val">${esc(valueText !== undefined ? valueText : fmt(value))}</div>
    </div>`;
  }
  // Grades are transmuted (lowest possible is 60), so the bar scale runs 60-100.
  const gradeWidth = (g) => (g === null ? 0 : ((g - 60) / 40) * 100);
  const gradeClass = (g, pass) => (g === null ? '' : g < pass ? 'bad' : g >= 90 ? 'good' : '');
  const empty = (msg) => `<div class="dash-empty">${esc(msg)}</div>`;

  function kpi(label, value, sub, color, go) {
    return `<div class="stat-card${go ? ' clickable' : ''}"${go || ''}${color ? ` style="border-left-color:${color}"` : ''}>
      <h4>${esc(label)}</h4><div class="value"${color ? ` style="color:${color}"` : ''}>${esc(value)}</div>
      <div class="dash-sub">${esc(sub || '')}</div></div>`;
  }

  const SEVERITY = { high: '<span class="badge danger">High</span>', medium: '<span class="badge warn">Medium</span>' };
  const STATUS = {
    on_track: '<span class="badge ok">On track</span>',
    behind: '<span class="badge warn">Behind</span>',
    overdue: '<span class="badge danger">Overdue</span>',
    no_subjects: '<span class="badge" style="background:#e5e7eb;color:#374151">No active subjects</span>'
  };
  const STATUS_TEXT = { on_track: 'On track', behind: 'Behind', overdue: 'Overdue', no_subjects: 'No active subjects' };
  const ago = (days) => (days === null || days === undefined ? 'Never' : days === 0 ? 'Today' : days === 1 ? '1 day ago' : days + ' days ago');

  // ---------- sections ----------
  function renderKpis(d) {
    const k = d.kpis, S = d.settings;
    const complianceColor = k.compliance_rate === null ? '' : k.compliance_rate >= 80 ? 'var(--success)' : k.compliance_rate >= 50 ? 'var(--warning)' : 'var(--danger)';
    $('dashKpis').innerHTML = [
      kpi('Students', k.students, `${k.sections} sections`, '', nav('users', { role: 'student' })),
      kpi('Teachers', k.teachers, `${k.active_subjects} active subjects`, '', nav('users', { role: 'teacher' })),
      kpi('School average', fmt(k.school_avg), k.current_term ? `Term ${k.current_term}` : 'No grades yet', '', nav('sections')),
      kpi('Subject pass rate', k.pass_rate === null ? '—' : fmt(k.pass_rate) + '%', `Grades of ${S.passing_grade}+`, '', nav('atrisk')),
      kpi('Attendance rate', k.attendance_rate === null ? '—' : fmt(k.attendance_rate) + '%', `Last ${S.window_days} days`, '', nav('sections')),
      kpi('At-risk students', k.at_risk, k.at_risk_pct === null ? '' : fmt(k.at_risk_pct) + '% of students', k.at_risk ? 'var(--danger)' : 'var(--success)', nav('atrisk', { q: '' })),
      kpi('Teacher compliance', k.compliance_rate === null ? '—' : fmt(k.compliance_rate, 0) + '%', 'Grades updated on time', complianceColor, nav('compliance', {}))
    ].join('');
  }

  function renderProgress(d) {
    const p = d.progress, pass = d.settings.passing_grade;
    $('progTermLabel').textContent = p.current_term ? `Showing Term ${p.current_term} · bar scale 60–100` : 'No grades recorded yet';

    $('progLevels').innerHTML = p.by_grade_level.length
      ? p.by_grade_level.map((l) => bar(level(l.grade_level),
          `${l.students} students` + (l.pass_rate === null ? '' : ` · ${fmt(l.pass_rate, 0)}% pass`),
          l.avg_grade, gradeWidth(l.avg_grade), gradeClass(l.avg_grade, pass), undefined, nav('sections', { level: l.grade_level }))).join('')
      : empty('No students enrolled yet.');

    $('progTerms').innerHTML = p.by_term.length
      ? p.by_term.map((t) => bar('Term ' + t.term, '', t.avg_grade, gradeWidth(t.avg_grade), gradeClass(t.avg_grade, pass))).join('')
      : empty('No grades recorded yet.');

    if (p.distribution) {
      const total = p.distribution.reduce((s, x) => s + x.count, 0) || 1;
      const cls = { outstanding: 'good', very_satisfactory: '', satisfactory: '', fairly_satisfactory: 'mid', did_not_meet: 'bad' };
      $('progDist').innerHTML = p.distribution.map((x) =>
        bar(x.label, '', x.count, (x.count / total) * 100, cls[x.key], `${x.count} (${fmt((x.count / total) * 100, 0)}%)`)).join('');
    } else $('progDist').innerHTML = empty('No grades recorded yet.');

    $('progSections').innerHTML = p.by_section.length
      ? p.by_section.map((s) => bar(s.section, `${s.students} students`, s.avg_grade, gradeWidth(s.avg_grade), gradeClass(s.avg_grade, pass), undefined, nav('sections', { sectionId: s.section_id }))).join('')
      : empty('No section has grades yet.');
  }

  function renderAtRisk(d) {
    const a = d.at_risk;
    $('riskChips').innerHTML =
      `<span class="chip clickable"${nav('atrisk', { q: '' })}><b>${a.total}</b> flagged</span>` +
      `<span class="chip chip-danger clickable"${nav('atrisk', { severity: 'high' })}><b>${a.high}</b> high</span>` +
      `<span class="chip chip-warn clickable"${nav('atrisk', { severity: 'medium' })}><b>${a.medium}</b> medium</span>`;

    const max = Math.max(1, ...a.by_grade_level.map((l) => l.total));
    $('riskLevels').innerHTML = a.by_grade_level.length
      ? a.by_grade_level.map((l) => `<div class="bar-row clickable"${nav('atrisk', { level: l.grade_level })}>
          <div class="bar-label">${esc(level(l.grade_level))}<small>${l.students} students</small></div>
          <div class="bar-track">
            <div class="bar-fill bad" style="width:${(l.high / max) * 100}%;border-radius:0"></div>
            <div class="bar-fill mid" style="width:${(l.medium / max) * 100}%;border-radius:0"></div>
          </div>
          <div class="bar-val">${l.total}</div></div>`).join('') +
        '<div class="dash-sub">Red = high severity · Yellow = medium</div>'
      : empty('No data yet.');

    $('riskTop').innerHTML = a.top.length
      ? `<div style="overflow-x:auto"><table><thead><tr><th>Student</th><th>Level / Section</th><th>Concern</th><th>Severity</th></tr></thead><tbody>` +
        a.top.map((s) => {
          const shown = s.reasons.slice(0, 2).map(esc).join('<br>');
          const more = s.reasons.length > 2 ? `<br><span class="dash-sub">+${s.reasons.length - 2} more</span>` : '';
          return `<tr class="clickable"${nav('atrisk', { q: s.lrn || s.full_name })}><td>${esc(s.full_name)}</td><td>${esc(level(s.grade_level))}<br><span class="dash-sub">${esc(s.section)}</span></td>
            <td style="font-weight:500">${shown}${more}</td><td>${SEVERITY[s.severity] || ''}</td></tr>`;
        }).join('') + '</tbody></table></div>' +
        (a.total > a.top.length ? `<div class="dash-sub" style="margin-top:8px">Showing the ${a.top.length} most urgent of ${a.total}.</div>` : '')
      : empty('No students are flagged right now. 🎉');
  }

  function renderCompliance(d) {
    const c = d.compliance, S = d.settings;
    $('compChips').innerHTML =
      `<span class="chip chip-ok clickable"${nav('compliance', { status: 'on_track' })}><b>${c.on_track}</b> on track</span>` +
      `<span class="chip chip-warn clickable"${nav('compliance', { status: 'behind' })}><b>${c.behind}</b> behind</span>` +
      `<span class="chip chip-danger clickable"${nav('compliance', { status: 'overdue' })}><b>${c.overdue}</b> overdue</span>` +
      (c.no_subjects ? `<span class="chip clickable"${nav('compliance', { status: 'no_subjects' })}><b>${c.no_subjects}</b> no active subjects</span>` : '');
    $('compRule').textContent = `On track: grades saved within ${S.compliance_ok_days} days · Behind: within ${S.compliance_late_days} days · Overdue: older, or never.`;

    const list = c.teachers.filter((t) => t.status === 'overdue' || t.status === 'behind');
    $('compList').innerHTML = list.length
      ? `<div style="overflow-x:auto"><table><thead><tr><th>Teacher</th><th>Subjects</th><th>Last grade update</th><th>Last attendance</th><th>Status</th></tr></thead><tbody>` +
        list.slice(0, 8).map((t) => `<tr class="clickable"${nav('compliance', { teacherId: t.teacher_id })}><td>${esc(t.teacher)}</td><td>${t.active_subjects}</td><td>${esc(ago(t.days_ago))}</td>
          <td>${esc(ago(t.attendance_days_ago))}</td><td>${STATUS[t.status]}</td></tr>`).join('') + '</tbody></table></div>' +
        (list.length > 8 ? `<div class="dash-sub" style="margin-top:8px">Showing 8 of ${list.length} teachers needing attention.</div>` : '')
      : empty(c.expected ? 'Every teacher is up to date. 🎉' : 'No teachers have active subjects yet.');
  }

  function renderReportOptions(d) {
    const sel = $('repLevel');
    const keep = sel.value;
    sel.innerHTML = '<option value="all">All grade levels</option>' +
      d.progress.by_grade_level.map((l) => `<option value="${l.grade_level}">${esc(level(l.grade_level))}</option>`).join('');
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    syncReportControls();
  }

  // ---------- load ----------
  async function load() {
    const stamp = $('dashUpdated');
    stamp.textContent = 'Loading…';
    $('dashRefresh').disabled = true;
    try {
      data = await api('/admin/overview');
      renderKpis(data); renderProgress(data); renderAtRisk(data); renderCompliance(data); renderReportOptions(data);
      stamp.textContent = 'Updated ' + new Date(data.generated_at).toLocaleString();
    } catch (err) {
      stamp.textContent = '⚠ Could not load the dashboard: ' + (err && err.message ? err.message : 'unknown error');
    } finally {
      $('dashRefresh').disabled = false;
    }
  }

  // ---------- report generator (CSV) ----------
  function syncReportControls() {
    const type = $('repType').value;
    $('repLevel').disabled = type === 'compliance';
    $('repLevel').title = type === 'compliance' ? 'Teacher compliance is not split by grade level' : '';
  }

  function toCSV(rows, cols) {
    const q = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return '\uFEFF' + [cols.map((c) => q(c[1])).join(',')].concat(rows.map((r) => cols.map((c) => q(r[c[0]])).join(','))).join('\r\n');
  }
  function saveFile(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const dateOnly = (v) => (v ? String(v).slice(0, 10) : '');

  async function buildReport(type, lvl) {
    const keep = (r) => lvl === 'all' || String(r.grade_level) === String(lvl);

    if (type === 'summary') {
      const rows = data.progress.by_grade_level.filter(keep).map((l) => ({ ...l, term: data.progress.current_term }));
      return { name: 'School_Summary', csv: toCSV(rows, [['grade_level', 'Grade level'], ['students', 'Students'], ['term', 'Term'],
        ['avg_grade', 'Average grade'], ['pass_rate', 'Pass rate %'], ['at_risk', 'At-risk students'], ['high', 'High severity'], ['medium', 'Medium severity']]) };
    }
    if (type === 'atrisk') {
      const rows = (await api('/admin/at-risk')).filter(keep).map((s) => ({ ...s, reasons: s.reasons.join('; '), causes: s.causes.join(', ') }));
      return { name: 'At_Risk_Students', csv: toCSV(rows, [['lrn', 'LRN'], ['full_name', 'Student'], ['grade_level', 'Grade level'], ['section', 'Section'],
        ['severity', 'Severity'], ['causes', 'Causes'], ['worst_grade', 'Lowest subject grade'], ['avg_grade', 'Average grade'], ['absences', 'Absences'], ['reasons', 'Details']]) };
    }
    if (type === 'compliance') {
      const rows = (await api('/admin/compliance')).map((t) => ({ ...t, status: STATUS_TEXT[t.status], last_update: dateOnly(t.last_update), last_attendance: dateOnly(t.last_attendance) }));
      return { name: 'Teacher_Compliance', csv: toCSV(rows, [['teacher', 'Teacher'], ['active_subjects', 'Active subjects'], ['last_update', 'Last grade update'],
        ['days_ago', 'Days since grade update'], ['last_attendance', 'Last attendance recorded'], ['attendance_days_ago', 'Days since attendance'], ['status', 'Status']]) };
    }
    const rows = (await api('/admin/export')).filter(keep);
    return { name: 'Student_Grades', csv: toCSV(rows, [['lrn', 'LRN'], ['full_name', 'Student'], ['grade_level', 'Grade level'], ['section', 'Section'],
      ['subject', 'Subject'], ['term', 'Term'], ['term_grade', 'Term grade']]) };
  }

  async function downloadReport() {
    const btn = $('repDownload');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Preparing…';
    try {
      if (!data) await load();
      const lvl = $('repLevel').value;
      const r = await buildReport($('repType').value, lvl);
      const suffix = $('repType').value !== 'compliance' && lvl !== 'all' ? '_Grade' + lvl : '';
      saveFile(`RNHS_${r.name}${suffix}_${new Date().toISOString().slice(0, 10)}.csv`, r.csv);
    } catch (err) {
      alert('Could not build the report: ' + (err && err.message ? err.message : 'unknown error'));
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  // ---------- wiring ----------
  function goTo(view, opts) {
    if (typeof window.goTo === 'function') return window.goTo(view, opts);   // admin.js: switches tab and applies filters
    const btn = [...document.querySelectorAll('.nav-item')].find((b) => (b.getAttribute('onclick') || '').includes("'" + view + "'"));
    if (btn) btn.click();
  }

  function followNav(el) {
    try { const n = JSON.parse(el.dataset.nav); goTo(n.view, n.opts); } catch (e) { /* ignore */ }
  }

  function init() {
    if (!$('dashRoot')) return;
    $('dashRefresh').addEventListener('click', load);
    $('repDownload').addEventListener('click', downloadReport);
    $('repPrint').addEventListener('click', () => window.print());
    $('repType').addEventListener('change', syncReportControls);
    document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => goTo(b.dataset.go)));
    // one listener covers every clickable KPI card, bar, chip and row (they are redrawn on each refresh)
    $('dashRoot').addEventListener('click', (e) => { const el = e.target.closest('[data-nav]'); if (el) followNav(el); });
    $('dashRoot').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const el = e.target.closest('[data-nav]');
      if (el) { e.preventDefault(); followNav(el); }
    });

    window.loadOverview = load;   // used by admin.js -> showView('dashboard')
    load();
  }

  init();
})();