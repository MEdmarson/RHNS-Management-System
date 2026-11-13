const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Using path.join is safer than relative paths ('../frontend') when running the server from different directories
app.use(express.static(path.join(__dirname, '..', 'frontend'))); 

app.use('/api/auth',    require('./routes/auth'));
app.use('/api/teacher', require('./routes/teacher'));
app.use('/api/student', require('./routes/student'));
app.use('/api/admin',   require('./routes/admin'));

// Note: 'classRecordExport' was removed from here because the /export route 
// is already handled inside 'routes/teacher.js'. Mounting both causes route conflicts.

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));