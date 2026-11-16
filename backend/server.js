
// ===========================================================================
// RNHS MANAGEMENT SYSTEM - EXPRESS SERVER
// ===========================================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();


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
// ===========================================================================

app.use(cors({
  origin: (origin, callback) => {

    // Allow requests without an Origin header.
    // Example: server-side health checks.
    if (!origin) {
      return callback(null, true);
    }

    // Allow all origins when FRONTEND_URL is not configured.
    // Useful during local development.
    if (allowedOrigins.length === 0) {
      return callback(null, true);
    }

    // Allow configured frontend domains.
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(
      new Error(`CORS blocked request from: ${origin}`)
    );
  },

  methods: [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS'
  ],

  allowedHeaders: [
    'Content-Type',
    'Authorization'
  ],

  exposedHeaders: [
    'Content-Disposition'
  ]
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
// Your frontend is now hosted separately on Render Static Site.
// This middleware is retained for backward compatibility.
// It does not control where your users initially open the website.
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

  console.log('========================================');

});


// ===========================================================================
// END OF SERVER.JS
// ===========================================================================
