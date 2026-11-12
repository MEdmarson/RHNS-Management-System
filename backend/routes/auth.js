const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
require('dotenv').config();

// LOGIN
router.post('/login', async (req, res) => {
  // The 'email' variable from the frontend holds whatever the user typed (LRN or Email)
  const rawInput = (req.body.email || '').toString();
  const password = req.body.password;
  const email = rawInput.trim();

  if (!email || !password) {
    return res.status(400).json({ error: 'Email/LRN and password are required' });
  }

  try {
    let query;
    let params;

    // If the input contains an '@', it's a teacher/admin. Search by email (case-insensitive).
    if (email.includes('@')) {
      query = 'SELECT * FROM users WHERE LOWER(email) = LOWER(?)';
      params = [email];
    }
    // If there's no '@', it's a student. Search by LRN (case-insensitive).
    else {
      query = 'SELECT * FROM users WHERE LOWER(lrn) = LOWER(?)';
      params = [email];
    }

    const [rows] = await pool.query(query, params);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user.id, email: user.email, lrn: user.lrn, role: user.role, name: user.full_name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || '24h' }
    );

    res.json({
      token,
      role: user.role,
      name: user.full_name,
      lrn: user.lrn,
      email: user.email,
      is_first_login: user.is_first_login
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: e.message });
  }
});

// CHANGE PASSWORD (For First Login)
router.post('/change-password', authenticate, async (req, res) => {
  const { newPassword } = req.body;
  const userId = req.user.id;

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const password_hash = await bcrypt.hash(newPassword, 10);

    // Update the password and turn off the first_login flag
    await pool.query(
      'UPDATE users SET password_hash = ?, is_first_login = FALSE WHERE id = ?',
      [password_hash, userId]
    );

    res.json({ ok: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ME (Verify Token)
router.get('/me', authenticate, (req, res) => {
  res.json(req.user);
});

module.exports = router;