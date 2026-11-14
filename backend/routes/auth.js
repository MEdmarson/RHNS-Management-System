const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
require('dotenv').config();

// LOGIN
router.post('/login', async (req, res) => {
  // The 'email' variable from the frontend holds whatever the user typed (LRN or Email)
  const { email, password } = req.body;
  const identifier = (email || '').trim();
  const passwordValue = password || '';

  try {
    let query;
    let params;

    if (identifier.includes('@')) {
      // Teacher/Admin Login (by email)
      query = 'SELECT * FROM users WHERE LOWER(email) = LOWER(?)';
      params = [identifier];
    } else {
      // Student Login (by LRN)
      // We must JOIN the students table to find the LRN
      query = `
        SELECT u.* FROM users u 
        INNER JOIN students s ON s.user_id = u.id 
        WHERE s.lrn = ?
      `;
      params = [identifier];
    }

    const [rows] = await pool.query(query, params);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];
    const valid = await bcrypt.compare(passwordValue, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Note: user.lrn will be undefined for students here because it's in the students table.
    // But the token is created using the ID and role, which is what matters.
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.full_name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || '24h' }
    );

    res.json({ 
      token, 
      role: user.role, 
      name: user.full_name,
      email: user.email,
      is_first_login: user.is_first_login 
    });
  } catch (e) {
    console.error("Login error:", e);
    res.status(500).json({ error: e.message });
  }
});

// CHANGE PASSWORD (For First Login)
router.post('/change-password', authenticate, async (req, res) => {
  const { newPassword } = req.body;
  const userId = req.user.id;

  try {
    const password_hash = await bcrypt.hash(newPassword, 10);
    
    // Update the password and turn off the first_login flag
    await pool.query(
      'UPDATE users SET password_hash = ?, is_first_login = FALSE WHERE id = ?',
      [password_hash, userId]
    );
    
    res.json({ ok: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error("Password change error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ME (Verify Token)
router.get('/me', authenticate, (req, res) => {
  res.json(req.user);
});

module.exports = router;