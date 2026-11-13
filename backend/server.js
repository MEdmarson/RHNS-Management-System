const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend safely
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.use('/api/auth',    require('./routes/auth'));
app.use('/api/teacher', require('./routes/teacher'));
app.use('/api/student', require('./routes/student'));
app.use('/api/admin',   require('./routes/admin'));

// Note: classRecordExport is integrated into teacher.js so it's not mounted here twice.

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));