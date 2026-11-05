const router = require('express').Router();
const pool = require('../config/db');
const bcrypt = require('bcryptjs'); // Added for password hashing
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('admin'));

// ==========================================
// EXISTING DASHBOARD ROUTES
// ==========================================

// MACRO DASHBOARD
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

// ALL AT-RISK SCHOOL-WIDE
router.get('/at-risk', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.full_name, sec.name AS section,
             ROUND(AVG(g.term_grade),2) AS avg_grade,
             (SELECT COUNT(*) FROM attendance a
              WHERE a.student_id = u.id AND a.status='absent') AS absences
      FROM users u
      JOIN students s ON s.user_id = u.id
      LEFT JOIN sections sec ON sec.id = s.section_id
      LEFT JOIN grades g ON g.student_id = u.id
      GROUP BY u.id, u.full_name, sec.name
      HAVING avg_grade < 75 OR absences > 4`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TEACHER COMPLIANCE
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

// CSV EXPORT — all students & grades
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
// NEW MANAGEMENT ROUTES (Users, Sections, Subjects)
// ==========================================

// CREATE a new User (Teacher or Student)
router.post('/users', async (req, res) => {
  const { email, password, full_name, role, lrn, section_id, grade_level } = req.body;
  
  try {
    // 1. Hash the password
    const password_hash = await bcrypt.hash(password, 10);

    // 2. Insert into users table
    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
      [email, password_hash, full_name, role]
    );
    const newUserId = result.insertId;

    // 3. If role is student, insert into students table
    if (role === 'student') {
      await pool.query(
        'INSERT INTO students (user_id, lrn, section_id, grade_level) VALUES (?, ?, ?, ?)',
        [newUserId, lrn, section_id || null, grade_level || 10]
      );
    }

    res.json({ ok: true, message: 'User created successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Email or LRN already exists' });
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// CREATE a new Section
router.post('/sections', async (req, res) => {
  const { name, adviser_id } = req.body;
  try {
    await pool.query('INSERT INTO sections (name, adviser_id) VALUES (?, ?)', [name, adviser_id || null]);
    res.json({ ok: true, message: 'Section created' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Section name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// CREATE a new Subject and assign to a Teacher
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

// GET all teachers (for dropdowns)
router.get('/teachers', async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, full_name FROM users WHERE role = 'teacher'");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all sections (for dropdowns)
router.get('/sections', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name FROM sections');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all subjects (for dropdowns)
router.get('/subjects', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT sub.id, sub.name, sub.code, sub.section_id, sub.teacher_id, u.full_name AS teacher_name, sec.name AS section_name
      FROM subjects sub
      LEFT JOIN users u ON u.id = sub.teacher_id
      LEFT JOIN sections sec ON sec.id = sub.section_id
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;