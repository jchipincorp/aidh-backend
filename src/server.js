const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({
  origin: [
    'https://cccx1.com',
    'https://www.cccx1.com'
  ],
  credentials: true
}));

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Make DB available to other modules if your db config uses a shared pool.
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'AIDH API',
    message: 'AIDH Backend API is running successfully'
  });
});

app.get('/ping', (req, res) => {
  res.json({
    ok: true,
    message: 'PING WORKS'
  });
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (error) {
    console.error('Health DB error:', error);
    res.status(500).json({
      ok: false,
      database: 'error'
    });
  }
});

// Authentication routes
const authRoutes = require('./routes/auth.routes');
app.use('/api/auth', authRoutes);

// Existing onboarding route
app.post('/api/save-onboarding', async (req, res) => {
  const { user, scores } = req.body;

  if (!user || !scores) {
    return res.status(400).json({
      success: false,
      error: 'user and scores are required'
    });
  }

  try {
    const query = `
      INSERT INTO onboarding_users
      (fname, email, plan, enema_score, raw_score, fasting_score, meditation_score, sleep_score)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;

    const values = [
      user.fname,
      user.email,
      user.plan,
      scores.en,
      scores.rf,
      scores.ft,
      scores.md,
      scores.sl
    ];

    const result = await pool.query(query, values);

    res.json({
      success: true,
      message: 'Data successfully saved to Database',
      savedData: result.rows[0]
    });
  } catch (err) {
    console.error('Database Save Error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  res.status(500).json({
    error: 'Internal server error'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running live on port ${PORT}`);
});
