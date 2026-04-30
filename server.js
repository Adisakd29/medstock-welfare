const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const qrcode = require('qrcode');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'welfare2567';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const dbPath = path.join(__dirname, 'db', 'medstock.db');
const db = new sqlite3.Database(dbPath);

const run = (sql, p=[]) => new Promise((res,rej) => db.run(sql, p, function(e){ e?rej(e):res(this); }));
const get = (sql, p=[]) => new Promise((res,rej) => db.get(sql, p, (e,r) => e?rej(e):res(r)));
const all = (sql, p=[]) => new Promise((res,rej) => db.all(sql, p, (e,r) => e?rej(e):res(r)));

async function initDB() {
  await run('PRAGMA journal_mode=WAL');
  await run(`CREATE TABLE IF NOT EXISTS medicines (id TEXT PRIMARY KEY, name TEXT NOT NULL, generic TEXT DEFAULT '', category TEXT DEFAULT 'อื่นๆ', unit TEXT DEFAULT 'เม็ด', qty INTEGER DEFAULT 0, min_qty INTEGER DEFAULT 10, exp_date TEXT DEFAULT '', lot TEXT DEFAULT '', note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`);
  await run(`CREATE TABLE IF NOT EXISTS dispenses (id TEXT PRIMARY KEY, student_name TEXT NOT NULL, student_id TEXT DEFAULT '', class_room TEXT DEFAULT '', med_id TEXT NOT NULL, med_name TEXT NOT NULL, unit TEXT NOT NULL, qty INTEGER NOT NULL, symptom TEXT DEFAULT '', dispenser TEXT DEFAULT 'นักเรียนแจ้งเอง', source TEXT DEFAULT 'qr', created_at TEXT DEFAULT (datetime('now','localtime')))`);
  await run(`CREATE TABLE IF NOT EXISTS receives (id TEXT PRIMARY KEY, med_id TEXT NOT NULL, med_name TEXT NOT NULL, unit TEXT NOT NULL, qty INTEGER NOT NULL, lot TEXT DEFAULT '', exp_date TEXT DEFAULT '', source TEXT DEFAULT '', note TEXT DEFAULT '', received_date TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`);
  await run(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now','localtime')))`);
  await run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  const org = await get("SELECT value FROM settings WHERE key='org_name'");
  if (!org) {
    await run("INSERT OR IGNORE INTO settings VALUES ('org_name','สถานศึกษา')");
    await run("INSERT OR IGNORE INTO settings VALUES ('admin_name','ผู้ดูแลระบบ')");
  }
  console.log('Database ready');
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = await get('SELECT token FROM sessions WHERE token = ?', [token]).catch(()=>null);
  if (!session) return res.status(401).json({ error: 'Invalid token' });
  next();
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

app.post('/api/login', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  const token = crypto.randomBytes(32).toString('hex');
  await run('INSERT INTO sessions (token) VALUES (?)', [token]);
  res.json({ token });
});

app.post('/api/logout', requireAuth, async (req, res) => {
  await run('DELETE FROM sessions WHERE token = ?', [req.headers['x-auth-token']]);
  res.json({ ok: true });
});

app.get('/api/settings-public', async (req, res) => {
  const org = await get("SELECT value FROM settings WHERE key='org_name'");
  res.json({ org_name: org ? org.value : '' });
});

app.get('/api/settings', requireAuth, async (req, res) => {
  const rows = await all('SELECT key, value FROM settings');
  const s = {}; rows.forEach(r => s[r.key] = r.value);
  res.json(s);
});

app.put('/api/settings', requireAuth, async (req, res) => {
  for (const [k, v] of Object.entries(req.body))
    await run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, v]);
  res.json({ ok: true });
});

app.get('/api/medicines', async (req, res) => {
  res.json(await all('SELECT * FROM medicines ORDER BY name'));
});

app.post('/api/medicines', requireAuth, async (req, res) => {
  const { name, generic, category, unit, qty, min_qty, exp_date, lot, note } = req.body;
  if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อยา' });
  const id = uid();
  await run(`INSERT INTO medicines (id,name,generic,category,unit,qty,min_qty,exp_date,lot,note) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, name, generic||'', category||'อื่นๆ', unit||'เม็ด', parseInt(qty)||0, parseInt(min_qty)||10, exp_date||'', lot||'', note||'']);
  res.json({ id, ok: true });
});

app.put('/api/medicines/:id', requireAuth, async (req, res) => {
  const { name, generic, category, unit, qty, min_qty, exp_date, lot, note } = req.body;
  await run(`UPDATE medicines SET name=?,generic=?,category=?,unit=?,qty=?,min_qty=?,exp_date=?,lot=?,note=? WHERE id=?`,
    [name, generic||'', category||'อื่นๆ', unit||'เม็ด', parseInt(qty)||0, parseInt(min_qty)||10, exp_date||'', lot||'', note||'', req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/medicines/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM medicines WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/dispenses', requireAuth, async (req, res) => {
  const { date, search } = req.query;
  let q = 'SELECT * FROM dispenses WHERE 1=1'; const params = [];
  if (date) { q += ' AND created_at LIKE ?'; params.push(date+'%'); }
  if (search) { q += ' AND (student_name LIKE ? OR med_name LIKE ?)'; params.push('%'+search+'%','%'+search+'%'); }
  res.json(await all(q+' ORDER BY created_at DESC', params));
});

app.post('/api/dispenses', async (req, res) => {
  const { student_name, student_id, class_room, med_id, qty, symptom, source } = req.body;
  if (!student_name || !med_id) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const med = await get('SELECT * FROM medicines WHERE id = ?', [med_id]);
  if (!med) return res.status(404).json({ error: 'ไม่พบรายการยา' });
  const amount = parseInt(qty) || 1;
  if (amount > med.qty) return res.status(400).json({ error: `ยาไม่เพียงพอ (คงเหลือ ${med.qty} ${med.unit})` });
  await run('UPDATE medicines SET qty = qty - ? WHERE id = ?', [amount, med_id]);
  const id = uid();
  await run(`INSERT INTO dispenses (id,student_name,student_id,class_room,med_id,med_name,unit,qty,symptom,source) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, student_name, student_id||'', class_room||'', med_id, med.name, med.unit, amount, symptom||'', source||'qr']);
  res.json({ id, med_name: med.name, unit: med.unit, qty: amount, ok: true });
});

app.delete('/api/dispenses/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM dispenses WHERE id = ?', [req.params.id]); res.json({ ok: true });
});

app.get('/api/receives', requireAuth, async (req, res) => {
  res.json(await all('SELECT * FROM receives ORDER BY created_at DESC'));
});

app.post('/api/receives', requireAuth, async (req, res) => {
  const { med_id, qty, lot, exp_date, source, note, received_date } = req.body;
  const med = await get('SELECT * FROM medicines WHERE id = ?', [med_id]);
  if (!med) return res.status(404).json({ error: 'ไม่พบรายการยา' });
  const amount = parseInt(qty) || 0;
  if (amount <= 0) return res.status(400).json({ error: 'กรุณาระบุจำนวน' });
  await run('UPDATE medicines SET qty = qty + ? WHERE id = ?', [amount, med_id]);
  if (exp_date) await run('UPDATE medicines SET exp_date = ? WHERE id = ?', [exp_date, med_id]);
  if (lot) await run('UPDATE medicines SET lot = ? WHERE id = ?', [lot, med_id]);
  const id = uid();
  await run(`INSERT INTO receives (id,med_id,med_name,unit,qty,lot,exp_date,source,note,received_date) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, med_id, med.name, med.unit, amount, lot||'', exp_date||'', source||'', note||'', received_date||new Date().toISOString().slice(0,10)]);
  res.json({ ok: true });
});

app.delete('/api/receives/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM receives WHERE id = ?', [req.params.id]); res.json({ ok: true });
});

app.get('/api/qr', requireAuth, async (req, res) => {
  const url = `${BASE_URL}/student`;
  try {
    const dataUrl = await qrcode.toDataURL(url, { width:400, margin:2, color:{ dark:'#1a1a18', light:'#ffffff' } });
    res.json({ qr: dataUrl, url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student', 'index.html')));
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/', (req, res) => res.redirect('/admin'));

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`MedStock running on ${BASE_URL}`);
    console.log(`Admin: ${BASE_URL}/admin  |  Student: ${BASE_URL}/student`);
    console.log(`Password: ${ADMIN_PASSWORD}`);
  });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
