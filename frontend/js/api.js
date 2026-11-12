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
    
    // If unauthorized, force logout
    if (res.status === 401) { 
      logout(); 
      return; 
    }
    
    // Handle standard errors
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
    // 2. Hide the spinner whether it succeeds or fails
    if (loader) loader.style.display = 'none';
  }
}

async function login(emailOrLrn, password) {
  const loader = document.getElementById('loadingOverlay');
  if (loader) loader.style.display = 'flex';

  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailOrLrn, password: password })
    });
    
    if (!res.ok) throw new Error('Invalid credentials');
    
    const data = await res.json();
    
    // Store all user details (including email for the password change validation)
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify({ 
      role: data.role, 
      name: data.name, 
      lrn: data.lrn,
      email: data.email 
    }));

    // Redirect logic: First login goes to change password, otherwise to dashboard
    if (data.is_first_login) {
      window.location = 'change-password.html';
    } else {
      window.location = `${data.role}.html`; 
    }
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