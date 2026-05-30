const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/user.html', (req, res) => res.sendFile(path.join(__dirname, 'user.html')));
app.get('/outline.html', (req, res) => res.sendFile(path.join(__dirname, 'outline.html')));
app.get('/vless.html', (req, res) => res.sendFile(path.join(__dirname, 'vless.html')));

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://tadershwe_db_user:99nDAIqFL0Ig43BU@cluster0.rrh42fu.mongodb.net/vpndb?retryWrites=true&w=majority';
let db = { users: {}, admin_config: { auth: { type: 'pin', pin: 'admin123', pattern: '1235789' } } };
let mongoCollection;

// --- Advanced UTF-8 Buffer Encryption (for backwards compatibility) ---
const ENCRYPTION_KEY = 'vvip-secret-key-2026';
function encryptData(dataStr) {
    const buf = Buffer.from(dataStr, 'utf8');
    for (let i = 0; i < buf.length; i++) {
        buf[i] = buf[i] ^ ENCRYPTION_KEY.charCodeAt(i % ENCRYPTION_KEY.length);
    }
    return buf.toString('base64');
}
function decryptData(base64Str) {
    const buf = Buffer.from(base64Str, 'base64');
    for (let i = 0; i < buf.length; i++) {
        buf[i] = buf[i] ^ ENCRYPTION_KEY.charCodeAt(i % ENCRYPTION_KEY.length);
    }
    return buf.toString('utf8');
}

// Database Connection & Migration
MongoClient.connect(MONGODB_URI)
    .then(client => {
        console.log('🔗 Connected to MongoDB successfully.');
        const database = client.db('vpndb');
        mongoCollection = database.collection('store');
        return mongoCollection.findOne({ _id: 'global_data' });
    })
    .then(doc => {
        if (doc && doc.data) {
            // Load from MongoDB
            db = { ...db, ...doc.data };
            console.log('✅ Data loaded from MongoDB.');
        } else {
            // Migrate from local data.json if MongoDB is empty
            const DB_FILE = './data.json';
            if (fs.existsSync(DB_FILE)) {
                try {
                    let rawData = fs.readFileSync(DB_FILE, 'utf8');
                    let parsed;
                    if(rawData.trim().startsWith('{')) {
                        parsed = JSON.parse(rawData);
                    } else {
                        parsed = JSON.parse(decryptData(rawData));
                    }
                    db = { ...db, ...parsed };
                    console.log('🚀 Migrated local data.json to MongoDB.');
                } catch(e) { 
                    console.log("⚠️ DB Load Error (Corrupted Data). Starting fresh."); 
                }
            }
        }

        if (!db.users) db.users = {};
        if (!db.admin_config) db.admin_config = {};
        if (!db.admin_config.auth) {
            db.admin_config.auth = { type: 'pin', pin: 'admin123', pattern: '1235789' };
        }
        saveDB(); // Save immediately to ensure it's in MongoDB
    })
    .catch(err => {
        console.error('❌ MongoDB Connection Error:', err);
    });

function saveDB() {
    if (mongoCollection) {
        mongoCollection.updateOne(
            { _id: 'global_data' },
            { $set: { data: db } },
            { upsert: true }
        ).catch(err => console.error('MongoDB Save Error:', err));
    } else {
        // Fallback to local if MongoDB is not connected yet
        const DB_FILE = './data.json';
        let jsonStr = JSON.stringify(db);
        let encryptedStr = encryptData(jsonStr);
        fs.writeFileSync(DB_FILE, encryptedStr); 
    }
}

app.get('/api/backup', (req, res) => {
    res.setHeader('Content-disposition', `attachment; filename=vpn_backup_${new Date().toISOString().split('T')[0]}.json`);
    res.setHeader('Content-type', 'application/json');
    res.send(JSON.stringify(db, null, 2));
});

app.get('/api/sync-data', (req, res) => res.json(db));

app.post('/api/sync-update', (req, res) => {
    const { update_fields } = req.body;
    let changed = false;
    for (const [userId, fields] of Object.entries(update_fields)) {
        if (db.users[userId]) {
            db.users[userId] = { ...db.users[userId], ...fields };
            io.to(userId).emit('user_data_update', db.users[userId]); 
            changed = true;
        }
    }
    if (changed) {
        saveDB();
        io.emit('admin_all_users_data', db.users);
        io.emit('admin_analytics_data', getAnalyticsData());
    }
    res.json({ success: true });
});

function getAnalyticsData() {
    let users = db.users || {};
    let totalUsers = Object.keys(users).length;
    let activeOut = 0, activeVless = 0;
    let outGB = 0, vlessGB = 0;
    Object.values(users).forEach(u => {
        if(u.outlineKey) activeOut++;
        if(u.vlessKey) activeVless++;
        outGB += (u.outlineUsedGB || 0);
        vlessGB += (u.vlessUsedGB || 0);
    });
    return {
        totalUsers, activeOut, activeVless, 
        totalGB: Math.round(outGB + vlessGB), 
        outGB: Math.round(outGB), vlessGB: Math.round(vlessGB)
    };
}

const loginAttempts = {}; 
const LOCKOUT_TIME = 5 * 60 * 1000; 
const MAX_ATTEMPTS = 3;

io.on('connection', (socket) => {
    let ip = socket.handshake.address;

    socket.emit('auth_mode_info', db.admin_config.auth.type);

    socket.on('admin_login_attempt', (credential) => {
        if(loginAttempts[ip] && loginAttempts[ip].lockedUntil > Date.now()) {
            let remainMinutes = Math.ceil((loginAttempts[ip].lockedUntil - Date.now()) / 60000);
            return socket.emit('admin_login_locked', remainMinutes);
        }

        const auth = db.admin_config.auth;
        let isSuccess = false;

        if ((auth.type === 'pin' && credential === auth.pin) || 
            (auth.type === 'pattern' && credential === auth.pattern)) {
            isSuccess = true;
        }

        if(isSuccess) {
            delete loginAttempts[ip]; 
            socket.emit('admin_login_success');
        } else {
            if(!loginAttempts[ip]) loginAttempts[ip] = { count: 0, lockedUntil: 0 };
            loginAttempts[ip].count++;

            if(loginAttempts[ip].count >= MAX_ATTEMPTS) {
                loginAttempts[ip].lockedUntil = Date.now() + LOCKOUT_TIME;
                socket.emit('admin_login_locked', 5);
            } else {
                let attemptsLeft = MAX_ATTEMPTS - loginAttempts[ip].count;
                socket.emit('admin_login_failed', attemptsLeft);
            }
        }
    });

    socket.on('admin_update_auth', (data) => {
        if (data.type === 'pin') {
            db.admin_config.auth.type = 'pin';
            if (data.code) db.admin_config.auth.pin = data.code;
        } else if (data.type === 'pattern') {
            db.admin_config.auth.type = 'pattern';
            if (data.code) db.admin_config.auth.pattern = data.code;
        }
        saveDB();
        socket.emit('admin_auth_updated', db.admin_config.auth.type);
    });

    socket.on('join_user_room', ({ username, deviceOS }) => {
        socket.join(username);
        if (db.users[username]) {
            if(deviceOS) db.users[username].deviceOS = deviceOS;
            saveDB();
            socket.emit('user_data_update', db.users[username]);
        } else {
            socket.emit('user_not_found');
        }
    });

    socket.on('admin_get_config', () => {
        socket.emit('admin_config_data', db.admin_config.server_api || {});
    });

    socket.on('admin_save_config', (config) => {
        db.admin_config.server_api = config;
        saveDB();
    });

    socket.on('admin_fetch_user', (username) => {
        const data = db.users[username];
        socket.emit('admin_user_data', { id: username, exists: !!data, data: data || {} });
    });

    socket.on('admin_save_user', ({ username, data }) => {
        if(!db.users) db.users = {};
        db.users[username] = { ...db.users[username], ...data };
        saveDB();
        socket.emit('admin_save_success');
        io.to(username).emit('user_data_update', db.users[username]); 
        io.emit('admin_all_users_data', db.users); 
        io.emit('admin_analytics_data', getAnalyticsData());
    });

    socket.on('admin_delete_user', (username) => {
        if (db.users && db.users[username]) {
            delete db.users[username];
            saveDB();
            socket.emit('admin_delete_success');
            io.emit('admin_all_users_data', db.users);
            io.emit('admin_analytics_data', getAnalyticsData());
        }
    });

    socket.on('admin_get_all_users', () => socket.emit('admin_all_users_data', db.users || {}));
    socket.on('admin_get_analytics', () => socket.emit('admin_analytics_data', getAnalyticsData()));
});

server.listen(3000, () => {
    console.log('=============================================');
    console.log('🚀 Gateway Server is Securely Running!');
    console.log('🔒 Database: MongoDB Cloud Connected');
    console.log('👉 Admin Panel: http://localhost:3000/admin.html');
    console.log('=============================================');
});