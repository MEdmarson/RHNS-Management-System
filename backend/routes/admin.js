const router = require('express').Router();
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('admin'));

// ==========================================
// 1. DASHBOARD & ANALYTICS
// ==========================================
router.get('/dashboard', async (req, res) => {
  try {
    const [[{ total_students }]] = await pool.query(
      `SELECT COUNT(*) AS total_students FROM users WHERE role='student'`
    );
    const [[{ avg_grade }]] = await pool.query(
      `SELECT ROUND(AVG(term_grade),2) AS avg_grade FROM grades`
    );
    const [[{ at_risk }]] = await pool.query(`
      SELECT COUNT(*) AS at_risk FROM (
        SELECT g.student_id
        FROM grades g
        LEFT JOIN attendance a ON a.student_id = g.student_id AND a.status='absent'
        GROUP BY g.student_id
        HAVING AVG(g.term_grade) < 75 OR COUNT(a.id) > 4
      ) t`);
    res.json({ total_students, avg_grade, at_risk });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATED: Now calculates absences more accurately and handles missing grades
router.get('/at-risk', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.full_name, sec.name AS section,
             ROUND(AVG(g.term_grade),2) AS avg_grade,
             (SELECT COUNT(*) FROM attendance a
              WHERE a.student_id = u.id AND a.status='absent') AS absences
      FROM users u
      JOIN students s ON s.user_id = u.id
      LEFT JOIN sections sec ON sec.id = s.section_id
      LEFT JOIN grades g ON g.student_id = u.id
      GROUP BY u.id, u.full_name, sec.name
      HAVING (avg_grade < 75 AND avg_grade IS NOT NULL) OR absences > 4
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/compliance', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.full_name AS teacher,
             MAX(g.updated_at) AS last_update,
             DATEDIFF(NOW(), MAX(g.updated_at)) AS days_ago
      FROM users u
      LEFT JOIN subjects sub ON sub.teacher_id = u.id
      LEFT JOIN grades g ON g.subject_id = sub.id
      WHERE u.role = 'teacher'
      GROUP BY u.id, u.full_name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/export', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.lrn, u.full_name, sec.name AS section, sub.name AS subject,
             g.term, g.term_grade
      FROM users u
      JOIN students s ON s.user_id = u.id
      LEFT JOIN sections sec ON sec.id = s.section_id
      LEFT JOIN grades g ON g.student_id = u.id
      LEFT JOIN subjects sub ON sub.id = g.subject_id
      ORDER BY u.full_name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. MANAGE USERS
// ==========================================
router.get('/all-users', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.full_name, u.email, u.role, s.lrn, s.section_id, sec.name AS section 
      FROM users u
      LEFT JOIN students s ON s.user_id = u.id
      LEFT JOIN sections sec ON sec.id = s.section_id
      WHERE u.role != 'admin'
      ORDER BY u.role, u.full_name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users', async (req, res) => {
  const { email, password, full_name, role, lrn, section_id, grade_level } = req.body;
  try {
    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
      [email, password_hash, full_name, role]
    );
    const newUserId = result.insertId;

    if (role === 'student') {
      await pool.query(
        'INSERT INTO students (user_id, lrn, section_id, grade_level) VALUES (?, ?, ?, ?)',
        [newUserId, lrn, section_id || null, grade_level || 10]
      );
    }
    res.json({ ok: true, message: 'User created successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email or LRN already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:id', async (req, res) => {
  const userId = req.params.id;
  const { full_name, email, lrn, section_id, password } = req.body;
  try {
    await pool.query(
      'UPDATE users SET full_name = ?, email = ? WHERE id = ?',
      [full_name, email, userId]
    );

    if (password && password.trim() !== '') {
      const password_hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash, userId]);
    }

    const [user] = await pool.query('SELECT role FROM users WHERE id = ?', [userId]);
    if (user[0].role === 'student') {
      await pool.query(
        'UPDATE students SET lrn = ?, section_id = ? WHERE user_id = ?',
        [lrn, section_id || null, userId]
      );
    }
    res.json({ ok: true, message: 'User updated successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email or LRN already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = ? AND role != "admin"', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. MANAGE SUBJECTS
// ==========================================
router.get('/subjects', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT sub.id, sub.name, sub.code, sub.section_id, sub.teacher_id, 
             u.full_name AS teacher_name, sec.name AS section_name
      FROM subjects sub
      LEFT JOIN users u ON u.id = sub.teacher_id
      LEFT JOIN sections sec ON sec.id = sub.section_id
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/subjects', async (req, res) => {
  const { code, name, teacher_id, section_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO subjects (code, name, teacher_id, section_id) VALUES (?, ?, ?, ?)',
      [code, name, teacher_id, section_id]
    );
    res.json({ ok: true, message: 'Subject created and assigned' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Subject code already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/subjects/:id', async (req, res) => {
  const { code, name, teacher_id, section_id } = req.body;
  try {
    await pool.query(
      'UPDATE subjects SET code = ?, name = ?, teacher_id = ?, section_id = ? WHERE id = ?',
      [code, name, teacher_id, section_id, req.params.id]
    );
    res.json({ ok: true, message: 'Subject updated successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Subject code already exists' });
    res.status(500).json({ error: err.message });
  }
});

// UPDATED: Admin now properly cleans up grades/attendance when deleting a subject
router.delete('/subjects/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Delete associated grades
    await pool.query('DELETE FROM grades WHERE subject_id = ?', [id]);
    
    // 2. Delete associated attendance records (if tied to subject)
    await pool.query('DELETE FROM attendance WHERE section_id = (SELECT section_id FROM subjects WHERE id = ?)', [id]).catch(() => {});

    // 3. Delete the subject
    await pool.query('DELETE FROM subjects WHERE id = ?', [id]);
    
    res.json({ ok: true, message: 'Subject and linked records deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. DROPDOWNS
// ==========================================
router.get('/teachers', async (req, res) => {
  const [rows] = await pool.query("SELECT id, full_name FROM users WHERE role = 'teacher'");
  res.json(rows);
});

router.get('/sections', async (req, res) => {
  const [rows] = await pool.query('SELECT id, name FROM sections');
  res.json(rows);
});

module.exports = router;