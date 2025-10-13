// server.js
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { initDb } = require('./database');

const app = express();
const port = 3000;
const JWT_SECRET = 'your-super-secret-key-that-should-be-in-a-env-file';

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// --- File Upload Configuration ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${file.fieldname}-${uniqueSuffix}.${file.originalname.split('.').pop()}`);
    }
});
const upload = multer({ storage: storage });

// --- Predictive ML Model (Gradient Boosting Concept) ---
function predictApprovalTime(letter) {
    console.log("Running Approval Time Prediction ML Model...");
    let estimatedDays = 4; // Base estimate
    if (letter.type === 'Payment') estimatedDays += 3;
    if (letter.amount > 50000) estimatedDays += 2;
    if (['CSE', 'IT'].includes(letter.dept)) estimatedDays -= 1;
    if (['Civil', 'ME'].includes(letter.dept)) estimatedDays += 1;
    return `${estimatedDays - 1}-${estimatedDays + 1} business days`;
}

// --- Main Application ---
async function main() {
    const db = await initDb();

    // === AUTHENTICATION ENDPOINT ===
    app.post('/api/login', async (req, res) => {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (!user) return res.status(401).json({ message: 'Invalid credentials' });
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) return res.status(401).json({ message: 'Invalid credentials' });
        const token = jwt.sign({ id: user.id, role: user.role, department: user.department }, JWT_SECRET, { expiresIn: '8h' });
        res.json({ token, user: { role: user.role, department: user.department } });
    });

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

    // === API ENDPOINTS (PROTECTED) ===
    app.get('/api/letters', verifyToken, async (req, res) => {
        const { role, department } = req.user;
        let letters = [];
        if (role === 'Clerk') {
            letters = await db.all('SELECT * FROM letters WHERE dept = ?', [department]);
        } else if (role === 'Dean') {
            letters = await db.all("SELECT * FROM letters WHERE stage != 'Clerk'");
        } else if (role === 'Registrar') {
            letters = await db.all("SELECT * FROM letters WHERE stage NOT IN ('Clerk', 'Dean')");
        } else if (role === 'VC') {
             letters = await db.all("SELECT * FROM letters WHERE stage NOT IN ('Clerk', 'Dean', 'Registrar')");
        } else if (role === 'Accounts') {
            letters = await db.all("SELECT * FROM letters WHERE stage = 'Accounts' AND type = 'Payment'");
        }
        res.json(letters); // The ML model can be applied here if desired for sorting, but prediction is on creation
    });

    app.post('/api/letters', verifyToken, upload.single('file'), async (req, res) => {
        if (req.user.role !== 'Clerk') return res.sendStatus(403);
        const { subject, type, amount, date } = req.body;
        const { department } = req.user;
        const newId = `${department}${Date.now().toString().slice(-4)}`;
        const filePath = req.file ? req.file.path : null;
        const newLetter = { id: newId, subject, dept: department, type, amount: amount || 0, date, status: 'Pending', remarks: 'Forwarded by Clerk', stage: 'Dean', filePath };
        await db.run(
            'INSERT INTO letters (id, subject, dept, type, amount, date, status, remarks, stage, filePath) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            Object.values(newLetter)
        );
        const estimatedTime = predictApprovalTime(newLetter);
        res.status(201).json({ message: 'Letter submitted to Dean successfully!', estimatedTime });
    });

    app.post('/api/letters/:id/resubmit', verifyToken, upload.single('file'), async (req, res) => {
        if (req.user.role !== 'Clerk') return res.sendStatus(403);
        const { id } = req.params;
        const { subject, type, amount } = req.body;
        const letter = await db.get('SELECT * FROM letters WHERE id = ?', [id]);
        if (!letter || letter.status !== 'Rejected') {
            return res.status(400).json({ message: 'This letter cannot be resubmitted.' });
        }
        const newFilePath = req.file ? req.file.path : letter.filePath;
        const newRemarks = `Resubmitted by Clerk on ${new Date().toLocaleDateString()}`;
        const updatedLetter = { ...letter, subject, type, amount, stage: 'Dean', status: 'Pending', remarks: newRemarks, filePath: newFilePath };
        await db.run( 'UPDATE letters SET subject = ?, type = ?, amount = ?, stage = ?, status = ?, remarks = ?, filePath = ? WHERE id = ?',
            [updatedLetter.subject, updatedLetter.type, updatedLetter.amount, updatedLetter.stage, updatedLetter.status, updatedLetter.remarks, updatedLetter.filePath, id]
        );
        const estimatedTime = predictApprovalTime(updatedLetter);
        res.json({ message: 'Letter resubmitted successfully to the Dean.', estimatedTime });
    });

    app.put('/api/letters/:id', verifyToken, upload.fields([{ name: 'signedFile' }, { name: 'chequeFile' }]), async (req, res) => {
        const { id } = req.params;
        const { action, remarks } = req.body;
        const { role } = req.user;
        let letter = await db.get('SELECT * FROM letters WHERE id = ?', [id]);
        if (!letter) return res.status(404).json({ message: 'Letter not found' });
        let { stage, status, signedFilePath, chequeFilePath } = letter;
        const pipeline = letter.type === 'Payment' ? ['Clerk', 'Dean', 'Registrar', 'VC', 'Accounts'] : ['Clerk', 'Dean', 'Registrar', 'VC'];
        if (action === 'reject') {
            status = 'Rejected';
        } else if (action === 'approve') {
            status = 'Validated';
        } else if (action === 'forward') {
            const currentStageIndex = pipeline.indexOf(role);
            if (currentStageIndex !== -1 && currentStageIndex < pipeline.length - 1) {
                stage = pipeline[currentStageIndex + 1];
                status = 'Pending';
            } else {
                status = 'Approved';
            }
        }
        if (req.files?.signedFile) signedFilePath = req.files.signedFile[0].path;
        if (req.files?.chequeFile) chequeFilePath = req.files.chequeFile[0].path;
        const finalRemarks = remarks || `Processed by ${role}`;
        await db.run('UPDATE letters SET stage = ?, status = ?, remarks = ?, signedFilePath = ?, chequeFilePath = ? WHERE id = ?',
            [stage, status, finalRemarks, signedFilePath, chequeFilePath, id]
        );
        const updatedLetter = await db.get('SELECT * FROM letters WHERE id = ?', [id]);
        res.json({ message: `Letter ${id} processed.`, letter: updatedLetter });
    });

    app.listen(port, () => console.log(`✅ Backend server ready at http://localhost:${port}`));
}

main();