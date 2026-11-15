// js/student-dashboard.js
requireAuth('student');
const user = getUser();
const $ = id => document.getElementById(id);

$('userChip').textContent = '🎓 ' + user.name;
// Names are stored as "LAST, FIRST MIDDLE", so greet by the first name
function firstName(full) {
  const part = full.includes(',') ? full.split(',')[1] : full;
  const w = part.trim().split(/\s+/)[0] || full;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}
$('welcomeName').textContent = `Welcome back, ${firstName(user.name)}!`;

const VIEWS = { dashboard: 'Dashboard', attendance: 'My Attendance', notifs: 'Notifications' };
const REFRESH_MS = 120000;   // background refresh while the tab is visible
const STALE_MS = 60000;      // refresh when switching views if data is older than this

const state = {
  subjects: [], progress: null, attendance: null,
  alerts: [], messages: [], suggestions: [],
  view: 'dashboard', lastLoad: 0, lastBadge: null,
};
let lastFocus = null;

// ---- Helpers ----
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function showToast(message, type = 'info', onClick = null) {
  const container = $('toastContainer');
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
    </div>`;

  if (onClick) toast.addEventListener('click', () => { onClick(); toast.remove(); });
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 6000);
}

const STATUS_CLASS = {
  'Passed': 'passed', 'Failed': 'failed', 'INC / Not Submitted': 'inc',
  'In Progress': 'in-progress', 'Not Started': '',
};
const statusPill = s => `<span class="status-pill ${STATUS_CLASS[s] ?? ''}">${escapeHtml(s)}</span>`;
const meter = (pct, color) =>
  `<div class="meter" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100">
     <div class="meter-fill" style="width:${pct}%; background:${color};"></div></div>`;

// ---- Which live alerts has this student already seen? (kept in this browser) ----
const SEEN_KEY = `rnhs_seen_alerts_${user.id ?? user.name}`;
function loadSeen() { try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch { return {}; } }
function saveSeen(o) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(o)); } catch { /* storage unavailable */ } }

function unreadTotal() {
  const seen = loadSeen();
  return state.alerts.filter(a => seen[a.id] !== a.sig).length + state.messages.filter(m => !m.is_read).length;
}

function updateBadge() {
  const n = unreadTotal();
  const badge = $('notifBadge');
  badge.textContent = n > 9 ? '9+' : n;
  badge.style.display = n > 0 ? 'inline-block' : 'none';
  return n;
}

// ---- Navigation ----
function showView(name, { push = true } = {}) {
  if (!VIEWS[name]) name = 'dashboard';
  state.view = name;

  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  $(`view-${name}`).style.display = 'block';
  document.querySelectorAll('.nav-item[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  $('pageTitle').textContent = VIEWS[name];

  if (push && history.state?.view !== name) history.pushState({ view: name }, '', '#' + name);

  if (name === 'notifs') renderNotifs();
  if (state.lastLoad && Date.now() - state.lastLoad > STALE_MS) loadAll({ silent: true });
}

window.addEventListener('popstate', e => showView(e.state?.view || location.hash.slice(1), { push: false }));

// ---- Suggestions ----
function subjectHint(s) {
  const incTerm = [1, 2, 3].find(n => s.term_status[n] === 'inc');
  if (incTerm) {
    return { cls: 'bad', text: s.finished_by_teacher
      ? `INC in Term ${incTerm}. This subject is finished, so approach ${s.teacher} to ask how to clear it.`
      : `INC in Term ${incTerm}. Submit the missing requirements to your teacher.` };
  }

  const t = s.target;
  if (!t) return null;
  if (t.state === 'secured') return { cls: 'good', text: 'You are on track to pass this subject.' };
  if (t.state === 'out_of_reach') return { cls: 'bad', text: 'Passing by grades alone is no longer possible. Ask your teacher about remediation.' };
  return {
    cls: '',
    text: t.termsLeft === 1
      ? `You need at least ${t.needed} in the last term to pass.`
      : `You need an average of at least ${t.needed} over the remaining ${t.termsLeft} terms to pass.`,
  };
}

function buildSuggestions() {
  const out = [];
  const push = (sev, title, body, action = {}) => out.push({ sev, title, body, ...action });

  for (const s of state.subjects) {
    const incTerms = [1, 2, 3].filter(n => s.term_status[n] === 'inc');
    if (s.finished_by_teacher && incTerms.length) {
      push(3, `${s.subject}: INC in ${incTerms.length > 1 ? 'Terms' : 'Term'} ${incTerms.join(', ')}`,
        `This subject is already marked finished, so requirements are settled in person. Approach ${s.teacher} and ask how to clear your INC.`,
        { id: s.subject_id });
    }
    for (const n of [1, 2, 3]) {
      const overdue = s.term_overdue[n] || [];
      const st = s.term_status[n];
      if (overdue.length) {
        push(st === 'inc' ? 3 : 2,
          `${s.subject}, Term ${n}: ${plural(overdue.length, 'item')} missing`,
          `Submit ${overdue.join(', ')} to your teacher${st === 'inc' ? ' to clear your INC.' : ' to avoid an INC.'}`,
          { id: s.subject_id });
      }
      if (st === 'failed') {
        const g = s[`term${n}`];
        push(2, `${s.subject}, Term ${n}: ${g ?? 'below 75'}`,
          'This is under the passing grade of 75. Ask your teacher about make-up work and review the topics you missed.',
          { id: s.subject_id });
      }
    }
    if (s.target?.state === 'out_of_reach') {
      push(3, `${s.subject}: passing is at risk`, subjectHint(s).text, { id: s.subject_id });
    } else if (s.target?.state === 'reachable') {
      push(1, `${s.subject}: aim for ${s.target.needed}+`, subjectHint(s).text, { id: s.subject_id });
    }
  }

  const a = state.attendance;
  if (a) {
    if (a.remaining <= 0) {
      push(3, 'You reached the absence limit', 'Talk to your adviser right away about your attendance.', { view: 'attendance' });
    } else if (a.absent >= 15) {
      push(3, `${a.absent} absences recorded`, `The limit is ${a.limit} per school year, and only ${plural(a.remaining, 'more absence')} would reach it. Avoid missing classes.`, { view: 'attendance' });
    } else if (a.absent >= 10) {
      push(2, `${a.absent} absences recorded`, `The limit is ${a.limit} per school year. Try to attend every class from here on.`, { view: 'attendance' });
    }
    if (a.late % 3 === 2) {
      push(1, 'One more late counts as an absence', 'Every 3 lates are counted as 1 absence. Arrive on time to keep your record clean.', { view: 'attendance' });
    }
  }

  const p = state.progress;
  if (!out.length && p?.total) {
    if (p.completed === p.total) {
      push(0, 'All subjects completed', 'You have finished every subject. Check your promotion status above.');
    } else {
      push(0, 'You are on track', 'Nothing needs your attention right now. Keep submitting your activities on time.');
    }
  }

  return out.sort((x, y) => y.sev - x.sev).slice(0, 6);
}

const SEV_LABEL = { 3: 'Urgent', 2: 'Soon', 1: 'Tip', 0: 'Good news' };

function renderFocus() {
  const list = state.suggestions;
  $('focusList').innerHTML = list.length
    ? list.map(s => `
      <li class="focus-item sev-${s.sev}" ${s.id || s.view ? `tabindex="0" role="button" data-id="${s.id ?? ''}" data-view="${s.view ?? ''}"` : ''}>
        <span class="sev-tag">${SEV_LABEL[s.sev]}</span>
        <div><b>${escapeHtml(s.title)}</b><p>${escapeHtml(s.body)}</p></div>
      </li>`).join('')
    : '<li class="empty">Your suggestions will appear once you have subjects.</li>';
}

// ---- Dashboard renderers ----
function renderHero() {
  const p = state.progress;
  const urgent = state.suggestions.filter(s => s.sev >= 2).length;

  $('promotionStatus').textContent = p.promotionStatus;
  $('heroLine').textContent = !p.total
    ? 'No subjects are assigned to your section yet.'
    : `${p.completed} of ${p.total} subjects completed. ` +
      (urgent ? `${plural(urgent, 'item')} need${urgent === 1 ? 's' : ''} your attention.` : 'Nothing urgent right now.');

  const cls = { 'Passed': 'c-passed', 'Failed': 'c-failed', 'INC / Not Submitted': 'c-inc', 'In Progress': 'c-progress' };
  $('subjectBlocks').innerHTML = state.subjects
    .map(s => `<div class="block ${cls[s.status] || ''}" title="${escapeHtml(s.subject)}: ${escapeHtml(s.status)}"></div>`).join('');

  const parts = [
    ['c-passed', 'Passed', p.passed], ['c-failed', 'Failed', p.failed], ['c-inc', 'INC', p.inc],
    ['c-progress', 'In progress', p.inProgress], ['c-idle', 'Not started', p.notStarted],
  ].filter(x => x[2] > 0);
  $('blocksLegend').innerHTML = parts.map(([c, label, n]) => `<span><i class="${c}"></i>${label} ${n}</span>`).join('');
}

function renderTiles() {
  const p = state.progress, a = state.attendance;
  const attention = p.failed + p.inc;
  $('stats').innerHTML = `
    <div class="tile"><span>Active subjects</span><strong>${state.subjects.filter(s => s.is_active).length}</strong></div>
    <div class="tile"><span>Passed</span><strong>${p.passed}</strong></div>
    <div class="tile ${attention ? 'alert' : ''}"><span>Needs attention</span><strong>${attention}</strong>
      <small>${p.failed} failed, ${p.inc} INC</small></div>
    <div class="tile ${a.remaining <= 5 ? 'alert' : ''}"><span>Total absences</span><strong>${a.absent}</strong>
      <small>Limit is ${a.limit} per year</small></div>`;
}

function termChip(n, s) {
  const st = s.term_status[n], g = s[`term${n}`];
  let text = '—', cls = '';
  if (st === 'passed' || st === 'failed') { text = g ?? (st === 'passed' ? 'Passed' : 'Failed'); cls = st; }
  else if (st === 'inc')                  { text = 'INC'; cls = 'inc'; }
  else if (st === 'in-progress')          { text = 'Ongoing'; cls = 'ongoing'; }
  return `<div class="term ${cls}"><span>Term ${n}</span><strong>${text}</strong></div>`;
}

function renderSubjects() {
  const active = state.subjects.filter(s => s.is_active);
  const past = state.subjects.filter(s => !s.is_active);

  $('activeCount').textContent = active.length ? plural(active.length, 'subject') : '';
  $('activeSubjects').innerHTML = active.map(s => {
    const hint = subjectHint(s);
    return `
      <article class="subj" tabindex="0" role="button" data-id="${s.subject_id}" aria-label="Open ${escapeHtml(s.subject)} details">
        <div class="subj-top"><h4>${escapeHtml(s.subject)}</h4>${statusPill(s.status)}</div>
        <p class="teacher">${escapeHtml(s.teacher)}</p>
        <div class="terms">${[1, 2, 3].map(n => termChip(n, s)).join('')}</div>
        ${hint ? `<p class="hint ${hint.cls}">${escapeHtml(hint.text)}</p>` : ''}
      </article>`;
  }).join('') || '<div class="card empty" style="grid-column: 1 / -1;">No active subjects. Finished subjects are listed under Past subjects.</div>';

  $('pastCount').textContent = past.length;
  $('pastSubjectsBody').innerHTML = past.map(s => `
    <tr class="clickable-row" tabindex="0" data-id="${s.subject_id}">
      <td><strong>${escapeHtml(s.subject)}</strong></td>
      <td>${escapeHtml(s.teacher)}</td>
      <td>${s.grade_level != null ? 'Grade ' + escapeHtml(s.grade_level) : '—'}</td>
      <td style="font-weight:bold;">${s.term_grade ?? '—'}</td>
      <td>${statusPill(s.status)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">No past subjects yet.</td></tr>';
}

// ---- Attendance ----
function attInfo() {
  const a = state.attendance;
  const pct = Math.min((a.absent / a.limit) * 100, 100);
  const color = pct > 75 ? 'var(--danger)' : pct > 50 ? 'var(--warning)' : 'var(--success)';
  return { a, pct, color };
}

function attMessage(a) {
  if (a.absent === 0)   return 'No absences recorded so far.';
  if (a.remaining <= 0) return 'You reached the 20-absence limit. Talk to your adviser right away.';
  if (a.remaining <= 5) return 'You are close to the 20-absence limit. Avoid missing more classes.';
  if (a.remaining <= 10) return 'Your absences are adding up. The limit is 20 per school year.';
  return 'The limit is 20 absences per school year.';
}

function renderAttendance() {
  const { a, pct, color } = attInfo();

  $('attSnapshot').innerHTML = `
    <div class="snap-line"><strong>${plural(a.absent, 'total absence')}</strong><span>${a.rate != null ? a.rate + '% attendance' : ''}</span></div>
    ${meter(pct, color)}
    <p class="att-note">${escapeHtml(attMessage(a))}</p>`;

  $('attStats').innerHTML = `
    <div class="tile"><span>Attendance rate</span><strong>${a.rate != null ? a.rate + '%' : '—'}</strong></div>
    <div class="tile"><span>Days present</span><strong>${a.present}</strong></div>
    <div class="tile ${a.absent > 4 ? 'alert' : ''}"><span>Total absences</span><strong>${a.absent}</strong></div>
    <div class="tile"><span>Days late</span><strong>${a.late}</strong>
      <small>${a.converted ? plural(a.converted, 'absence') + ' from lates' : 'None converted'}</small></div>
    <div class="tile"><span>Excused</span><strong>${a.excused}</strong></div>`;

  $('attMeter').innerHTML = meter(pct, color);
  $('attMessage').textContent = `${plural(a.absent, 'total absence')}. ${attMessage(a)}`;
}

// ---- Notifications ----
const NOTIF_ICON = { warning: '⚠️', error: '🚨' };

function notifItem(n, unread, kind) {
  const when = n.created_at ? new Date(n.created_at).toLocaleString() : 'Current';
  return `
    <div class="notif-preview ${unread ? 'unread' : ''}" data-kind="${kind}" data-nid="${escapeHtml(n.id)}">
      <div class="notif-icon">${NOTIF_ICON[n.type] || '📢'}</div>
      <div style="flex:1; min-width:0;">
        <div class="notif-head"><strong>${escapeHtml(n.title)}</strong><span class="notif-when">${escapeHtml(when)}</span></div>
        <div class="notif-body">${escapeHtml(n.body || '')}</div>
      </div>
    </div>`;
}

function renderPreview() {
  const seen = loadSeen();
  const items = [
    ...state.alerts.map(a => notifItem(a, seen[a.id] !== a.sig, 'alert')),
    ...state.messages.map(m => notifItem(m, !m.is_read, 'msg')),
  ].slice(0, 3);
  $('notifPreview').innerHTML = items.join('') || '<p class="empty">No notifications yet.</p>';
}

function renderNotifs() {
  const seen = loadSeen();
  const alerts = state.alerts.map(a => notifItem(a, seen[a.id] !== a.sig, 'alert')).join('');
  const msgs = state.messages.map(m => notifItem(m, !m.is_read, 'msg')).join('');
  $('notifsList').innerHTML =
    (alerts ? `<h4 class="list-title">Needs your attention</h4>${alerts}` : '') +
    (msgs ? `<h4 class="list-title">Messages</h4>${msgs}` : '') ||
    '<p class="empty">No notifications yet.</p>';
  watchUnread();
}

// ---- A notification counts as seen once it has been on screen, or when it is clicked ----
const pendingReads = new Set();
let flushTimer = null;

function flushReads() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    const ids = [...pendingReads];
    pendingReads.clear();
    if (!ids.length) return;
    try { await apiFetch('/student/notifications/read', { method: 'POST', body: JSON.stringify({ ids }) }); }
    catch (err) { console.error('Could not mark notifications as read:', err); }
  }, 500);
}

function markSeen(el) {
  if (!el.classList.contains('unread')) return;
  el.classList.remove('unread');
  clearTimeout(el._seenTimer);

  const id = el.dataset.nid;
  if (el.dataset.kind === 'alert') {
    const a = state.alerts.find(x => x.id === id);
    if (a) { const seen = loadSeen(); seen[a.id] = a.sig; saveSeen(seen); }
  } else {
    const m = state.messages.find(x => String(x.id) === id);
    if (m && !m.is_read) { m.is_read = true; pendingReads.add(m.id); flushReads(); }
  }
  state.lastBadge = updateBadge();
  renderPreview();
}

const seenObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target._seenTimer = setTimeout(() => { markSeen(e.target); seenObserver.unobserve(e.target); }, 700);
        } else {
          clearTimeout(e.target._seenTimer);
        }
      }
    }, { threshold: 0.6 })
  : null;

function watchUnread() {
  if (seenObserver) seenObserver.disconnect();
  $('notifsList').querySelectorAll('.notif-preview.unread')
    .forEach(el => (seenObserver ? seenObserver.observe(el) : markSeen(el)));
}

$('notifsList').addEventListener('click', e => {
  const el = e.target.closest('.notif-preview');
  if (el) markSeen(el);
});

function markAllRead() {
  $('notifsList').querySelectorAll('.notif-preview.unread').forEach(markSeen);
}

// One short toast, only when there is something new
function announce() {
  const n = updateBadge();
  const grew = state.lastBadge !== null && n > state.lastBadge;
  let shown = false;
  try { shown = sessionStorage.getItem('rnhs_toast_shown') === '1'; } catch { /* ignore */ }

  if (n > 0 && state.view !== 'notifs' && (!shown || grew)) {
    try { sessionStorage.setItem('rnhs_toast_shown', '1'); } catch { /* ignore */ }
    showToast(
      { title: `You have ${plural(n, 'new notification')}`, body: 'Click to read them.' },
      state.alerts.some(a => a.type === 'error') ? 'error' : 'warning',
      () => showView('notifs')
    );
  }
  state.lastBadge = n;
}

// ---- Subject modal ----
async function openSubjectModal(subjectId, trigger) {
  const s = state.subjects.find(x => x.subject_id === subjectId);
  lastFocus = trigger || document.activeElement;
  $('modalSubjectTitle').textContent = s ? s.subject : 'Subject details';
  $('modalContent').innerHTML = '<p class="empty">Loading details…</p>';
  $('subjectDetailModal').style.display = 'flex';
  $('modalClose').focus();

  let head = '';
  if (s) {
    const hint = subjectHint(s);
    head = `<div class="modal-summary">
        ${statusPill(s.status)}
        ${s.term_grade != null ? `<span>${s.is_final ? 'Final grade' : 'Average so far'}: <strong>${s.term_grade}</strong></span>` : ''}
        <span>${escapeHtml(s.teacher)}</span>
      </div>
      ${hint ? `<p class="hint ${hint.cls}" style="margin: 0 0 14px;">${escapeHtml(hint.text)}</p>` : ''}`;
  }

  try {
    const grades = await apiFetch(`/student/subjects/${subjectId}/details`);
    const descColor = {
      Advancing: 'green', Benchmarking: '#1e3a8a', Connecting: '#0369a1', Developing: '#b45309', Emerging: 'red',
    };
    const qualColor = { 'Passed': '#166534', 'Failed': '#991b1b', 'INC / Not Submitted': '#92400e', 'In Progress': '#1e3a8a' };

    const formatGroup = (g, prefix) => {
      if (!g.activities) return '—';
      return g.activities.filter(a => a.field.startsWith(prefix)).map(a => {
        if (a.score !== null && a.score !== undefined) {
          return `<div><strong style="color:var(--primary);">${a.score}</strong> <span style="color:#374151; font-size:12px; font-weight:600;">/ ${a.hps}</span></div>`;
        }
        return a.hps > 0 ? `<div style="color:${s && s.finished_by_teacher ? '#6b7280' : '#92400e'}; font-size:12px; font-weight:600;">— / ${a.hps}</div>` : null;
      }).filter(Boolean).join('') || '—';
    };

    const rows = grades.map(g => {
      const done = g.qualitative === 'Passed' || g.qualitative === 'Failed';
      const qual = g.qualitative === 'INC / Not Submitted' ? 'INC' : g.qualitative;
      return `<tr>
        <td style="font-weight:bold; background:#f9fafb;">${g.term}</td>
        <td class="bg-ww">${formatGroup(g, 'ww')}</td>
        <td class="bg-pt">${formatGroup(g, 'pt')}</td>
        <td class="bg-ex">${formatGroup(g, 'ex')}</td>
        <td style="font-weight:bold; font-size:16px; background:#f9fafb;">
          ${done && g.term_grade != null ? g.term_grade : '—'}<br>
          <span style="font-size:11px; color:${descColor[g.descriptor] || 'inherit'}; font-weight:600;">${done ? escapeHtml(g.descriptor || '') : ''}</span>
        </td>
        <td style="background:#f9fafb; font-weight:700; color:${qualColor[g.qualitative] || 'inherit'};">${escapeHtml(qual)}</td>
      </tr>`;
    }).join('');

    $('modalContent').innerHTML = `${head}
      <div style="overflow-x:auto;">
        <table class="breakdown-table" style="width:100%; border-collapse:collapse;">
          <thead><tr>
            <th style="width:60px;">Term</th>
            <th class="bg-ww">Written / oral works</th>
            <th class="bg-pt">Product / performance tasks</th>
            <th class="bg-ex">Examinations</th>
            <th style="width:90px;">Term grade</th>
            <th style="width:100px;">Status</th>
          </tr></thead><tbody>${rows}</tbody>
        </table>
      </div>
      <p class="modal-note">Scores are shown as <strong>your score</strong> / highest possible score. ${s && s.finished_by_teacher ? 'A dash means no score was recorded.' : 'An orange “— /” means the item is not submitted yet.'}</p>`;
  } catch (err) {
    $('modalContent').innerHTML = `${head}<p class="empty" style="color:var(--danger);">Could not load details: ${escapeHtml(err.message)}</p>`;
  }
}

function closeSubjectModal() {
  $('subjectDetailModal').style.display = 'none';
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('subjectDetailModal').style.display === 'flex') closeSubjectModal();
});
$('subjectDetailModal').addEventListener('click', e => { if (e.target.id === 'subjectDetailModal') closeSubjectModal(); });

// Open a subject (or jump to a view) from cards, table rows and suggestions
function activate(e) {
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest('[data-id], [data-view]');
  if (!el) return;
  if (e.type === 'keydown') e.preventDefault();
  if (el.dataset.id) openSubjectModal(Number(el.dataset.id), el);
  else if (el.dataset.view) showView(el.dataset.view);
}
['activeSubjects', 'pastSubjectsBody', 'focusList'].forEach(id => {
  $(id).addEventListener('click', activate);
  $(id).addEventListener('keydown', activate);
});

// ---- Load everything in one request ----
function renderAll() {
  state.suggestions = buildSuggestions();
  renderHero();
  renderTiles();
  renderFocus();
  renderSubjects();
  renderAttendance();
  renderPreview();
  if (state.view === 'notifs') renderNotifs();
  announce();
}

function showLoadError(err) {
  const msg = `<div class="card empty" style="grid-column: 1 / -1;">
      Could not load your records: ${escapeHtml(err.message)}<br>
      <button class="btn btn-small" style="margin-top:10px;" onclick="loadAll()">Try again</button></div>`;
  $('activeSubjects').innerHTML = msg;
  $('heroLine').textContent = 'We could not load your records.';
}

async function loadAll({ silent = false } = {}) {
  if (!silent) $('loadingOverlay').style.display = 'flex';
  try {
    const d = await apiFetch('/student/overview');
    state.subjects = d.subjects;
    state.progress = d.progress;
    state.attendance = d.attendance;
    state.alerts = d.notifications.alerts;
    state.messages = d.notifications.messages;
    state.lastLoad = Date.now();
    renderAll();
  } catch (err) {
    console.error('Failed to load dashboard:', err);
    if (!silent) showLoadError(err);
  } finally {
    $('loadingOverlay').style.display = 'none';
  }
}

// Keep the page fresh while the student has it open
setInterval(() => { if (!document.hidden) loadAll({ silent: true }); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.lastLoad && Date.now() - state.lastLoad > STALE_MS) loadAll({ silent: true });
});

// Boot
const startView = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
history.replaceState({ view: startView }, '', '#' + startView);
showView(startView, { push: false });
loadAll();