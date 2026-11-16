// ===========================================================================
// RNHS MANAGEMENT SYSTEM - EXPRESS SERVER
// ===========================================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// Render sits behind a proxy. This makes req.protocol report "https"
// so the server can correctly recognise its own origin.
app.set('trust proxy', 1);


// ===========================================================================
// CONFIGURATION
// ===========================================================================

const PORT = process.env.PORT || 5000;

const FRONTEND_URL = process.env.FRONTEND_URL || '';

const allowedOrigins = FRONTEND_URL
  .split(',')
  .map(origin => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);


// ===========================================================================
// CORS CONFIGURATION
//
// Allows the separately hosted Render Static Site to access this API.
// Multiple frontend origins can be configured using comma-separated URLs.
// The server always trusts its own origin, so pages served directly by this
// backend (express.static below) can still call the API.
// ===========================================================================

app.use(cors((req, callback) => {

  const origin = req.header('Origin');
  const selfOrigin = `${req.protocol}://${req.get('host')}`;

  const allowed =
    !origin ||                        // No Origin header (health checks, etc.)
    allowedOrigins.length === 0 ||    // FRONTEND_URL not set (local development)
    origin === selfOrigin ||          // The backend serving its own pages
    allowedOrigins.includes(origin);  // Configured frontend domains

  if (!allowed) {
    return callback(new Error(`CORS blocked request from: ${origin}`));
  }

  callback(null, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition']
  });
}));


// ===========================================================================
// BODY PARSER
// ===========================================================================

app.use(express.json());


// ===========================================================================
// HEALTH CHECK
//
// Used by the frontend to wake up the Render backend.
// Does not access the database.
// ===========================================================================

app.get('/api/health', (req, res) => {

  res.status(200).json({
    ok: true,
    message: 'RNHS API is running',
    timestamp: new Date().toISOString()
  });

});


// ===========================================================================
// API ROUTES
// ===========================================================================

// Authentication
app.use('/api/auth', require('./routes/auth'));

// Teacher dashboard and functions
app.use('/api/teacher', require('./routes/teacher'));

// Student dashboard and functions
app.use('/api/student', require('./routes/student'));

// Admin dashboard and functions
app.use('/api/admin', require('./routes/admin'));


// ===========================================================================
// OPTIONAL FRONTEND STATIC FILE SERVING
//
// Your frontend is hosted separately on Render Static Site.
// This middleware is retained for backward compatibility.
// ===========================================================================

app.use(
  express.static(path.join(__dirname, '..', 'frontend'))
);


// ===========================================================================
// API 404 HANDLER
// ===========================================================================

app.use('/api', (req, res) => {

  res.status(404).json({
    error: 'API endpoint not found'
  });

});


// ===========================================================================
// ERROR HANDLER
// ===========================================================================

app.use((err, req, res, next) => {

  console.error('Server Error:', err.message);

  if (res.headersSent) {
    return next(err);
  }

  if (err.message && err.message.startsWith('CORS blocked')) {
    return res.status(403).json({
      error: 'Access denied by CORS policy'
    });
  }

  res.status(500).json({
    error: 'Internal server error'
  });

});


// ===========================================================================
// START SERVER
// ===========================================================================

app.listen(PORT, '0.0.0.0', () => {

  console.log('========================================');
  console.log('RNHS MANAGEMENT SYSTEM API');
  console.log('========================================');

  console.log(`Server running on port: ${PORT}`);

  console.log('Allowed frontend origins:');

  if (allowedOrigins.length) {
    allowedOrigins.forEach(origin => console.log(`- ${origin}`));
  } else {
    console.log('- All origins (FRONTEND_URL not configured)');
  }

  console.log('(The backend\'s own origin is always allowed)');
  console.log('========================================');

});


// ===========================================================================
// END OF SERVER.JS
// ===========================================================================