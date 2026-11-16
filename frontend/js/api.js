
// ===========================================================================
// RNHS MANAGEMENT SYSTEM - API CONFIGURATION
// ===========================================================================

// Backend API address
const API_ORIGIN = 'https://rnhs-shs.onrender.com';
const API = `${API_ORIGIN}/api`;

// Frontend static website address
const FRONTEND_ORIGIN = 'https://rnhs-management.onrender.com';


// ===========================================================================
// AUTHENTICATION HELPERS
// ===========================================================================

function getToken() {
  return localStorage.getItem('token');
}

function getUser() {
  return JSON.parse(localStorage.getItem('user') || '{}');
}


// ===========================================================================
// LOADING OVERLAY + REQUEST CONFIGURATION
// Optimized for Render free hosting
// ===========================================================================

const UI = {
  SHOW_AFTER_MS: 250,       // Show overlay only after 250ms
  SLOW_MS: 6000,            // Display slow connection message
  WAKING_MS: 15000,         // Display backend waking message
  TIMEOUT_MS: 90000,        // Maximum duration of one request
  RETRY_BUDGET_MS: 75000,   // Retry budget for safe/repeatable requests
  RETRY_WAIT_MS: 3000       // Delay between retries
};

let pendingLoads = 0;

let showTimer = null;
let slowTimer = null;
let wakingTimer = null;


// ===========================================================================
// LOADING OVERLAY HELPERS
// ===========================================================================

function loaderEl() {
  return document.getElementById('loadingOverlay');
}

function setLoaderNote(text) {
  const el = loaderEl();

  if (!el) return;

  let note = document.getElementById('loadingNote');

  if (!note) {
    note = document.createElement('div');
    note.id = 'loadingNote';

    note.style.cssText =
      'margin-top:8px; max-width:320px; padding:0 16px; ' +
      'text-align:center; font-size:13px; color:var(--muted);';

    el.appendChild(note);
  }

  note.textContent = text || '';
}

function showLoader() {
  pendingLoads++;

  if (pendingLoads !== 1) return;

  showTimer = setTimeout(() => {
    const el = loaderEl();

    if (el) el.style.display = 'flex';
  }, UI.SHOW_AFTER_MS);

  slowTimer = setTimeout(() => {
    setLoaderNote('Server is waking up. This can take a few seconds, please wait.');
  }, UI.SLOW_MS);

  wakingTimer = setTimeout(() => {
    setLoaderNote(
      'Connecting to server. Almost there, please wait.'
    );
  }, UI.WAKING_MS);
}

function hideLoader() {
  pendingLoads = Math.max(0, pendingLoads - 1);

  if (pendingLoads > 0) return;

  clearTimeout(showTimer);
  clearTimeout(slowTimer);
  clearTimeout(wakingTimer);

  const el = loaderEl();

  if (el) el.style.display = 'none';

  setLoaderNote('');
}


// ===========================================================================
// REQUEST HELPERS
// ===========================================================================

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();

  const timeout = setTimeout(() => {
    ctrl.abort();
  }, UI.TIMEOUT_MS);

  return fetch(url, {
    ...opts,
    signal: ctrl.signal
  }).finally(() => {
    clearTimeout(timeout);
  });
}


// ===========================================================================
// AUTOMATIC RETRY
//
// Retries:
// - Network errors
// - HTTP 502
// - HTTP 503
// - HTTP 504
//
// Only requests explicitly marked safe/repeatable are retried.
// ===========================================================================

async function fetchWithRetry(url, opts, canRetry) {
  const started = Date.now();

  const mayRetry = () =>
    canRetry &&
    (Date.now() - started + UI.RETRY_WAIT_MS) < UI.RETRY_BUDGET_MS;

  for (;;) {
    try {
      const res = await fetchWithTimeout(url, opts);

      if (
        [502, 503, 504].includes(res.status) &&
        mayRetry()
      ) {
        await sleep(UI.RETRY_WAIT_MS);
        continue;
      }

      return res;

    } catch (err) {

      if (err.name === 'AbortError') {
        throw new Error(
          'The server took too long to respond. Please try again.'
        );
      }

      if (mayRetry()) {
        await sleep(UI.RETRY_WAIT_MS);
        continue;
      }

      throw new Error(
        'Could not reach the server. Check your connection and try again.'
      );
    }
  }
}


// ===========================================================================
// BACKGROUND SERVER WAKE-UP
//
// This executes as soon as the frontend loads.
// It DOES NOT block the login page or wait for the backend.
// ===========================================================================

function wakeUpServer() {
  fetch(`${API}/health`, {
    method: 'GET',
    cache: 'no-store'
  }).catch(() => {
    // Ignore errors here.
    // Actual API requests will handle connection errors.
  });
}

// Start waking up the backend immediately.
wakeUpServer();


// ===========================================================================
// GENERAL API FETCH
//
// options.silent = true disables the loading overlay.
// Useful for background refreshes.
// ===========================================================================

async function apiFetch(path, options = {}) {
  const {
    silent = false,
    ...fetchOptions
  } = options;

  if (!silent) showLoader();

  const headers = {
    'Content-Type': 'application/json',

    ...(getToken() && {
      Authorization: `Bearer ${getToken()}`
    }),

    ...(fetchOptions.headers || {})
  };

  const method = (fetchOptions.method || 'GET').toUpperCase();

  try {
    const res = await fetchWithRetry(
      `${API}${path}`,
      {
        ...fetchOptions,
        headers
      },
      method === 'GET'
    );

    // Unauthorized session
    if (res.status === 401) {
      logout();
      return;
    }

    // Handle API errors
    if (!res.ok) {
      let errorMsg = 'Request failed';

      try {
        const errorData = await res.json();
        errorMsg = errorData.error || errorMsg;
      } catch (e) {
        // Ignore JSON parsing errors
      }

      throw new Error(errorMsg);
    }

    return await res.json();

  } finally {
    if (!silent) hideLoader();
  }
}


// ===========================================================================
// LOGIN
//
// Login uses the backend API.
// The loading overlay stays visible during authentication.
// ===========================================================================

async function login(emailOrLrn, password) {
  showLoader();

  let leaving = false;

  try {
    const res = await fetchWithRetry(
      `${API}/auth/login`,
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          email: emailOrLrn,
          password: password
        })
      },
      true
    );

    if (!res.ok) {

      if ([400, 401, 403, 404].includes(res.status)) {
        throw new Error('Invalid credentials');
      }

      throw new Error(
        'The server is not responding right now. Please try again in a moment.'
      );
    }

    const data = await res.json();

    // Save authentication token
    localStorage.setItem('token', data.token);

    // Save authenticated user information
    localStorage.setItem('user', JSON.stringify({
      role: data.role,
      name: data.name,
      lrn: data.lrn,
      email: data.email
    }));

    leaving = true;

    // Redirect to change password on first login
    if (data.is_first_login) {

      window.location.replace('change-password.html');

    } else {

      // Redirect based on authenticated user role
      window.location.replace(`${data.role}.html`);

    }

  } finally {

    // Keep loading overlay active during page navigation.
    if (!leaving) {
      hideLoader();
    }

  }
}


// ===========================================================================
// LOGOUT
// ===========================================================================

function logout() {
  localStorage.clear();

  // Prevent navigating back into authenticated pages.
  window.location.replace('index.html');
}


// ===========================================================================
// AUTHENTICATION / ROLE PROTECTION
// ===========================================================================

function requireAuth(role) {
  const user = getUser();

  // No authenticated user
  if (!user.role) {
    return window.location.replace('index.html');
  }

  // Prevent access to another role's dashboard
  if (role && user.role !== role) {
    return window.location.replace(`${user.role}.html`);
  }
}


// ===========================================================================
// END OF API.JS
// ===========================================================================
