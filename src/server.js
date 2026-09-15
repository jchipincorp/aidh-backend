const express = require('express');
const cors = require('cors');

const app = express();
// Render automatically PORT assign karta hai, warna 10000 use karega
const PORT = process.env.PORT || 10000; 

// Middleware (Yeh dono lines bohat zaroori hain)
app.use(cors()); // Frontend ko API use karne ki ijazat deta hai
app.use(express.json()); // Frontend se aane wale JSON data ko read karta hai

// Basic Health Check Route (Check karne ke liye API chal rahi hai ya nahi)
app.get('/', (req, res) => {
    res.send('AIDH Backend API is running successfully! CORS is enabled.');
});

// Frontend se data receive karne wala route
app.post('/api/save-onboarding', (req, res) => {
    console.log("Onboarding Data received from frontend:", req.body);
    
    // Future step: Yahan hum MySQL database mein save karne ka code lagayenge
    
    res.json({ 
        success: true, 
        message: "Onboarding data safely received at backend!" 
    });
});

// Server Start karna
app.listen(PORT, () => {
    console.log(`Server is running live on port ${PORT}`);
});
