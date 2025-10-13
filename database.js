// database.js
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const bcrypt = require('bcrypt');

async function initDb() {
    try {
        const db = await open({ filename: './epics.db', driver: sqlite3.Database });

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
                signedFilePath TEXT,
                chequeFilePath TEXT
            );
        `);

        const users = await db.all('SELECT * FROM users');
        if (users.length === 0) {
            console.log('Populating database with initial users and letters...');
            const saltRounds = 10;
            const departments = ['CSE', 'IT', 'ECE', 'EEE', 'EIE', 'ME', 'Civil', 'MBA', 'MCA'];

            const userCredentials = [];

            // Define higher-up users
            const higherUps = [
                { email: 'dean@siddhartha.com', role: 'Dean', department: null, password: 'dean@123' },
                { email: 'registrar@siddhartha.com', role: 'Registrar', department: null, password: 'registrar@123' },
                { email: 'vc@siddhartha.com', role: 'VC', department: null, password: 'vc@123' },
                { email: 'accounts@siddhartha.com', role: 'Accounts', department: null, password: 'accounts@123' }
            ];
            userCredentials.push(...higherUps);

            // Define clerk users for each department
            departments.forEach(dept => {
                const deptLower = dept.toLowerCase();
                userCredentials.push({
                    email: `clerk@${deptLower}.com`,
                    role: 'Clerk',
                    department: dept,
                    password: `clerk@${deptLower}123`
                });
            });
            
            // Insert users with their unique hashed passwords
            const userStmt = await db.prepare('INSERT INTO users (email, password, role, department) VALUES (?, ?, ?, ?)');
            for (const user of userCredentials) {
                const hashedPassword = await bcrypt.hash(user.password, saltRounds);
                await userStmt.run(user.email, hashedPassword, user.role, user.department);
            }
            await userStmt.finalize();
            console.log('Dummy users inserted with new username format and unique passwords.');


            // Insert dummy letters
            const letterInserts = [
                { id: 'CSE001', subject: 'Guest lecture permission', dept: 'CSE', type: 'Permission', amount: 0, date: '2025-09-09', status: 'Pending', remarks: 'Awaiting approval', stage: 'Clerk', filePath: null, signedFilePath: null, chequeFilePath: null },
                { id: 'L011', subject: 'Request for new server equipment', dept: 'CSE', type: 'Payment', amount: 75000, date: '2025-09-10', status: 'Pending', remarks: 'Forwarded by Clerk', stage: 'Dean', filePath: null, signedFilePath: null, chequeFilePath: null },
                { id: 'L013', subject: 'Approval for student hackathon', dept: 'IT', type: 'Permission', amount: 0, date: '2025-09-08', status: 'Pending', remarks: 'Forwarded by Clerk', stage: 'Dean', filePath: null, signedFilePath: null, chequeFilePath: null },
                { id: 'L021', subject: 'Guest lecture arrangement', dept: 'MBA', type: 'Permission', amount: 0, date: '2025-09-12', status: 'Pending', remarks: 'Forwarded by Dean', stage: 'Registrar', filePath: null, signedFilePath: null, chequeFilePath: null },
                { id: 'L032', subject: 'Sanction for Civil dept site visit', dept: 'Civil', type: 'Permission', amount: 0, date: '2025-09-11', status: 'Pending', remarks: 'Forwarded by Registrar', stage: 'VC', filePath: null, signedFilePath: null, chequeFilePath: null },
                { id: 'L045', subject: 'Purchase of new lab components', dept: 'EIE', type: 'Payment', amount: 32000, date: '2025-09-11', status: 'Pending', remarks: 'Forwarded by VC', stage: 'Accounts', filePath: null, signedFilePath: null, chequeFilePath: null }
            ];

            const letterStmt = await db.prepare('INSERT INTO letters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            for (const letter of letterInserts) {
                await letterStmt.run(Object.values(letter));
            }
            await letterStmt.finalize();
            console.log('Dummy letters inserted.');
        }
        return db;
    } catch (error) {
        console.error("Database initialization failed:", error);
    }
}

module.exports = { initDb };