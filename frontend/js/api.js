const API = '/api';

function getToken() { return localStorage.getItem('token'); }
function getUser()  { return JSON.parse(localStorage.getItem('user') || '{}'); }

async function apiFetch(path, options = {}) {
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
      } catch (e) { /* Ignore JSON parse error */ }
      throw new Error(errorMsg);
    }
    
    return await res.json();
  } finally {
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
    
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify({ 
      role: data.role, 
      name: data.name, 
      lrn: data.lrn,
      email: data.email 
    }));

    // Use location.replace so the login page is NOT kept in the browser history
    if (data.is_first_login) {
      window.location.replace('change-password.html');
    } else {
      window.location.replace(`${data.role}.html`); 
    }
  } finally {
    if (loader) loader.style.display = 'none';
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