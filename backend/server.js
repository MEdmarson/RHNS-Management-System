const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
// CORS: lets the separately hosted frontend (Render Static Site) call this API.
// Set FRONTEND_URL on Render to the frontend's address (no trailing slash). Separate several with commas.
// If it is not set, any origin is allowed (fine for local testing).
app.use(cors({
  origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map(s => s.trim()) : true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition']      // lets the browser read the file name of Excel downloads
}));
app.use(express.json());

// Serve frontend safely
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Tiny route for waking the server and for keep-alive pings (does not touch the database)
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth',    require('./routes/auth'));
app.use('/api/teacher', require('./routes/teacher'));
app.use('/api/student', require('./routes/student'));
app.use('/api/admin',   require('./routes/admin'));

// Note: classRecordExport is integrated into teacher.js so it's not mounted here twice.

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));