//MAS Gateway server
// server.js
const express = require('express');
require('dotenv').config();
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { initDb, getLetter, insertLetter, updateLetterWorkflow, updateLetterApproval } = require('./database');
const { updateLetterCognitiveData } = require('./database'); // Use the new function

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;


// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- File Upload Configuration ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        // CRITICAL: Ensure uploads directory exists
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir); 
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${file.fieldname}-${uniqueSuffix}.${file.originalname.split('.').pop()}`);
    }
});
const upload = multer({ storage: storage });

// --- Helper Functions ---
function prioritizeLetters(letters) {
    // Sort by priorityScore (highest first), then by date
    return letters
        .sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0) || new Date(a.date) - new Date(b.date));
}

// --- Main Application ---
async function main() {
    const db = await initDb();

    // === AUTHORIZATION MIDDLEWARE ===
    const verifyToken = (req, res, next) => {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.sendStatus(401);
        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) return res.sendStatus(403);
            req.user = user;
            next();
        });
    };

    // === AUTHENTICATION ENDPOINT ===
    // app.post('/api/login', async (req, res) => {
    //     const { email, password } = req.body;
    //     const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    //     if (!user || !await bcrypt.compare(password, user.password)) {
    //         return res.status(401).json({ message: 'Invalid credentials' });
    //     }
    //     const token = jwt.sign({ id: user.id, role: user.role, department: user.department }, JWT_SECRET, { expiresIn: '8h' });
    //     res.json({ token, user: { role: user.role, department: user.department } });
    // });
     // === AUTHENTICATION ENDPOINT ===
    app.post('/api/login', async (req, res) => {
        const { email, password } = req.body;
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (!user || !await bcrypt.compare(password, user.password)) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // --- START OF FIX ---
        // Get the department from the DB, but set a default if it's missing
        let userDepartment = user.department; // This is probably null
        
        // Manually assign departments based on email
        // You can add more 'else if' blocks for other clerks
        if (user.email === 'clerk@cse.com') {
            userDepartment = 'CSE';
        } else if (user.email === 'clerk@ece.com') {
            userDepartment = 'ECE';
        }
        else if (user.email === 'clerk@it.com') {
            userDepartment = 'IT';
        }
        else if (user.email === 'clerk@eee.com') {
            userDepartment = 'EEE';
        }
        else if (user.email === 'clerk@eie.com') {
            userDepartment = 'EIE';
        }
        else if (user.email === 'clerk@me.com') {
            userDepartment = 'ME';
        }
        else if (user.email === 'clerk@civil.com') {
            userDepartment = 'CIVIL';
        }
        else if (user.email === 'clerk@mba.com') {
            userDepartment = 'MBA';
        }
        else if (user.email === 'clerk@mca.com') {
            userDepartment = 'MCA';
        }
        // --- END OF FIX ---

        // Sign the token WITH the corrected department
        const token = jwt.sign({ 
            id: user.id, 
            role: user.role, 
            department: userDepartment // Use the corrected variable here
        }, JWT_SECRET, { expiresIn: '8h' });

        res.json({ token, user: { role: user.role, department: userDepartment } });
    });
    // === QUERY AGENT (Role-based Data Fetching) ===
    app.get('/api', verifyToken, async (req, res) => {
    const { role, department } = req.user;
    let letters = [];
    
    if (role === 'Clerk') {
        letters = await db.all('SELECT * FROM letters WHERE dept = ? ORDER BY date DESC', [department]);
    } else if (role === 'Dean') {
        letters = await db.all("SELECT * FROM letters WHERE stage != 'Clerk' AND status != 'ML_OCR' ORDER BY date DESC");
    } else if (role === 'Registrar') {
        letters = await db.all("SELECT * FROM letters WHERE stage NOT IN ('Clerk', 'Dean') AND status != 'ML_OCR' ORDER BY date DESC");
    } else if (role === 'VC') {
        letters = await db.all("SELECT * FROM letters WHERE stage NOT IN ('Clerk', 'Dean', 'Registrar') AND status != 'ML_OCR' ORDER BY date DESC");
    } else if (role === 'Accounts') {
        letters = await db.all("SELECT * FROM letters WHERE stage = 'Accounts' AND classification = 'Payment' ORDER BY date DESC");
    }
    
    // res.json(prioritizeLetters(letters));
    // Sort by most recent date first (newest on top)
    letters.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(letters);

});

    app.get('/api/analysis', verifyToken, async (req, res) => {
      if (req.user.role !== 'Clerk') {
        return res.status(403).json({ message: 'Access denied. Analytics available only for clerks.' });
      }

      const { department } = req.user;

      try {
        // Metric 1: Total Letters by Type
        const typeTotals = await db.all(
          `SELECT classification, COUNT(*) AS count
           FROM letters
           WHERE dept = ? AND classification IS NOT NULL
           GROUP BY classification`, [department]
        );
        
        // Metric 2: Monthly Upload Trend
        const monthlyTrend = await db.all(
          `SELECT strftime('%Y-%m', date) AS month, COUNT(*) AS count
           FROM letters
           WHERE dept = ?
           GROUP BY month
           ORDER BY month ASC
           LIMIT 12`, [department]
        );

        // Metric 4: Overdue Letters (NEW)
        const overdueResult = await db.get(
          `SELECT COUNT(*) AS count
           FROM letters
           WHERE status = 'Overdue' AND dept = ?`, [department]
        );
        const overdueCount = overdueResult.count;

        // Metric 5: Stage-wise Pending Letters (NEW)
        const pendingByStage = await db.all(
          `SELECT stage, COUNT(*) AS count
           FROM letters
           WHERE status IN ('Pending', 'Overdue') AND dept = ?
           GROUP BY stage`, [department]
        );

        // (Metric 3 is not included as this API is correctly filtered by a single clerk's department)
        
        // Also get status totals for the pie chart
        const statusTotals = await db.all(
          `SELECT status, COUNT(*) AS count
           FROM letters
           WHERE dept = ?
           GROUP BY status`, [department]
        );

        res.json({
          department,
          typeTotals,
          monthlyTrend,
          overdueCount,
          pendingByStage,
          statusTotals
        });
      } catch (err) {
        console.error('Analysis endpoint error:', err);
        res.status(500).json({ message: 'Server error retrieving analysis data' });
      }
    });

    app.post('/api/autofill', verifyToken, upload.single('file'), async (req, res) => {
        if (req.user.role !== 'Clerk') return res.sendStatus(403);
        
        if (!req.file) return res.status(400).json({ message: "File upload is required for classification." });
        
        const { department } = req.user;
        const newId = `${department}${Date.now().toString().slice(-4)}`;
        const filePath = path.join('uploads', req.file.filename);
        const date = new Date().toISOString().split('T')[0];
        
        // Step 3: Initial save to DB (Status: ML_OCR, Stage: Clerk)
        // Note: Subject/Type are placeholders until LCA runs
        const letterData = {
            id: newId, subject: 'Scanning...', dept: department, type: 'Unknown', amount: 0, date,
            status: 'ML_OCR', stage: 'Clerk', filePath
        };
        await insertLetter(db, letterData);
        
        // --- MAS Integration Point ---
        console.log(`\n--- MAS TRIGGERED: CLASSIFICATION_REQUEST [ID: ${newId}] ---`);
        console.log(`*** Run 'python mas_engine/mas_workflow.py' to run LCA (Tesseract/LLM) ***`);
        
        res.status(202).json({ 
            message: 'File submitted. Awaiting classification results. Refreshing dashboard.',
            letterId: newId 
        });
    });
    
    // ----------------------------------------------------
    // PUT Letter: Clerk Final Submit or Role Action (Step 3 - Part 2 & Step 5)
    // ----------------------------------------------------
    app.put('/api/:id', verifyToken, upload.fields([{ name: 'signedFile' }, { name: 'chequeFile' }]), async (req, res) => {
        const { id } = req.params;
        const { action, remarks, subject, type, amount } = req.body; // action: 'forward', 'reject', or 'finalSubmit'
        const { role } = req.user;
        let letter = await getLetter(db, id);
        if (!letter) return res.status(404).json({ message: 'Letter not found' });

        if (action === 'finalSubmit' && role === 'Clerk') {
            // Step 3 - Part 2: Clerk confirms ML data and submits to pipeline
            // Update the letter with the Clerk's final data
            await db.run(
                `UPDATE letters SET subject = ?, type = ?, amount = ?, status = ?, remarks = ?, stage = ? WHERE id = ?`,
                [subject, type, amount, 'Submitted', 'Clerk final submission', 'Clerk', id]
            );
            console.log(`\n--- MAS TRIGGERED: FINAL_SUBMISSION [ID: ${id}] ---`);
            console.log(`*** Run 'python mas_engine/mas_workflow.py' to run PPA and Router ***`);
            return res.json({ message: 'Letter submitted to MAS pipeline.' });
        }
        
        if (!['Dean', 'Registrar', 'VC', 'Accounts'].includes(role)) return res.sendStatus(403);

        try {
            const signedFilePath = req.files?.signedFile ? path.join('uploads', req.files.signedFile[0].filename) : null;
            // The MAS Router will determine the final status/stage
            // We just record the action and tell the Router to pick it up
            await updateLetterApproval(db, id, role, remarks, signedFilePath);
            
            // Set temporary status to signal the Router Agent
            await updateLetterWorkflow(db, id, letter.stage, 'ActionTaken', `Action: ${action} by ${role}`, letter.approvalDeadline);

            // --- MAS Integration Point ---
            console.log(`\n--- MAS TRIGGERED: ACTION_TAKEN [ID: ${id}, Role: ${role}, Action: ${action}] ---`);
            console.log(`*** Run 'python mas_engine/mas_workflow.py' to run Router ***`);

            res.json({ message: `Action ${action} by ${role} recorded. MAS Router is processing.` });

        } catch (err) {
             console.error('Server error during PUT:', err);
             const message = err instanceof multer.MulterError ? err.message : 'Server error during action processing';
             res.status(500).json({ message });
            }
    });


    app.listen(port, () => console.log(`✅ Backend server ready at http://localhost:${port}`));
}

main();
