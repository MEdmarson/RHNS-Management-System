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
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
$('welcomeName').textContent = `${greeting()}, ${firstName(user.name)}!`;

const VIEWS = { dashboard: 'Dashboard', subjects: 'My Subjects', attendance: 'My Attendance', notifs: 'Alerts & Notifications' };
const REFRESH_MS = 120000;   // background refresh while the tab is visible
const STALE_MS = 60000;      // refresh when switching views if data is older than this

const state = {
  subjects: [], progress: null, attendance: null,
  alerts: [], messages: [],
  view: 'dashboard', lastLoad: 0, lastBadge: null,
  subjectFilter: 'active', query: '', notifFilter: 'all',
};
let lastFocus = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const TERM_IDS = [1, 2, 3];

function relTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${plural(mins, 'minute')} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${plural(hrs, 'hour')} ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${plural(days, 'day')} ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

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

// ---------------------------------------------------------------------------
// Seen-state for live alerts (kept in this browser)
// ---------------------------------------------------------------------------
const SEEN_KEY = `rnhs_seen_alerts_${user.id ?? user.name}`;
function loadSeen() { try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch { return {}; } }
function saveSeen(o) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(o)); } catch { /* storage unavailable */ } }
const alertUnread = (a, seen = loadSeen()) => seen[a.id] !== a.sig;

function unreadTotal() {
  const seen = loadSeen();
  return state.alerts.filter(a => alertUnread(a, seen)).length + state.messages.filter(m => !m.is_read).length;
}
function updateBadge() {
  const n = unreadTotal();
  const badge = $('notifBadge');
  badge.textContent = n > 9 ? '9+' : n;
  badge.style.display = n > 0 ? 'inline-block' : 'none';
  return n;
}

// Ask before logging out (used by the sidebar and mobile logout buttons)
function confirmLogout() {
  if (confirm('Log out of the Student Portal?')) logout();
}

// ---------------------------------------------------------------------------
// Navigation: every summary on the dashboard jumps to a tab via go()
// ---------------------------------------------------------------------------
function showView(name, { push = true } = {}) {
  if (!VIEWS[name]) name = 'dashboard';
  state.view = name;

  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  $(`view-${name}`).style.display = 'block';
  document.querySelectorAll('.nav-item[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  $('pageTitle').textContent = VIEWS[name];

  if (push && history.state?.view !== name) history.pushState({ view: name }, '', '#' + name);

  if (name === 'subjects') renderSubjectsTab();
  if (name === 'notifs') renderNotifs();
  if (name === 'attendance' && state.attendance) renderAttendance();
  const main = document.querySelector('.main');
  if (main) main.scrollTo({ top: 0 });
  window.scrollTo({ top: 0 });

  if (state.lastLoad && Date.now() - state.lastLoad > STALE_MS) loadAll({ silent: true });
}

function go(view, { filter } = {}) {
  if (view === 'subjects' && filter && SUBJECT_FILTERS[filter]) state.subjectFilter = filter;
  if (view === 'notifs' && filter && NOTIF_FILTERS[filter]) state.notifFilter = filter;
  showView(view);
}

window.addEventListener('popstate', e => showView(e.state?.view || location.hash.slice(1), { push: false }));

// ---------------------------------------------------------------------------
// Subject hints and filters
// ---------------------------------------------------------------------------
function subjectHint(s) {
  const incTerm = TERM_IDS.find(n => s.term_status[n] === 'inc');
  if (incTerm) {
    return { cls: 'bad', text: s.finished_by_teacher
      ? `INC in Term ${incTerm}. This subject is finished, so approach ${s.teacher} to ask how to clear it.`
      : `INC in Term ${incTerm}. Submit the missing requirements to your teacher.` };
  }
  const missedTerm = TERM_IDS.find(n => (s.term_missed?.[n] || []).length);
  if (missedTerm) {
    return { cls: 'bad', text: `Missed ${s.term_missed[missedTerm].join(', ')} in Term ${missedTerm}. Submit it or ask ${s.teacher} about a make-up.` };
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

const needsAttention = s =>
  s.has_inc || s.status === 'Failed' ||
  TERM_IDS.some(n => s.term_status[n] === 'failed' || (s.term_missed?.[n] || []).length) || s.target?.state === 'out_of_reach';

// Order here is the order of the chips: current subjects first, "All" last
const SUBJECT_FILTERS = {
  active:    { label: 'Current',         fn: s => s.is_active },
  passed:    { label: 'Passed',          fn: s => s.status === 'Passed' },
  attention: { label: 'Needs attention', fn: needsAttention },
  past:      { label: 'Past',            fn: s => !s.is_active },
  all:       { label: 'All',             fn: () => true },
};

// A grade only counts once all 3 terms are graded, there is no INC, and the subject is final
const hasFinalGrade = s => s.is_final && !s.has_inc && s.graded_count === TERM_IDS.length && s.term_grade != null;

function priority(s) {
  if (s.has_inc) return 4;
  if (s.status === 'Failed' || s.target?.state === 'out_of_reach') return 3;
  if (TERM_IDS.some(n => s.term_status[n] === 'failed')) return 3;
  if (TERM_IDS.some(n => (s.term_missed?.[n] || []).length)) return 2;
  if (s.target?.state === 'reachable') return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Alerts: the server supplies details (subject, terms, items, action); older
// responses without those fields still work through these fallbacks.
// ---------------------------------------------------------------------------
const SEV_LABEL = { error: 'Urgent', warning: 'Soon', info: 'Tip', good: 'Good news' };
const sevOf = a => (a.type === 'error' || a.type === 'warning') ? a.type : 'info';

function alertAction(n) {
  if (n.action) return n.action;
  if (n.subject_id) return { label: 'View subject', view: 'subjects', subject_id: n.subject_id };
  if (String(n.id).startsWith('att')) return { label: 'View attendance', view: 'attendance' };
  return null;
}
function actionAttrs(a) {
  if (!a) return '';
  return a.subject_id ? `data-open="${a.subject_id}"` : `data-go="${escapeHtml(a.view || 'dashboard')}"`;
}

// ---------------------------------------------------------------------------
// Dashboard renderers
// ---------------------------------------------------------------------------
function renderHero() {
  const p = state.progress;
  const urgent = state.alerts.filter(a => a.type === 'error' || a.type === 'warning').length;

  $('promotionStatus').textContent = p.promotionStatus;
  $('heroLine').textContent = !p.total
    ? 'No subjects are assigned to your section yet.'
    : `${p.completed} of ${p.total} subjects completed. ` +
      (urgent ? `${plural(urgent, 'item')} need${urgent === 1 ? 's' : ''} your attention.` : 'Nothing urgent right now.');

  const cls = { 'Passed': 'c-passed', 'Failed': 'c-failed', 'INC / Not Submitted': 'c-inc', 'In Progress': 'c-progress' };
  $('subjectBlocks').innerHTML = state.subjects.map(s =>
    `<button type="button" class="block ${cls[s.status] || ''}" data-open="${s.subject_id}"
             title="${escapeHtml(s.subject)}: ${escapeHtml(s.status)}"
             aria-label="${escapeHtml(s.subject)}: ${escapeHtml(s.status)}"></button>`).join('');

  const parts = [
    ['c-passed', 'Passed', p.passed], ['c-failed', 'Failed', p.failed], ['c-inc', 'INC', p.inc],
    ['c-progress', 'In progress', p.inProgress], ['c-idle', 'Not started', p.notStarted],
  ].filter(x => x[2] > 0);
  $('blocksLegend').innerHTML = parts.map(([c, label, n]) => `<span><i class="${c}"></i>${label} ${n}</span>`).join('');
}

function renderTiles() {
  const p = state.progress, a = state.attendance;
  const attention = p.failed + p.inc;
  const graded = state.subjects.filter(hasFinalGrade);
  const avg = graded.length ? Math.round(graded.reduce((t, s) => t + s.term_grade, 0) / graded.length) : null;
  const unread = unreadTotal();

  $('stats').innerHTML = `
    <button class="tile" data-go="subjects" data-filter="active"><span class="go">→</span>
      <span>Active subjects</span><strong>${state.subjects.filter(s => s.is_active).length}</strong>
      <small>Tap to view</small></button>
    <button class="tile ${avg != null && avg < 75 ? 'alert' : avg != null ? 'good' : ''}" data-go="subjects" data-filter="${graded.length ? 'past' : 'active'}"><span class="go">→</span>
      <span>Final average</span><strong>${avg ?? '—'}</strong>
      <small>${avg != null ? `Across ${plural(graded.length, 'completed subject')}` : 'Shows once a subject has a final grade'}</small></button>
    <button class="tile ${attention ? 'alert' : ''}" data-go="subjects" data-filter="${attention ? 'attention' : 'passed'}"><span class="go">→</span>
      <span>Needs attention</span><strong>${attention}</strong>
      <small>${p.failed} failed, ${p.inc} INC</small></button>
    <button class="tile ${a.absent >= (a.warn_at ?? 10) ? 'alert' : ''}" data-go="attendance"><span class="go">→</span>
      <span>Total absences</span><strong>${a.absent}</strong>
      <small>${a.absent === 0 ? 'None so far. Keep it up!' : 'Tap for details'}</small></button>
    <button class="tile ${unread ? 'alert' : ''}" data-go="notifs" data-filter="${unread ? 'unread' : 'all'}"><span class="go">→</span>
      <span>New alerts</span><strong>${unread}</strong>
      <small>${unread ? 'Tap to read' : 'All caught up'}</small></button>`;
}

function renderFocus() {
  const seen = loadSeen();
  const top = state.alerts.slice(0, 3);
  const extra = state.alerts.length - top.length;
  $('focusMore').innerHTML = extra > 0
    ? `<a href="#notifs" data-go="notifs" data-filter="attention" style="color:var(--primary);font-weight:700;">+${extra} more →</a>` : '';

  if (!top.length) {
    const p = state.progress;
    const done = p?.total && p.completed === p.total;
    $('focusList').innerHTML = `<li class="focus-item sev-good"><span class="sev-tag">${SEV_LABEL.good}</span>
      <div><b>${done ? 'All subjects completed' : 'You are on track'}</b>
      <p>${done ? 'You have finished every subject. Check your promotion status above.' : 'Nothing needs your attention right now. Keep submitting your activities on time.'}</p></div></li>`;
    return;
  }

  $('focusList').innerHTML = top.map(a => {
    const sev = sevOf(a);
    const act = alertAction(a);
    return `<li class="focus-item sev-${sev}" ${act ? `tabindex="0" role="button" ${actionAttrs(act)}` : ''}>
      <span class="sev-tag">${SEV_LABEL[sev]}</span>
      <div><b>${alertUnread(a, seen) ? '<i class="new-dot" title="New"></i>' : ''}${escapeHtml(a.title)}</b><p>${escapeHtml(a.body)}</p></div>
      ${act ? '<span class="focus-arrow">→</span>' : ''}
    </li>`;
  }).join('');
}

function miniTerm(n, s) {
  const st = s.term_status[n], g = s[`term${n}`];
  let text = '—', cls = '';
  if (st === 'passed' || st === 'failed') { text = g ?? (st === 'passed' ? '✓' : '✗'); cls = st; }
  else if (st === 'inc') { text = 'INC'; cls = 'inc'; }
  else if (st === 'in-progress') { text = '…'; cls = 'ongoing'; }
  return `<span class="mt ${cls}" title="Term ${n}">T${n} ${text}</span>`;
}

function renderGlance() {
  const list = [...state.subjects]
    .sort((a, b) => priority(b) - priority(a) || Number(b.is_active) - Number(a.is_active))
    .slice(0, 4);
  $('activeCount').textContent = state.subjects.length ? `Showing ${list.length} of ${state.subjects.length}` : '';
  $('glanceList').innerHTML = list.map(s => `
    <div class="row-subj" tabindex="0" role="button" data-open="${s.subject_id}" aria-label="Open ${escapeHtml(s.subject)} details">
      <div class="row-main"><b>${escapeHtml(s.subject)}</b><small>${escapeHtml(s.teacher)}</small></div>
      <div class="mini-terms">${TERM_IDS.map(n => miniTerm(n, s)).join('')}</div>
      ${statusPill(s.status)}
    </div>`).join('') || '<div class="empty">No subjects yet. They will appear here once your teachers add them.</div>';
}

// ---------------------------------------------------------------------------
// Subjects tab
// ---------------------------------------------------------------------------
function termChip(n, s) {
  const st = s.term_status[n], g = s[`term${n}`];
  let text = '—', cls = '';
  if (st === 'passed' || st === 'failed') { text = g ?? (st === 'passed' ? 'Passed' : 'Failed'); cls = st; }
  else if (st === 'inc')                  { text = 'INC'; cls = 'inc'; }
  else if (st === 'in-progress')          { text = 'Ongoing'; cls = 'ongoing'; }
  return `<div class="term ${cls}"><span>Term ${n}</span><strong>${text}</strong></div>`;
}

function subjectCard(s) {
  const hint = subjectHint(s);
  const avg = hasFinalGrade(s)
    ? `Final grade: <strong>${s.term_grade}</strong>`
    : s.has_inc ? 'Final grade held by INC' : 'Final grade not yet available';
  return `
    <article class="subj" tabindex="0" role="button" data-open="${s.subject_id}" aria-label="Open ${escapeHtml(s.subject)} details">
      <div class="subj-top"><h4>${escapeHtml(s.subject)}</h4>${statusPill(s.status)}</div>
      <p class="teacher">${escapeHtml(s.teacher)}${s.grade_level != null ? ' · Grade ' + escapeHtml(s.grade_level) : ''}${s.is_active ? '' : ' · Past'}</p>
      <div class="terms">${TERM_IDS.map(n => termChip(n, s)).join('')}</div>
      ${hint ? `<p class="hint ${hint.cls}">${escapeHtml(hint.text)}</p>` : ''}
      <div class="subj-foot"><span>${avg}</span><span class="more">Details →</span></div>
    </article>`;
}

function renderSubjectsTab() {
  const q = state.query.trim().toLowerCase();
  $('subjChips').innerHTML = Object.entries(SUBJECT_FILTERS).map(([key, f]) => {
    const n = state.subjects.filter(f.fn).length;
    return `<button type="button" class="chip ${state.subjectFilter === key ? 'active' : ''}" data-sfilter="${key}">${f.label}<span class="n">${n}</span></button>`;
  }).join('');

  const list = state.subjects
    .filter(SUBJECT_FILTERS[state.subjectFilter].fn)
    .filter(s => !q || s.subject.toLowerCase().includes(q) || (s.teacher || '').toLowerCase().includes(q))
    .sort((a, b) => priority(b) - priority(a));

  $('subjectsGrid').innerHTML = list.map(subjectCard).join('') ||
    `<div class="card empty" style="grid-column: 1 / -1;">${
      state.subjects.length ? 'No subjects match this filter.' : 'No subjects are assigned to your section yet.'}</div>`;
}

$('subjSearch').addEventListener('input', e => { state.query = e.target.value; renderSubjectsTab(); });

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------
function attInfo() {
  const a = state.attendance;
  // The bar shows the attendance rate, so no absence limit is shown to students
  const pct = a.rate != null ? a.rate : 0;
  const color = pct >= 90 ? 'var(--success)' : pct >= 80 ? 'var(--warning)' : 'var(--danger)';
  return { a, pct, color };
}
function attMessage(a) {
  if (a.absent === 0)   return 'No absences recorded so far. Keep it up!';
  if (a.absent >= (a.urgent_at ?? 15)) return 'Your absences are very high. Talk to your adviser right away.';
  if (a.absent >= (a.warn_at ?? 10))   return 'Your absences are adding up. Try to attend every class.';
  return 'Try to attend every class and arrive on time.';
}

function renderAttendance() {
  const { a, pct, color } = attInfo();

  $('attSnapshot').innerHTML = `
    <div class="snap-line"><strong>${plural(a.absent, 'absence')}</strong><span>${a.rate != null ? a.rate + '% attendance' : ''}</span></div>
    ${meter(pct, color)}
    <p class="att-note">${escapeHtml(attMessage(a))}</p>`;

  $('attStats').innerHTML = `
    <div class="tile"><span>Attendance rate</span><strong>${a.rate != null ? a.rate + '%' : '—'}</strong></div>
    <div class="tile"><span>Days present</span><strong>${a.present}</strong></div>
    <div class="tile ${a.absent >= (a.warn_at ?? 10) ? 'alert' : ''}"><span>Total absences</span><strong>${a.absent}</strong>
      <small>${a.converted ? `Includes ${plural(a.converted, 'absence')} from lates` : `Every ${a.lates_per_absence ?? 3} lates = 1 absence`}</small></div>
    <div class="tile"><span>Days late</span><strong>${a.late}</strong>
      <small>${a.converted ? plural(a.converted, 'absence') + ' from lates' : 'None converted'}</small></div>
    <div class="tile"><span>Excused</span><strong>${a.excused}</strong><small>Not counted as absent</small></div>`;

  if (a.school_year) {
    const fmt = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    $('attYear').textContent = `School Year ${a.school_year.label} · ${fmt(a.school_year.start)} to ${fmt(a.school_year.end)}`;
  }

  $('attMeter').innerHTML = meter(pct, color);
  $('attMessage').textContent = a.absent === 0 ? attMessage(a) : `${plural(a.absent, 'absence')} recorded. ${attMessage(a)}`;

  const marked = Math.max(a.absent - a.converted, 0);
  const per = a.lates_per_absence ?? 3;
  const toNext = per - (a.late % per);
  $('attBreakdown').innerHTML = `
    <li><span>Marked absent</span><span>${marked}</span></li>
    <li><span>From lates<small>${a.late} late${a.late === 1 ? '' : 's'} ÷ ${per}</small></span><span>+ ${a.converted}</span></li>
    <li><span>Excused<small>Not counted</small></span><span>${a.excused}</span></li>
    <li><span>Total absences</span><span>${a.absent}</span></li>`;
  if (a.late > 0) {
    $('attMessage').textContent += ` ${toNext === 1 ? 'One more late' : plural(toNext, 'more late')} will count as another absence.`;
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
const NOTIF_ICON = { error: '🚨', warning: '⚠️', info: '💡' };

const NOTIF_FILTERS = {
  all:       { label: 'All' },
  unread:    { label: 'Unread' },
  attention: { label: 'Needs attention' },
  tips:      { label: 'Tips' },
  messages:  { label: 'Messages' },
};

function notifItem(n, unread, kind) {
  const isAlert = kind === 'alert';
  const sev = isAlert ? sevOf(n) : 'message';
  const when = n.created_at ? relTime(n.created_at) : 'Right now';
  const label = isAlert ? SEV_LABEL[sev] : 'Message';

  const chips = [];
  if (n.subject) chips.push(`<span class="nchip">📚 ${escapeHtml(n.subject)}</span>`);
  const terms = n.terms || (n.term ? [n.term] : []);
  if (terms.length) chips.push(`<span class="nchip">${terms.length > 1 ? 'Terms' : 'Term'} ${escapeHtml(terms.join(', '))}</span>`);
  (n.items || []).forEach(i => chips.push(`<span class="nchip miss">${escapeHtml(i)}</span>`));
  const facts = (n.facts || []).map(f => `<li>${escapeHtml(f)}</li>`).join('');

  const act = isAlert ? alertAction(n) : null;

  return `
    <div class="notif-preview t-${sev} ${unread ? 'unread' : ''}" data-kind="${kind}" data-nid="${escapeHtml(n.id)}">
      <div class="notif-icon">${isAlert ? (NOTIF_ICON[sev] || '📢') : '📢'}</div>
      <div style="flex:1; min-width:0;">
        <div class="notif-head">
          <strong>${unread ? '<i class="new-dot" title="New"></i>' : ''}${escapeHtml(n.title)}</strong>
          <span class="notif-when">${escapeHtml(label)} · ${escapeHtml(when)}</span>
        </div>
        <div class="notif-body">${escapeHtml(n.body || '')}</div>
        ${chips.length ? `<div class="nmeta">${chips.join('')}</div>` : ''}
        ${facts ? `<ul class="nfacts">${facts}</ul>` : ''}
        ${act ? `<div class="naction"><button type="button" class="btn btn-small btn-secondary" ${actionAttrs(act)}>${escapeHtml(act.label || 'View details')} →</button></div>` : ''}
      </div>
    </div>`;
}

function notifGroups() {
  const seen = loadSeen();
  const f = state.notifFilter;
  const attn = state.alerts.filter(a => a.type === 'error' || a.type === 'warning');
  const tips = state.alerts.filter(a => a.type !== 'error' && a.type !== 'warning');
  const msgs = state.messages;

  const A = list => list.map(a => notifItem(a, alertUnread(a, seen), 'alert')).join('');
  const M = list => list.map(m => notifItem(m, !m.is_read, 'msg')).join('');

  if (f === 'unread') {
    return [
      ['Needs your attention', A(attn.filter(a => alertUnread(a, seen)))],
      ['Tips', A(tips.filter(a => alertUnread(a, seen)))],
      ['Messages from school', M(msgs.filter(m => !m.is_read))],
    ];
  }
  if (f === 'attention') return [['Needs your attention', A(attn)]];
  if (f === 'tips')      return [['Tips', A(tips)]];
  if (f === 'messages')  return [['Messages from school', M(msgs)]];
  return [['Needs your attention', A(attn)], ['Tips', A(tips)], ['Messages from school', M(msgs)]];
}

function renderNotifs() {
  const seen = loadSeen();
  const counts = {
    all: state.alerts.length + state.messages.length,
    unread: unreadTotal(),
    attention: state.alerts.filter(a => a.type === 'error' || a.type === 'warning').length,
    tips: state.alerts.filter(a => a.type !== 'error' && a.type !== 'warning').length,
    messages: state.messages.length,
  };
  $('notifChips').innerHTML = Object.entries(NOTIF_FILTERS).map(([k, f]) =>
    `<button type="button" class="chip ${state.notifFilter === k ? 'active' : ''}" data-nfilter="${k}">${f.label}<span class="n">${counts[k]}</span></button>`).join('');

  const html = notifGroups().filter(([, items]) => items).map(([t, items]) => `<h4 class="list-title">${t}</h4>${items}`).join('');
  $('notifsList').innerHTML = html ||
    `<p class="empty">${state.notifFilter === 'unread' ? '🎉 You are all caught up. No unread alerts.' : 'Nothing here yet. We will let you know when something needs your attention.'}</p>`;
  watchUnread();
}

function renderPreview() {
  const seen = loadSeen();
  const rows = [
    ...state.alerts.map(a => ({ n: a, kind: 'alert', unread: alertUnread(a, seen) })),
    ...state.messages.map(m => ({ n: m, kind: 'msg', unread: !m.is_read })),
  ].slice(0, 3);

  $('notifPreview').innerHTML = rows.map(({ n, kind, unread }) => {
    const sev = kind === 'alert' ? sevOf(n) : 'message';
    return `<div class="notif-preview t-${sev} ${unread ? 'unread' : ''}" tabindex="0" role="button" data-go="notifs" data-filter="all">
      <div class="notif-icon">${kind === 'alert' ? (NOTIF_ICON[sev] || '📢') : '📢'}</div>
      <div style="flex:1; min-width:0;">
        <div class="notif-head"><strong>${unread ? '<i class="new-dot"></i>' : ''}${escapeHtml(n.title)}</strong></div>
        <div class="notif-when">${escapeHtml(n.created_at ? relTime(n.created_at) : 'Right now')}</div>
      </div></div>`;
  }).join('') || '<p class="empty">No alerts yet. 🎉</p>';
}

// A notification counts as seen once it has been on screen, or when it is clicked
const pendingReads = new Set();
let flushTimer = null;

function flushReads() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    const ids = [...pendingReads];
    pendingReads.clear();
    if (!ids.length) return;
    try { await apiFetch('/student/notifications/read', { method: 'POST', body: JSON.stringify({ ids }), silent: true }); }   // background: no overlay
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
  renderTiles();
  renderFocus();
}

const seenObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target._seenTimer = setTimeout(() => { markSeen(e.target); seenObserver.unobserve(e.target); }, 1500);
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
  // Mark everything, not only what is on screen
  const seen = loadSeen();
  state.alerts.forEach(a => { seen[a.id] = a.sig; });
  saveSeen(seen);
  state.messages.forEach(m => { if (!m.is_read) { m.is_read = true; pendingReads.add(m.id); } });
  flushReads();
  state.lastBadge = updateBadge();
  renderAll();
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
      { title: `You have ${plural(n, 'new alert')}`, body: 'Tap to read the details.' },
      state.alerts.some(a => a.type === 'error') ? 'error' : 'warning',
      () => go('notifs', { filter: 'unread' })
    );
  }
  state.lastBadge = n;
}

// ---------------------------------------------------------------------------
// Subject modal (full score breakdown)
// ---------------------------------------------------------------------------
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
        ${hasFinalGrade(s) ? `<span>Final grade: <strong>${s.term_grade}</strong></span>` : ''}
        <span>${escapeHtml(s.teacher)}</span>
      </div>
      ${hint ? `<p class="hint ${hint.cls}" style="margin: 0 0 14px;">${escapeHtml(hint.text)}</p>` : ''}`;
  }

  try {
    const grades = await apiFetch(`/student/subjects/${subjectId}/details`, { silent: true });   // the modal shows its own "Loading details…"
    const descColor = { Advancing: 'green', Benchmarking: '#1e3a8a', Connecting: '#0369a1', Developing: '#b45309', Emerging: 'red' };
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

// ---------------------------------------------------------------------------
// One handler for every clickable summary (cards, tiles, chips, alerts)
// ---------------------------------------------------------------------------
function activate(e) {
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest('[data-open], [data-go], [data-sfilter], [data-nfilter]');
  if (!el) return;
  if (el.closest('#subjectDetailModal')) return;
  if (e.type === 'keydown') {
    if (el.tagName === 'BUTTON' || el.tagName === 'A') return; // native click handles these
    e.preventDefault();
  }
  if (el.tagName === 'A') e.preventDefault();

  if (el.dataset.sfilter) { state.subjectFilter = el.dataset.sfilter; renderSubjectsTab(); }
  else if (el.dataset.nfilter) { state.notifFilter = el.dataset.nfilter; renderNotifs(); }
  else if (el.dataset.open) openSubjectModal(Number(el.dataset.open), el);
  else if (el.dataset.go) go(el.dataset.go, { filter: el.dataset.filter });
}
document.addEventListener('click', activate);
document.addEventListener('keydown', activate);

// ---------------------------------------------------------------------------
// Load everything in one request
// ---------------------------------------------------------------------------
function renderAll() {
  renderHero();
  renderTiles();
  renderFocus();
  renderGlance();
  renderAttendance();
  renderPreview();
  if (state.view === 'subjects') renderSubjectsTab();
  if (state.view === 'notifs') renderNotifs();
  announce();
}

function showLoadError(err) {
  const msg = `<div class="empty">Could not load your records: ${escapeHtml(err.message)}<br>
      <button class="btn btn-small" style="margin-top:10px;" onclick="loadAll()">Try again</button></div>`;
  $('glanceList').innerHTML = msg;
  $('heroLine').textContent = 'We could not load your records.';
}

async function loadAll({ silent = false } = {}) {
  try {
    const d = await apiFetch('/student/overview', { silent });   // apiFetch shows/hides the loading overlay itself
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
  }
}

setInterval(() => { if (!document.hidden) loadAll({ silent: true }); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.lastLoad && Date.now() - state.lastLoad > STALE_MS) loadAll({ silent: true });
});

// Boot
const startView = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
history.replaceState({ view: startView }, '', '#' + startView);
showView(startView, { push: false });
loadAll();