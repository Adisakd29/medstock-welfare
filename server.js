const express = require('express');
const { Pool } = require('pg');
const qrcode = require('qrcode');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'welfare2567';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ─── PostgreSQL CONNECTION ────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const query = (sql, params) => pool.query(sql, params);

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS medicines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      generic TEXT DEFAULT '',
      category TEXT DEFAULT 'อื่นๆ',
      unit TEXT DEFAULT 'เม็ด',
      qty INTEGER DEFAULT 0,
      min_qty INTEGER DEFAULT 10,
      exp_date TEXT DEFAULT '',
      lot TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS dispenses (
      id TEXT PRIMARY KEY,
      student_name TEXT NOT NULL,
      student_id TEXT DEFAULT '',
      class_room TEXT DEFAULT '',
      med_id TEXT NOT NULL,
      med_name TEXT NOT NULL,
      unit TEXT NOT NULL,
      qty INTEGER NOT NULL,
      symptom TEXT DEFAULT '',
      allergy TEXT DEFAULT 'ไม่แพ้ยา',
      dispenser TEXT DEFAULT 'นักเรียนแจ้งเอง',
      source TEXT DEFAULT 'qr',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS receives (
      id TEXT PRIMARY KEY,
      med_id TEXT NOT NULL,
      med_name TEXT NOT NULL,
      unit TEXT NOT NULL,
      qty INTEGER NOT NULL,
      lot TEXT DEFAULT '',
      exp_date TEXT DEFAULT '',
      source TEXT DEFAULT '',
      note TEXT DEFAULT '',
      received_date TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const { rows } = await query("SELECT value FROM settings WHERE key='org_name'");
  if (!rows.length) {
    await query("INSERT INTO settings VALUES ('org_name','สถานศึกษา') ON CONFLICT DO NOTHING");
    await query("INSERT INTO settings VALUES ('admin_name','ผู้ดูแลระบบ') ON CONFLICT DO NOTHING");
  }
  console.log('✅ PostgreSQL ready');
}

// ─── MIDDLEWARE ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await query('SELECT token FROM sessions WHERE token = $1', [token]);
  if (!rows.length) return res.status(401).json({ error: 'Invalid token' });
  next();
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function nowBKK() {
  return new Date().toLocaleString('sv-SE', {timeZone:'Asia/Bangkok'}).replace('T',' ');
}

// ─── AUTH ────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  const token = crypto.randomBytes(32).toString('hex');
  await query('INSERT INTO sessions (token) VALUES ($1)', [token]);
  await query(`DELETE FROM sessions WHERE token NOT IN (SELECT token FROM sessions ORDER BY created_at DESC LIMIT 100)`);
  res.json({ token });
});

app.post('/api/logout', requireAuth, async (req, res) => {
  await query('DELETE FROM sessions WHERE token = $1', [req.headers['x-auth-token']]);
  res.json({ ok: true });
});

// ─── SETTINGS ────────────────────────────────────────────────
app.get('/api/settings-public', async (req, res) => {
  const { rows } = await query("SELECT value FROM settings WHERE key='org_name'");
  res.json({ org_name: rows[0]?.value || '' });
});

app.get('/api/settings', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT key, value FROM settings');
  const s = {}; rows.forEach(r => s[r.key] = r.value);
  res.json(s);
});

app.put('/api/settings', requireAuth, async (req, res) => {
  for (const [k, v] of Object.entries(req.body))
    await query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, v]);
  res.json({ ok: true });
});

// ─── MEDICINES ───────────────────────────────────────────────
app.get('/api/medicines', async (req, res) => {
  const { rows } = await query('SELECT * FROM medicines ORDER BY name');
  res.json(rows);
});

app.post('/api/medicines', requireAuth, async (req, res) => {
  const { name, generic, category, unit, qty, min_qty, exp_date, lot, note } = req.body;
  if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อยา' });
  const id = uid();
  await query(
    `INSERT INTO medicines (id,name,generic,category,unit,qty,min_qty,exp_date,lot,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, name, generic||'', category||'อื่นๆ', unit||'เม็ด', parseInt(qty)||0, parseInt(min_qty)||10, exp_date||'', lot||'', note||'']
  );
  res.json({ id, ok: true });
});

app.put('/api/medicines/:id', requireAuth, async (req, res) => {
  const { name, generic, category, unit, qty, min_qty, exp_date, lot, note } = req.body;
  await query(
    `UPDATE medicines SET name=$1,generic=$2,category=$3,unit=$4,qty=$5,min_qty=$6,exp_date=$7,lot=$8,note=$9 WHERE id=$10`,
    [name, generic||'', category||'อื่นๆ', unit||'เม็ด', parseInt(qty)||0, parseInt(min_qty)||10, exp_date||'', lot||'', note||'', req.params.id]
  );
  res.json({ ok: true });
});

app.delete('/api/medicines/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM medicines WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ─── DISPENSES ───────────────────────────────────────────────
app.get('/api/dispenses', requireAuth, async (req, res) => {
  const { date, search } = req.query;
  let sql = 'SELECT * FROM dispenses WHERE 1=1';
  const params = [];
  if (date) { params.push(date); sql += ` AND created_at::date = $${params.length}`; }
  if (search) { params.push('%'+search+'%'); sql += ` AND (student_name ILIKE $${params.length} OR med_name ILIKE $${params.length})`; }
  sql += ' ORDER BY created_at DESC';
  const { rows } = await query(sql, params);
  res.json(rows);
});

app.post('/api/dispenses', async (req, res) => {
  const { student_name, student_id, class_room, med_id, qty, symptom, allergy, source } = req.body;
  if (!student_name || !med_id) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const { rows: medRows } = await query('SELECT * FROM medicines WHERE id = $1', [med_id]);
  const med = medRows[0];
  if (!med) return res.status(404).json({ error: 'ไม่พบรายการยา' });
  const amount = parseInt(qty) || 1;
  if (amount > med.qty) return res.status(400).json({ error: `ยาไม่เพียงพอ (คงเหลือ ${med.qty} ${med.unit})` });
  await query('UPDATE medicines SET qty = qty - $1 WHERE id = $2', [amount, med_id]);
  const id = uid();
  await query(
    `INSERT INTO dispenses (id,student_name,student_id,class_room,med_id,med_name,unit,qty,symptom,allergy,source,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, student_name, student_id||'', class_room||'', med_id, med.name, med.unit, amount, symptom||'', allergy||'ไม่แพ้ยา', source||'qr', nowBKK()]
  );
  res.json({ id, med_name: med.name, unit: med.unit, qty: amount, ok: true });
});

app.delete('/api/dispenses/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM dispenses WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ─── RECEIVES ────────────────────────────────────────────────
app.get('/api/receives', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT * FROM receives ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/receives', requireAuth, async (req, res) => {
  const { med_id, qty, lot, exp_date, source, note, received_date } = req.body;
  const { rows: medRows } = await query('SELECT * FROM medicines WHERE id = $1', [med_id]);
  const med = medRows[0];
  if (!med) return res.status(404).json({ error: 'ไม่พบรายการยา' });
  const amount = parseInt(qty) || 0;
  if (amount <= 0) return res.status(400).json({ error: 'กรุณาระบุจำนวน' });
  await query('UPDATE medicines SET qty = qty + $1 WHERE id = $2', [amount, med_id]);
  if (exp_date) await query('UPDATE medicines SET exp_date = $1 WHERE id = $2', [exp_date, med_id]);
  if (lot) await query('UPDATE medicines SET lot = $1 WHERE id = $2', [lot, med_id]);
  const id = uid();
  await query(
    `INSERT INTO receives (id,med_id,med_name,unit,qty,lot,exp_date,source,note,received_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, med_id, med.name, med.unit, amount, lot||'', exp_date||'', source||'', note||'', received_date||new Date().toISOString().slice(0,10)]
  );
  res.json({ ok: true });
});

app.delete('/api/receives/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM receives WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ─── QR CODE ─────────────────────────────────────────────────
app.get('/api/qr', requireAuth, async (req, res) => {
  const url = `${BASE_URL}/student`;
  try {
    const dataUrl = await qrcode.toDataURL(url, { width:400, margin:2, color:{ dark:'#1a1a18', light:'#ffffff' } });
    res.json({ qr: dataUrl, url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── ROUTING ─────────────────────────────────────────────────
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student', 'index.html')));
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/', (req, res) => res.redirect('/admin'));

// ─── START ───────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🏥 MedStock running on port ${PORT}`);
    console.log(`   Admin:   ${BASE_URL}/admin`);
    console.log(`   Student: ${BASE_URL}/student`);
  });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
