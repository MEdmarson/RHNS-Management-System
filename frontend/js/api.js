const API = '/api';

function getToken() { return localStorage.getItem('token'); }
function getUser()  { return JSON.parse(localStorage.getItem('user') || '{}'); }

async function apiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(getToken() && { Authorization: `Bearer ${getToken()}` }),
    ...(options.headers || {})
  };
  const res = await fetch(`${API}${path}`, { ...options, headers });
  
  if (res.status === 401) { 
    logout(); 
    return; 
  }
  
  if (!res.ok) {
    // Safely handle errors that might not return JSON
    let errorMsg = 'Request failed';
    try {
      const errorData = await res.json();
      errorMsg = errorData.error || errorMsg;
    } catch (e) { /* Ignore JSON parse error */ }
    throw new Error(errorMsg);
  }
  
  return res.json();
}

async function login(email, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  
  if (!res.ok) throw new Error('Invalid credentials');
  
  const data = await res.json();
  localStorage.setItem('token', data.token);
  localStorage.setItem('user', JSON.stringify({ role: data.role, name: data.name }));
  
  // FIXED: Removed the leading slash to keep it relative
  window.location = `${data.role}.html`; 
}

function logout() {
  localStorage.clear();
  // FIXED: Removed the leading slash
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