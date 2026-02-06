// server.js - Real-time Monitor Edition
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = 3000;

const ADMIN_PASSWORD = "1234"; 
const activeSessions = {}; 
app.use(express.json());

// --- ตัวแปรเก็บจำนวนคนออนไลน์ (Connections) ---
let connectedClients = [];

// ----------------------------------------------------------------------
// 📡 1. ระบบ Real-time Stream (SSE) - หัวใจสำคัญของระบบนี้
// ส่งข้อมูล คนออนไลน์ + จำนวนสินค้า ไปหาหน้าเว็บทุกวินาที
// ----------------------------------------------------------------------
app.get('/api/stream', (req, res) => {
    // ตั้งค่า Header สำหรับ Streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // เพิ่มคนเข้าระบบ
    const clientId = Date.now();
    const newClient = { id: clientId, res };
    connectedClients.push(newClient);

    // ฟังก์ชันส่งข้อมูลล่าสุดให้คนนี้
    const sendUpdate = () => {
        const db1 = readDatabase('products.js');
        const db2 = readDatabase('products_part2.js');
        const totalProducts = db1.length + db2.length;
        
        const data = JSON.stringify({
            visitors: connectedClients.length, // จำนวนคนออนไลน์ปัจจุบัน
            products: totalProducts           // จำนวนสินค้าล่าสุด
        });
        res.write(`data: ${data}\n\n`);
    };

    // ส่งข้อมูลทันทีที่เชื่อมต่อ
    sendUpdate();

    // ส่งข้อมูลอัปเดตทุกๆ 2 วินาที (Heartbeat)
    const interval = setInterval(sendUpdate, 2000);

    // เมื่อคนปิดหน้าเว็บ -> ลบออกจากรายชื่อ
    req.on('close', () => {
        clearInterval(interval);
        connectedClients = connectedClients.filter(c => c.id !== clientId);
    });
});

// ----------------------------------------------------------------------
// ระบบความปลอดภัยเดิม (คงไว้ครบถ้วน)
// ----------------------------------------------------------------------
app.use((req, res, next) => {
    const forbidden = ['/server.js', '/tlst.js', '/package.json', '/.env', '/package-lock.json'];
    if (forbidden.includes(req.path)) return res.status(403).send("<h1>403 Forbidden</h1>");
    next();
});

app.use((req, res, next) => {
    const protectedFiles = ['/products.js', '/products_part2.js'];
    if (protectedFiles.includes(req.path)) {
        const referer = req.get('Referer');
        if (!referer || !referer.includes(req.get('host'))) {
            return res.status(403).send("<h1>403 Forbidden: Direct Access Denied</h1>");
        }
    }
    next();
});

app.use((req, res, next) => {
    const cookieHeader = req.headers.cookie;
    req.cookies = {};
    if (cookieHeader) {
        cookieHeader.split(';').forEach(c => {
            let [n, ...r] = c.split('=');
            if (n) req.cookies[n.trim()] = decodeURIComponent(r.join('=').trim());
        });
    }
    next();
});

const loginAttempts = {}; 
function checkRateLimit(ip) {
    if (!loginAttempts[ip]) return true;
    if (loginAttempts[ip].count >= 5 && (Date.now() - loginAttempts[ip].time < 600000)) return false;
    if (Date.now() - loginAttempts[ip].time > 600000) delete loginAttempts[ip];
    return true;
}

app.use((req, res, next) => {
    if (req.path === '/admin.html' || req.path === '/admin') {
        const token = req.cookies.auth_token;
        if (token && activeSessions[token]) next();
        else res.redirect('/login.html');
    } else {
        next();
    }
});

app.use(express.static(__dirname));

// --- API Login/Logout ---
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    const ip = req.ip;
    if (!checkRateLimit(ip)) return res.status(429).json({ message: "⛔ รหัสผิดเกินกำหนด! รอ 10 นาที" });
    if (password === ADMIN_PASSWORD) {
        delete loginAttempts[ip];
        const sessionToken = crypto.randomUUID(); 
        activeSessions[sessionToken] = { ip: ip, createdAt: Date.now() };
        res.setHeader('Set-Cookie', [`auth_token=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`]);
        res.json({ status: 'success' });
    } else {
        if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, time: Date.now() };
        loginAttempts[ip].count++;
        loginAttempts[ip].time = Date.now();
        res.status(401).json({ message: "❌ รหัสผิด!" });
    }
});

app.post('/api/logout', (req, res) => {
    const token = req.cookies.auth_token;
    if (token) delete activeSessions[token];
    res.setHeader('Set-Cookie', [`auth_token=; Path=/; HttpOnly; Max-Age=0`]);
    res.json({ status: 'success' });
});

// --- Database Logic (No-Eval) ---
function readDatabase(filename) {
    try {
        const filePath = path.join(__dirname, filename);
        if (!fs.existsSync(filePath)) return [];
        const content = fs.readFileSync(filePath, 'utf8');
        const start = content.indexOf('[');
        const end = content.lastIndexOf(']') + 1;
        if (start === -1 || end === 0) return [];
        return JSON.parse(content.substring(start, end));
    } catch (e) { return []; }
}

function saveDatabase(filename, dataArray) {
    try {
        const jsonContent = JSON.stringify(dataArray, null, 4);
        let fileTemplate = '';
        if (filename === 'products.js') fileTemplate = `const products = ${jsonContent};\ntry { if(typeof products !== 'undefined') console.log("DB1 Loaded: " + products.length); } catch (e) {}`;
        else fileTemplate = `const products_part2 = ${jsonContent};\ntry { if (typeof products !== 'undefined' && Array.isArray(products_part2)) { products.push(...products_part2); } } catch (e) {}`;
        fs.writeFileSync(path.join(__dirname, filename), fileTemplate, 'utf8');
        
        // **Trigger Update**: เมื่อมีการบันทึกไฟล์ ให้แจ้งทุกคนที่ออนไลน์อยู่ทันที (ไม่ต้องรอ 2 วิ)
        connectedClients.forEach(client => {
             // คำนวณใหม่เพื่อความแม่นยำ
             const db1 = readDatabase('products.js');
             const db2 = readDatabase('products_part2.js');
             const data = JSON.stringify({ visitors: connectedClients.length, products: db1.length + db2.length });
             client.res.write(`data: ${data}\n\n`);
        });

        return true;
    } catch (e) { return false; }
}

function isAuthenticated(req) {
    const token = req.cookies.auth_token;
    return token && activeSessions[token];
}

app.post('/api/add-product', (req, res) => {
    if (!isAuthenticated(req)) return res.status(403).send("Unauthorized");
    const newProduct = req.body;
    const db1 = readDatabase('products.js');
    const db2 = readDatabase('products_part2.js');
    let targetFile = (db1.length <= db2.length) ? 'products.js' : 'products_part2.js';
    let targetArray = (db1.length <= db2.length) ? db1 : db2;
    targetArray.push(newProduct);
    saveDatabase(targetFile, targetArray);
    res.json({ status: 'success' });
});

app.post('/api/delete-product', (req, res) => {
    if (!isAuthenticated(req)) return res.status(403).send("Unauthorized");
    const { id } = req.body;
    let db1 = readDatabase('products.js');
    let db2 = readDatabase('products_part2.js');
    let targetFile = '', targetArray = null;

    if (db1.some(p => p.id === id)) { targetFile = 'products.js'; targetArray = db1; }
    else if (db2.some(p => p.id === id)) { targetFile = 'products_part2.js'; targetArray = db2; }

    if (targetFile) {
        const idx = targetArray.findIndex(p => p.id === id);
        targetArray.splice(idx, 1);
        saveDatabase(targetFile, targetArray);
        return res.json({ status: 'success' });
    }
    res.status(404).send("Not found");
});

app.listen(PORT, () => {
    console.log(`------------------------------------------------`);
    console.log(`📡 REAL-TIME MONITOR: ACTIVE`);
    console.log(`👁️  Waiting for visitors...`);
    console.log(`------------------------------------------------`);
});