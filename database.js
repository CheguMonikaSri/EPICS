// database.js


const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const bcrypt = require('bcrypt');
const path = require('path');

// Use path.join to ensure the DB file is created in the same directory as this script.
const DB_PATH = path.join(__dirname, 'epics.db');

async function initDb() {
    try {
        const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT NOT NULL,
                department TEXT
            );

            CREATE TABLE IF NOT EXISTS letters (
                id TEXT PRIMARY KEY,
                subject TEXT NOT NULL,
                dept TEXT NOT NULL,
                type TEXT NOT NULL,
                amount INTEGER,
                date TEXT NOT NULL,
                status TEXT NOT NULL,
                remarks TEXT,
                stage TEXT NOT NULL,
                filePath TEXT,
                
                -- MAS Fields
                classification TEXT,
                priorityScore INTEGER,
                estimatedTime TEXT,
                approvalDeadline TEXT,
                
                -- Approver Fields
                signedFilePath TEXT,
                chequeFilePath TEXT,
                deanRemarks TEXT,
                deanApprovedDate TEXT,
                deanSignedPath TEXT,
                registrarRemarks TEXT,
                registrarApprovedDate TEXT,
                registrarSignedPath TEXT
            );
        `);

        const userCount = await db.get('SELECT COUNT(*) as count FROM users');
        if (userCount.count === 0) {
            console.log('Populating database with initial users...');
            const saltRounds = 10;
            const departments = ['CSE', 'IT', 'ECE', 'EEE', 'EIE', 'ME', 'Civil', 'MBA', 'MCA'];
            const usersToInsert = [
                { email: 'dean@siddhartha.com', role: 'Dean', password: 'dean@123' },
                { email: 'registrar@siddhartha.com', role: 'Registrar', password: 'registrar@123' },
                { email: 'vc@siddhartha.com', role: 'VC', password: 'vc@123' },
                { email: 'accounts@siddhartha.com', role: 'Accounts', password: 'accounts@123' }
            ];

            departments.forEach(dept => {
                const deptLower = dept.toLowerCase();
                usersToInsert.push({
                    email: `clerk@${deptLower}.com`,
                    role: 'Clerk',
                    department: dept,
                    password: `clerk@${deptLower}123`
                });
            });

            const stmt = await db.prepare('INSERT INTO users (email, password, role, department) VALUES (?, ?, ?, ?)');
            for (const user of usersToInsert) {
                const hashedPassword = await bcrypt.hash(user.password, saltRounds);
                await stmt.run(user.email, hashedPassword, user.role, user.department || null);
            }
            await stmt.finalize();
            console.log('Dummy users inserted.');
        }

        return db;
    } catch (error) {
        console.error("Database initialization failed:", error);
        throw error;
    }
}

/** Gets a single letter by ID. */
async function getLetter(db, id) {
    return db.get('SELECT * FROM letters WHERE id = ?', [id]);
}

/** Inserts a new letter (used by Clerk/JS Frontend). */
async function insertLetter(db, data) {
    const { id, subject, dept, type, amount, date, status, stage, filePath } = data;
    // Step 3: Clerk's initial input is saved before LCA/PPA run
    await db.run(
        `INSERT INTO letters (id, subject, dept, type, amount, date, status, remarks, stage, filePath, classification) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, subject, dept, type, amount || 0, date, status, 'Awaiting MAS analysis', stage, filePath, type]
    );
}

/** Updates the cognitive fields (used by PPA/LCA/Analysis Agents). */
async function updateLetterCognitiveData(db, id, priorityScore, estimatedTime, classification) {
    await db.run(
        `UPDATE letters SET priorityScore = ?, estimatedTime = ?, classification = ? WHERE id = ?`,
        [priorityScore, estimatedTime, classification, id]
    );
}

/** Updates the workflow fields (used by Router Agent). */
async function updateLetterWorkflow(db, id, stage, status, remarks, approvalDeadline) {
    await db.run(
        `UPDATE letters SET stage = ?, status = ?, remarks = ?, approvalDeadline = ? WHERE id = ?`,
        [stage, status, remarks, approvalDeadline, id]
    );
}

/** Updates role-specific approval fields (used by Role Agents). */
async function updateLetterApproval(db, id, role, remarks, signedPath) {
    const date = new Date().toISOString();
    let query = '';
    // Use the specific columns from your schema
    let params = [remarks, date, signedPath, id];

    if (role === 'Dean') {
        query = `UPDATE letters SET deanRemarks = ?, deanApprovedDate = ?, deanSignedPath = ? WHERE id = ?`;
    } else if (role === 'Registrar') {
        query = `UPDATE letters SET registrarRemarks = ?, registrarApprovedDate = ?, registrarSignedPath = ? WHERE id = ?`;
    } 
    // Add other roles like VC or Accounts if they have specific columns
    
    if (query) {
        await db.run(query, params);
    }
}

module.exports = { 
    initDb, 
    getLetter,
    insertLetter,
    updateLetterCognitiveData,
    updateLetterWorkflow,
    updateLetterApproval
};

// const sqlite3 = require('sqlite3').verbose();
// const { open } = require('sqlite');
// const bcrypt = require('bcrypt');
// const path = require('path'); // ADDED for robust path handling

// // --- Configuration ---
// // CRITICAL FIX: Use path.join(__dirname, ...) to ensure the DB file is created in the same directory as database.js
// const DB_PATH = path.join(__dirname, 'epics.db');

// // --- Initialization ---
// async function initDb() {
//     try {
//         // Use a persistent connection throughout the application lifecycle
//         const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

//         await db.exec(`
//             CREATE TABLE IF NOT EXISTS users (
//                 id INTEGER PRIMARY KEY AUTOINCREMENT,
//                 email TEXT UNIQUE NOT NULL,
//                 password TEXT NOT NULL,
//                 role TEXT NOT NULL,
//                 department TEXT
//             );

//             CREATE TABLE IF NOT EXISTS letters (
//                 id TEXT PRIMARY KEY,
//                 subject TEXT NOT NULL,
//                 dept TEXT NOT NULL,
//                 type TEXT NOT NULL,
//                 amount INTEGER,
//                 date TEXT NOT NULL,
//                 status TEXT NOT NULL,
//                 remarks TEXT,
//                 stage TEXT NOT NULL,
//                 filePath TEXT,
                
//                 -- MAS Fields (Step 3, 4, 6)
//                 classification TEXT,         -- Set by LCA (Payment/Permission)
//                 priorityScore INTEGER,       -- Set by PPA (0-100)
//                 estimatedTime TEXT,          -- Set by PPA
//                 approvalDeadline TEXT,       -- For two-day time limit tracking (Step 6)
                
//                 -- File Paths & Data from Approvers 
//                 signedFilePath TEXT,
//                 chequeFilePath TEXT,
                
//                 deanRemarks TEXT,
//                 deanApprovedDate TEXT,
//                 deanSignedPath TEXT,
                
//                 registrarRemarks TEXT,
//                 registrarApprovedDate TEXT,
//                 registrarSignedPath TEXT
//             );
//         `);

//         // Check and insert dummy users if the table is empty
//         const users = await db.all('SELECT * FROM users');
//         if (users.length === 0) {
//             console.log('Populating database with initial users...');
//             const saltRounds = 10;
//             const departments = ['CSE', 'IT', 'ECE', 'EEE', 'EIE', 'ME', 'Civil', 'MBA', 'MCA'];

//             const userCredentials = [];
//             // Higher Ups
//             const higherUps = [
//                 { email: 'dean@siddhartha.com', role: 'Dean', department: null, password: 'dean@123' },
//                 { email: 'registrar@siddhartha.com', role: 'Registrar', department: null, password: 'registrar@123' },
//                 { email: 'vc@siddhartha.com', role: 'VC', department: null, password: 'vc@123' },
//                 { email: 'accounts@siddhartha.com', role: 'Accounts', department: null, password: 'accounts@123' }
//             ];
//             userCredentials.push(...higherUps);

//             // Clerks
//             departments.forEach(dept => {
//                 const deptLower = dept.toLowerCase();
//                 userCredentials.push({
//                     email: `clerk@${deptLower}.com`,
//                     role: 'Clerk',
//                     department: dept,
//                     password: `clerk@${deptLower}123`
//                 });
//             });

//             const userStmt = await db.prepare('INSERT INTO users (email, password, role, department) VALUES (?, ?, ?, ?)');
//             for (const user of userCredentials) {
//                 const hashedPassword = await bcrypt.hash(user.password, saltRounds);
//                 await userStmt.run(user.email, hashedPassword, user.role, user.department);
//             }
//             await userStmt.finalize();
//             console.log('Dummy users inserted.');
//         }

//         return db;
//     } catch (error) {
//         console.error("Database initialization failed:", error);
//         throw error;
//     }
// }

// // Export the path so the Python side knows where to find the database
// const getDbPath = () => DB_PATH;

// // --- EXPOSED ATOMIC FUNCTIONS (for both JS and conceptual Python Agents) ---

// /** Gets a single letter by ID. */
// async function getLetter(db, id) {
//     return db.get('SELECT * FROM letters WHERE id = ?', [id]);
// }

// /** Inserts a new letter (used by Clerk/JS Frontend). */
// async function insertLetter(db, data) {
//     const { id, subject, dept, type, amount, date, status, stage, filePath } = data;
//     // Step 3: Clerk's initial input is saved before LCA/PPA run
//     await db.run(
//         `INSERT INTO letters (id, subject, dept, type, amount, date, status, remarks, stage, filePath, priorityScore, estimatedTime, classification, approvalDeadline) 
//          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
//         [id, subject, dept, type, amount || 0, date, status, 'Awaiting processing', stage, filePath, null, null, type, null]
//     );
// }

// /** Updates the cognitive fields (used by PPA/LCA/Analysis Agents). */
// async function updateLetterCognitiveData(db, id, priorityScore, estimatedTime, classification) {
//     await db.run(
//         `UPDATE letters SET priorityScore = ?, estimatedTime = ?, classification = ? WHERE id = ?`,
//         [priorityScore, estimatedTime, classification, id]
//     );
// }

// /** Updates the workflow fields (used by Router Agent). */
// async function updateLetterWorkflow(db, id, stage, status, remarks, approvalDeadline) {
//     await db.run(
//         `UPDATE letters SET stage = ?, status = ?, remarks = ?, approvalDeadline = ? WHERE id = ?`,
//         [stage, status, remarks, approvalDeadline, id]
//     );
// }

// /** Updates role-specific approval fields (used by Role Agents). */
// async function updateLetterApproval(db, id, role, remarks, signedPath) {
//     const date = new Date().toISOString();
//     let query = '';
//     let params = [remarks, date, signedPath, id];

//     if (role === 'Dean') {
//         query = `UPDATE letters SET deanRemarks = ?, deanApprovedDate = ?, deanSignedPath = ? WHERE id = ?`;
//     } else if (role === 'Registrar') {
//         query = `UPDATE letters SET registrarRemarks = ?, registrarApprovedDate = ?, registrarSignedPath = ? WHERE id = ?`;
//     } 
//     // VC and Accounts only update status/remarks which is handled by the Router/Workflow update
    
//     if (query) {
//         await db.run(query, params);
//     }
// }

// module.exports = { 
//     initDb, 
//     getDbPath,
//     getLetter,
//     insertLetter,
//     updateLetterCognitiveData,
//     updateLetterWorkflow,
//     updateLetterApproval
// };
