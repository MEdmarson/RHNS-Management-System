const API = '/api';

function getToken() { return localStorage.getItem('token'); }
function getUser()  { return JSON.parse(localStorage.getItem('user') || '{}'); }

async function apiFetch(path, options = {}) {
  // 1. Show the spinner
  const loader = document.getElementById('loadingOverlay');
  if (loader) loader.style.display = 'flex';

  const headers = {
    'Content-Type': 'application/json',
    ...(getToken() && { Authorization: `Bearer ${getToken()}` }),
    ...(options.headers || {})
  };

  try {
    const res = await fetch(`${API}${path}`, { ...options, headers });
    
    if (res.status === 401) { 
      logout(); 
      return; 
    }
    
    if (!res.ok) {
      let errorMsg = 'Request failed';
      try {
        const errorData = await res.json();
        errorMsg = errorData.error || errorMsg;
      } catch (e) { /* Ignore JSON parse error if backend crashes */ }
      throw new Error(errorMsg);
    }
    
    return await res.json();
  } finally {
    // 2. Hide the spinner whether it succeeds or fails
    if (loader) loader.style.display = 'none';
  }
}

async function login(email, password) {
  const loader = document.getElementById('loadingOverlay');
  if (loader) loader.style.display = 'flex';

  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    
    if (!res.ok) throw new Error('Invalid credentials');
    
    const data = await res.json();
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify({ role: data.role, name: data.name }));
    
    window.location = `${data.role}.html`; 
  } finally {
    if (loader) loader.style.display = 'none';
  }
}

function logout() {
  localStorage.clear();
  window.location = 'index.html';
}

function requireAuth(role) {
  const user = getUser();
  if (!user.role) {
    return (window.location = 'index.html');
  }
  if (role && user.role !== role) {
    return (window.location = `${user.role}.html`);
  }
}