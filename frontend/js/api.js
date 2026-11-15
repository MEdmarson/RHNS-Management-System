// Where the API lives.
//  - Leave '' when the pages and the API are on the same server (how it works now).
//  - If the pages are hosted separately (e.g. a Render Static Site), put the API's address here,
//    with no trailing slash, e.g. 'https://rnhs-api.onrender.com'
const API_ORIGIN = 'https://rhns-management-system.onrender.com';
const API = API_ORIGIN + '';

function getToken() { return localStorage.getItem('token'); }
function getUser()  { return JSON.parse(localStorage.getItem('user') || '{}'); }

// ---------------------------------------------------------------------------
// Loading overlay + request helpers
// Tuned for free hosting (Render), where the server sleeps when idle and can take about a minute to wake.
// ---------------------------------------------------------------------------
const UI = {
  SHOW_AFTER_MS: 250,      // quick requests never flash the overlay; it only appears if loading takes longer than this
  SLOW_MS: 6000,           // after this long, tell the user it is taking longer than usual
  WAKING_MS: 15000,        // after this long, explain that the server is waking up
  TIMEOUT_MS: 90000,       // give up on a single request after this long
  RETRY_BUDGET_MS: 75000,  // keep retrying safe requests (GET and login) for this long while the server wakes up
  RETRY_WAIT_MS: 3000      // pause between retries
};

let pendingLoads = 0;      // requests currently loading; the overlay hides only when this reaches 0
let showTimer = null, slowTimer = null, wakingTimer = null;

function loaderEl() { return document.getElementById('loadingOverlay'); }

function setLoaderNote(text) {
  const el = loaderEl();
  if (!el) return;
  let note = document.getElementById('loadingNote');
  if (!note) {
    note = document.createElement('div');
    note.id = 'loadingNote';
    note.style.cssText = 'margin-top:8px; max-width:320px; padding:0 16px; text-align:center; font-size:13px; color:var(--muted);';
    el.appendChild(note);
  }
  note.textContent = text || '';
}

function showLoader() {
  pendingLoads++;
  if (pendingLoads !== 1) return;               // already counting; the overlay is on, or about to be
  showTimer   = setTimeout(() => { const el = loaderEl(); if (el) el.style.display = 'flex'; }, UI.SHOW_AFTER_MS);
  slowTimer   = setTimeout(() => setLoaderNote('This is taking longer than usual…'), UI.SLOW_MS);
  wakingTimer = setTimeout(() => setLoaderNote('The server is waking up (free hosting sleeps when idle). This can take up to a minute, please wait.'), UI.WAKING_MS);
}

function hideLoader() {
  pendingLoads = Math.max(0, pendingLoads - 1);
  if (pendingLoads > 0) return;                 // other requests are still loading
  clearTimeout(showTimer); clearTimeout(slowTimer); clearTimeout(wakingTimer);
  const el = loaderEl();
  if (el) el.style.display = 'none';
  setLoaderNote('');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UI.TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Retries only when it is safe (canRetry) and the server looks like it is still waking up (network error, 502/503/504)
async function fetchWithRetry(url, opts, canRetry) {
  const started = Date.now();
  const mayRetry = () => canRetry && (Date.now() - started + UI.RETRY_WAIT_MS) < UI.RETRY_BUDGET_MS;
  for (;;) {
    try {
      const res = await fetchWithTimeout(url, opts);
      if ([502, 503, 504].includes(res.status) && mayRetry()) { await sleep(UI.RETRY_WAIT_MS); continue; }
      return res;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('The server took too long to respond. Please try again.');
      if (mayRetry()) { await sleep(UI.RETRY_WAIT_MS); continue; }   // a sleeping server can fail fast, so keep trying
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
  }
}

// When the API is on another address, start waking it as soon as any page opens,
// so it is usually ready by the time the user has typed their password.
if (API_ORIGIN) {
  try { fetch(`${API_ORIGIN}/api/health`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {}); } catch (e) { /* ignore */ }
}

// options.silent = true: no overlay (used for background refreshes)
async function apiFetch(path, options = {}) {
  const { silent = false, ...fetchOptions } = options;
  if (!silent) showLoader();

  const headers = {
    'Content-Type': 'application/json',
    ...(getToken() && { Authorization: `Bearer ${getToken()}` }),
    ...(fetchOptions.headers || {})
  };
  const method = (fetchOptions.method || 'GET').toUpperCase();

  try {
    const res = await fetchWithRetry(`${API}${path}`, { ...fetchOptions, headers }, method === 'GET');

    if (res.status === 401) {
      logout();
      return;
    }

    if (!res.ok) {
      let errorMsg = 'Request failed';
      try {
        const errorData = await res.json();
        errorMsg = errorData.error || errorMsg;
      } catch (e) { /* Ignore JSON parse error */ }
      throw new Error(errorMsg);
    }

    return await res.json();
  } finally {
    if (!silent) hideLoader();
  }
}

async function login(emailOrLrn, password) {
  showLoader();
  let leaving = false;
  try {
    const res = await fetchWithRetry(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailOrLrn, password: password })
    }, true);                                   // safe to repeat while the server wakes up

    if (!res.ok) {
      if ([400, 401, 403, 404].includes(res.status)) throw new Error('Invalid credentials');
      throw new Error('The server is not responding right now. Please try again in a moment.');
    }

    const data = await res.json();

    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify({
      role: data.role,
      name: data.name,
      lrn: data.lrn,
      email: data.email
    }));

    leaving = true;                             // keep the spinner up until the next page takes over
    // Use location.replace so the login page is NOT kept in the browser history
    if (data.is_first_login) {
      window.location.replace('change-password.html');
    } else {
      window.location.replace(`${data.role}.html`);
    }
  } finally {
    if (!leaving) hideLoader();
  }
}

function logout() {
  localStorage.clear();
  // Replace history so pressing "Forward" doesn't bypass the logout
  window.location.replace('index.html');
}

function requireAuth(role) {
  const user = getUser();
  if (!user.role) {
    return window.location.replace('index.html');
  }
  if (role && user.role !== role) {
    return window.location.replace(`${user.role}.html`);
  }
}