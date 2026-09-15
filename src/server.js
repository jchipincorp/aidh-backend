const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // Agar PostgreSQL hai

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// Render ya Supabase se automatically connection uthane ke liye:
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Cloud databases ke liye zaroori hota hai
});

app.get('/', (req, res) => {
    res.send('AIDH Backend API is running successfully! CORS is enabled.');
});

// Frontend se data receive kar ke Database mein save karne wala route
app.post('/api/save-onboarding', async (req, res) => {
    const { user, scores } = req.body;
    console.log("Onboarding Data received from frontend:", req.body);
    
    try {
        // Yahan aapke table ka naam hoga (misal ke taur par 'onboarding_users')
        const query = `
            INSERT INTO onboarding_users (fname, email, plan, enema_score, raw_score, fasting_score, meditation_score, sleep_score)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;
        `;
        const values = [
            user.fname, user.email, user.plan,
            scores.en, scores.rf, scores.ft, scores.md, scores.sl
        ];

        const result = await pool.query(query, values);

        res.json({ 
            success: true, 
            message: "Data successfully saved to Database!",
            savedData: result.rows[0]
        });

    } catch (err) {
        console.error("Database Save Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running live on port ${PORT}`);
});
