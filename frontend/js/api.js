const API = 'http://localhost:5000/api';

function getToken() { return localStorage.getItem('token'); }
function getUser()  { return JSON.parse(localStorage.getItem('user') || '{}'); }

async function apiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(getToken() && { Authorization: `Bearer ${getToken()}` }),
    ...(options.headers || {})
  };
  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (res.status === 401) { logout(); return; }
  if (!res.ok) throw new Error((await res.json()).error || 'Request failed');
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
  window.location = `/${data.role}.html`;
}

function logout() {
  localStorage.clear();
  window.location = '/index.html';
}

function requireAuth(role) {
  const user = getUser();
  if (!user.role) return (window.location = '/index.html');
  if (role && user.role !== role) return (window.location = `/${user.role}.html`);
}