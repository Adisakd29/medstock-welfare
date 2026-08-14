const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const qrcode = require('qrcode');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'welfare2567';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const dbPath = path.join('/app/db', 'medstock.db');
const db = new sqlite3.Database(dbPath);

const run = (sql, p=[]) => new Promise((res,rej) => db.run(sql, p, function(e){ e?rej(e):res(this); }));
const get = (sql, p=[]) => new Promise((res,rej) => db.get(sql, p, (e,r) => e?rej(e):res(r)));
const all = (sql, p=[]) => new Promise((res,rej) => db.all(sql, p, (e,r) => e?rej(e):res(r)));

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function nowBKK() { return new Date().toLocaleString('sv-SE', {timeZone:'Asia/Bangkok'}).replace('T',' '); }

async function initDB() {
  await run('PRAGMA journal_mode=WAL');
  await run(`CREATE TABLE IF NOT EXISTS medicines (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, generic TEXT DEFAULT '',
    category TEXT DEFAULT 'อื่นๆ', unit TEXT DEFAULT 'เม็ด',
    qty INTEGER DEFAULT 0, min_qty INTEGER DEFAULT 10,
    exp_date TEXT DEFAULT '', lot TEXT DEFAULT '', note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')))`);
  await run(`CREATE TABLE IF NOT EXISTS dispenses (
    id TEXT PRIMARY KEY, student_name TEXT NOT NULL, student_id TEXT DEFAULT '',
    class_room TEXT DEFAULT '', med_id TEXT NOT NULL, med_name TEXT NOT NULL,
    unit TEXT NOT NULL, qty INTEGER NOT NULL, symptom TEXT DEFAULT '',
    allergy TEXT DEFAULT 'ไม่แพ้ยา', dispenser TEXT DEFAULT 'นักเรียนแจ้งเอง',
    source TEXT DEFAULT 'qr', note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`);
  await run(`CREATE TABLE IF NOT EXISTS receives (
    id TEXT PRIMARY KEY, med_id TEXT NOT NULL, med_name TEXT NOT NULL,
    unit TEXT NOT NULL, qty INTEGER NOT NULL, lot TEXT DEFAULT '',
    exp_date TEXT DEFAULT '', source TEXT DEFAULT '', note TEXT DEFAULT '',
    received_date TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`);
  await run(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now','localtime')))`);
  await run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS requisitions (
    id TEXT PRIMARY KEY, teacher TEXT NOT NULL, dept TEXT DEFAULT '',
    med_id TEXT NOT NULL, med_name TEXT NOT NULL, unit TEXT NOT NULL,
    qty INTEGER NOT NULL, reason TEXT DEFAULT '', status TEXT DEFAULT 'รออนุมัติ',
    note TEXT DEFAULT '', source TEXT DEFAULT 'qr',
    processed_at TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`);

  await run(`CREATE TABLE IF NOT EXISTS students (
    sid TEXT PRIMARY KEY, prefix TEXT DEFAULT '', fname TEXT NOT NULL,
    lname TEXT DEFAULT '', level TEXT NOT NULL, room TEXT NOT NULL,
    dept TEXT DEFAULT '')`);
  await run(`CREATE TABLE IF NOT EXISTS screenings (
    id TEXT PRIMARY KEY, sid TEXT NOT NULL, student_name TEXT NOT NULL,
    level TEXT NOT NULL, room TEXT NOT NULL, dept TEXT DEFAULT '',
    weight REAL, height REAL, bmi REAL,
    congenital TEXT DEFAULT 'ไม่มี', drug_allergy TEXT DEFAULT 'ไม่มี',
    food_allergy TEXT DEFAULT 'ไม่มี', current_meds TEXT DEFAULT 'ไม่มี',
    symptoms TEXT DEFAULT '', vision TEXT DEFAULT 'ปกติ', hearing TEXT DEFAULT 'ปกติ',
    dental TEXT DEFAULT 'ปกติ', blood_type TEXT DEFAULT '',
    emergency_name TEXT DEFAULT '', emergency_phone TEXT DEFAULT '',
    note TEXT DEFAULT '', term TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')))`);
  await run(`CREATE INDEX IF NOT EXISTS idx_students_room ON students(level, room)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_screen_room ON screenings(level, room)`);

  // เพิ่ม column ที่อาจไม่มีใน database เก่า (ไม่ error ถ้ามีอยู่แล้ว)
  const alterCmds = [
    "ALTER TABLE dispenses ADD COLUMN note TEXT DEFAULT ''",
    "ALTER TABLE dispenses ADD COLUMN allergy TEXT DEFAULT 'ไม่แพ้ยา'",
    "ALTER TABLE requisitions ADD COLUMN note TEXT DEFAULT ''",
    "ALTER TABLE requisitions ADD COLUMN processed_at TEXT DEFAULT ''",
    "ALTER TABLE students ADD COLUMN photo TEXT DEFAULT ''",
    "ALTER TABLE students ADD COLUMN phone TEXT DEFAULT ''",
    "ALTER TABLE students ADD COLUMN note TEXT DEFAULT ''",
  ];
  for (const cmd of alterCmds) {
    await run(cmd).catch(() => {});
  }

  const org = await get("SELECT value FROM settings WHERE key='org_name'");
  if (!org) {
    await run("INSERT OR IGNORE INTO settings VALUES ('org_name','สถานศึกษา')");
    await run("INSERT OR IGNORE INTO settings VALUES ('admin_name','ผู้ดูแลระบบ')");
  }

  // นำเข้ารายชื่อนักเรียนครั้งแรก (ครั้งเดียว)
  const scount = await get('SELECT COUNT(*) as n FROM students').catch(()=>({n:0}));
  if (!scount || scount.n === 0) {
    try {
      const seedPath = path.join(__dirname, 'data', 'students.json');
      const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      await run('BEGIN TRANSACTION');
      for (const s of seed.students) {
        await run('INSERT OR IGNORE INTO students (sid,prefix,fname,lname,level,room,dept) VALUES (?,?,?,?,?,?,?)',
          [s.sid, s.prefix||'', s.fname, s.lname||'', s.level, s.room, s.dept||'']);
      }
      await run('COMMIT');
      console.log('✅ นำเข้ารายชื่อนักเรียน ' + seed.students.length + ' คน');
    } catch(e) { console.log('⚠️  ไม่พบไฟล์รายชื่อนักเรียน:', e.message); }
  }
  console.log('✅ SQLite ready at', dbPath);
}

app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = await get('SELECT token FROM sessions WHERE token = ?', [token]).catch(()=>null);
  if (!session) return res.status(401).json({ error: 'Invalid token' });
  next();
}

// ─── AUTH ────────────────────────────────────────────────────
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

// ─── SETTINGS ────────────────────────────────────────────────
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

// ─── MEDICINES ───────────────────────────────────────────────
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

// ─── DISPENSES ───────────────────────────────────────────────
app.get('/api/dispenses', requireAuth, async (req, res) => {
  const { date, search } = req.query;
  let q = 'SELECT * FROM dispenses WHERE 1=1'; const params = [];
  if (date) { q += ' AND created_at LIKE ?'; params.push(date+'%'); }
  if (search) { q += ' AND (student_name LIKE ? OR med_name LIKE ?)'; params.push('%'+search+'%','%'+search+'%'); }
  res.json(await all(q+' ORDER BY created_at DESC', params));
});

app.post('/api/dispenses', async (req, res) => {
  const { student_name, student_id, class_room, med_id, qty, symptom, allergy, source } = req.body;
  if (!student_name || !med_id) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const med = await get('SELECT * FROM medicines WHERE id = ?', [med_id]);
  if (!med) return res.status(404).json({ error: 'ไม่พบรายการยา' });
  const amount = parseInt(qty) || 1;
  if (amount > med.qty) return res.status(400).json({ error: `ยาไม่เพียงพอ (คงเหลือ ${med.qty} ${med.unit})` });
  await run('UPDATE medicines SET qty = qty - ? WHERE id = ?', [amount, med_id]);
  const id = uid();
  await run(`INSERT INTO dispenses (id,student_name,student_id,class_room,med_id,med_name,unit,qty,symptom,allergy,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, student_name, student_id||'', class_room||'', med_id, med.name, med.unit, amount, symptom||'', allergy||'ไม่แพ้ยา', source||'qr', nowBKK()]);
  res.json({ id, med_name: med.name, unit: med.unit, qty: amount, ok: true });
});

app.put('/api/dispenses/:id', requireAuth, async (req, res) => {
  const { student_name, student_id, class_room, qty, symptom, allergy, note } = req.body;
  if (!student_name) return res.status(400).json({ error: 'กรุณากรอกชื่อ' });
  await run(`UPDATE dispenses SET student_name=?,student_id=?,class_room=?,qty=?,symptom=?,allergy=?,note=? WHERE id=?`,
    [student_name, student_id||'', class_room||'', parseInt(qty)||1, symptom||'', allergy||'ไม่แพ้ยา', note||'', req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/dispenses/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM dispenses WHERE id = ?', [req.params.id]); res.json({ ok: true });
});

// ─── RECEIVES ────────────────────────────────────────────────
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
  await run(`INSERT INTO receives (id,med_id,med_name,unit,qty,lot,exp_date,source,note,received_date,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, med_id, med.name, med.unit, amount, lot||'', exp_date||'', source||'', note||'', received_date||nowBKK().slice(0,10), nowBKK()]);
  res.json({ ok: true });
});

app.delete('/api/receives/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM receives WHERE id = ?', [req.params.id]); res.json({ ok: true });
});

// ─── REQUISITIONS ────────────────────────────────────────────
app.get('/api/requisitions', requireAuth, async (req, res) => {
  const { status, date } = req.query;
  let q = 'SELECT * FROM requisitions WHERE 1=1'; const params = [];
  if (status) { q += ' AND status = ?'; params.push(status); }
  if (date) { q += ' AND created_at LIKE ?'; params.push(date+'%'); }
  res.json(await all(q+' ORDER BY created_at DESC', params));
});

app.post('/api/requisitions', async (req, res) => {
  const { teacher, dept, med_id, qty, reason, source } = req.body;
  if (!teacher || !med_id) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const med = await get('SELECT * FROM medicines WHERE id = ?', [med_id]);
  if (!med) return res.status(404).json({ error: 'ไม่พบรายการยา' });
  const id = uid();
  await run(`INSERT INTO requisitions (id,teacher,dept,med_id,med_name,unit,qty,reason,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, teacher, dept||'', med_id, med.name, med.unit, parseInt(qty)||1, reason||'', source||'qr', nowBKK()]);
  res.json({ id, med_name: med.name, unit: med.unit, ok: true });
});

app.put('/api/requisitions/:id', requireAuth, async (req, res) => {
  const { status, note } = req.body;
  await run('UPDATE requisitions SET status=?, note=?, processed_at=? WHERE id=?',
    [status, note||'', nowBKK(), req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/requisitions/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM requisitions WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ─── STUDENTS (ฐานข้อมูลนักเรียน) ─────────────────────────────
app.get('/api/students/levels', async (req, res) => {
  const rows = await all('SELECT DISTINCT level FROM students ORDER BY level');
  res.json(rows.map(r => r.level));
});

app.get('/api/students/depts', async (req, res) => {
  const { level } = req.query;
  let q = 'SELECT dept, COUNT(*) as cnt FROM students WHERE 1=1'; const p = [];
  if (level) { q += ' AND level=?'; p.push(level); }
  q += " AND dept != '' GROUP BY dept ORDER BY dept";
  res.json(await all(q, p));
});

app.get('/api/students/rooms', async (req, res) => {
  const { level, dept } = req.query;
  let q = 'SELECT room, dept, level, COUNT(*) as cnt FROM students WHERE 1=1'; const p = [];
  if (level) { q += ' AND level=?'; p.push(level); }
  if (dept)  { q += ' AND dept=?';  p.push(dept); }
  q += ' GROUP BY room, dept, level ORDER BY level, room';
  res.json(await all(q, p));
});

// รายชื่อนักเรียนทั้งห้อง + สถานะการกรอกแบบคัดกรอง
app.get('/api/screenings/roster', requireAuth, async (req, res) => {
  const { level, room, dept, term } = req.query;
  let q = `SELECT st.sid, st.prefix, st.fname, st.lname, st.level, st.room, st.dept, st.phone,
      CASE WHEN st.photo IS NOT NULL AND st.photo != '' THEN 1 ELSE 0 END as has_photo,
      sc.id as screen_id, sc.weight, sc.height, sc.bmi, sc.blood_type,
      sc.congenital, sc.drug_allergy, sc.food_allergy, sc.current_meds, sc.symptoms,
      sc.vision, sc.hearing, sc.dental, sc.emergency_name, sc.emergency_phone,
      sc.note, sc.created_at
    FROM students st
    LEFT JOIN screenings sc ON sc.sid = st.sid`;
  const p = [];
  if (term) { q += ' AND sc.term = ?'; p.push(term); }
  q += ' WHERE 1=1';
  if (level) { q += ' AND st.level=?'; p.push(level); }
  if (room)  { q += ' AND st.room=?';  p.push(room); }
  if (dept)  { q += ' AND st.dept=?';  p.push(dept); }
  q += ' ORDER BY st.level, st.room, st.sid';
  res.json(await all(q, p));
});

app.get('/api/students/list', async (req, res) => {
  const { level, room } = req.query;
  if (!level || !room) return res.json([]);
  res.json(await all(
    'SELECT sid, prefix, fname, lname, dept FROM students WHERE level=? AND room=? ORDER BY sid',
    [level, room]));
});

// ─── STUDENTS CRUD (จัดการข้อมูลนักเรียน) ────────────────────
app.get('/api/students', requireAuth, async (req, res) => {
  const { level, room, dept, search, withPhoto } = req.query;
  const cols = withPhoto === '1'
    ? 'sid,prefix,fname,lname,level,room,dept,phone,note,photo'
    : "sid,prefix,fname,lname,level,room,dept,phone,note,CASE WHEN photo IS NOT NULL AND photo != '' THEN 1 ELSE 0 END as has_photo";
  let q = `SELECT ${cols} FROM students WHERE 1=1`; const p = [];
  if (level) { q += ' AND level=?'; p.push(level); }
  if (room)  { q += ' AND room=?';  p.push(room); }
  if (dept)  { q += ' AND dept=?';  p.push(dept); }
  if (search){ q += ' AND (fname LIKE ? OR lname LIKE ? OR sid LIKE ?)';
               p.push('%'+search+'%','%'+search+'%','%'+search+'%'); }
  q += ' ORDER BY level, room, sid';
  res.json(await all(q, p));
});

app.get('/api/students/photo/:sid', async (req, res) => {
  const r = await get('SELECT photo FROM students WHERE sid=?', [req.params.sid]);
  res.json({ photo: (r && r.photo) ? r.photo : '' });
});

app.post('/api/students', requireAuth, async (req, res) => {
  const b = req.body;
  if (!b.sid || !b.fname) return res.status(400).json({ error: 'กรุณากรอกรหัสและชื่อ' });
  if (!b.level || !b.room) return res.status(400).json({ error: 'กรุณาระบุระดับชั้นและห้อง' });
  const dup = await get('SELECT sid FROM students WHERE sid=?', [b.sid]);
  if (dup) return res.status(400).json({ error: 'รหัสนักเรียนนี้มีอยู่แล้ว' });
  await run(`INSERT INTO students (sid,prefix,fname,lname,level,room,dept,phone,note,photo)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [b.sid, b.prefix||'', b.fname, b.lname||'', b.level, b.room, b.dept||'',
     b.phone||'', b.note||'', b.photo||'']);
  res.json({ ok: true, sid: b.sid });
});

app.put('/api/students/:sid', requireAuth, async (req, res) => {
  const b = req.body;
  if (!b.fname) return res.status(400).json({ error: 'กรุณากรอกชื่อ' });
  // ถ้าไม่ได้ส่ง photo มา = ไม่แตะรูปเดิม
  if (b.photo === undefined) {
    await run(`UPDATE students SET prefix=?,fname=?,lname=?,level=?,room=?,dept=?,phone=?,note=? WHERE sid=?`,
      [b.prefix||'', b.fname, b.lname||'', b.level, b.room, b.dept||'', b.phone||'', b.note||'', req.params.sid]);
  } else {
    await run(`UPDATE students SET prefix=?,fname=?,lname=?,level=?,room=?,dept=?,phone=?,note=?,photo=? WHERE sid=?`,
      [b.prefix||'', b.fname, b.lname||'', b.level, b.room, b.dept||'', b.phone||'', b.note||'',
       b.photo||'', req.params.sid]);
  }
  res.json({ ok: true });
});

app.put('/api/students/:sid/photo', async (req, res) => {
  const { photo } = req.body;
  const stu = await get('SELECT sid FROM students WHERE sid=?', [req.params.sid]);
  if (!stu) return res.status(404).json({ error: 'ไม่พบนักเรียน' });
  await run('UPDATE students SET photo=? WHERE sid=?', [photo||'', req.params.sid]);
  res.json({ ok: true });
});

app.delete('/api/students/:sid', requireAuth, async (req, res) => {
  await run('DELETE FROM screenings WHERE sid=?', [req.params.sid]);
  await run('DELETE FROM students WHERE sid=?', [req.params.sid]);
  res.json({ ok: true });
});

// ─── SCREENINGS (คัดกรองสุขภาพ) ───────────────────────────────
app.get('/api/screenings', requireAuth, async (req, res) => {
  const { level, room, search, term } = req.query;
  let q = 'SELECT * FROM screenings WHERE 1=1'; const p = [];
  if (level) { q += ' AND level=?'; p.push(level); }
  if (room)  { q += ' AND room=?';  p.push(room); }
  if (term)  { q += ' AND term=?';  p.push(term); }
  if (search){ q += ' AND (student_name LIKE ? OR sid LIKE ?)'; p.push('%'+search+'%','%'+search+'%'); }
  res.json(await all(q + ' ORDER BY level, room, sid', p));
});

app.get('/api/screenings/stats', requireAuth, async (req, res) => {
  const total    = await get('SELECT COUNT(*) as n FROM screenings');
  const students = await get('SELECT COUNT(*) as n FROM students');
  const byLevel  = await all('SELECT level, COUNT(*) as n FROM screenings GROUP BY level ORDER BY level');
  const risk     = await get("SELECT COUNT(*) as n FROM screenings WHERE congenital != 'ไม่มี' OR drug_allergy != 'ไม่มี'");
  res.json({ total: total.n, students: students.n, byLevel, risk: risk.n });
});

app.post('/api/screenings', async (req, res) => {
  const b = req.body;
  if (!b.sid || !b.student_name) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const exists = await get('SELECT id FROM screenings WHERE sid=? AND term=?', [b.sid, b.term||'']);
  const w = parseFloat(b.weight)||0, h = parseFloat(b.height)||0;
  const bmi = (w>0 && h>0) ? +(w/((h/100)**2)).toFixed(1) : null;
  const vals = [b.student_name, b.level, b.room, b.dept||'', w||null, h||null, bmi,
    b.congenital||'ไม่มี', b.drug_allergy||'ไม่มี', b.food_allergy||'ไม่มี', b.current_meds||'ไม่มี',
    b.symptoms||'', b.vision||'ปกติ', b.hearing||'ปกติ', b.dental||'ปกติ', b.blood_type||'',
    b.emergency_name||'', b.emergency_phone||'', b.note||'', b.term||''];
  if (exists) {
    await run(`UPDATE screenings SET student_name=?,level=?,room=?,dept=?,weight=?,height=?,bmi=?,
      congenital=?,drug_allergy=?,food_allergy=?,current_meds=?,symptoms=?,vision=?,hearing=?,
      dental=?,blood_type=?,emergency_name=?,emergency_phone=?,note=?,term=?,created_at=? WHERE id=?`,
      [...vals, nowBKK(), exists.id]);
    return res.json({ id: exists.id, updated: true, bmi, ok: true });
  }
  const id = uid();
  await run(`INSERT INTO screenings (id,sid,student_name,level,room,dept,weight,height,bmi,
    congenital,drug_allergy,food_allergy,current_meds,symptoms,vision,hearing,dental,blood_type,
    emergency_name,emergency_phone,note,term,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, b.sid, ...vals, nowBKK()]);
  res.json({ id, bmi, ok: true });
});

app.put('/api/screenings/:id', requireAuth, async (req, res) => {
  const b = req.body;
  const w = parseFloat(b.weight)||0, h = parseFloat(b.height)||0;
  const bmi = (w>0 && h>0) ? +(w/((h/100)**2)).toFixed(1) : null;
  await run(`UPDATE screenings SET student_name=?,weight=?,height=?,bmi=?,congenital=?,drug_allergy=?,
    food_allergy=?,current_meds=?,symptoms=?,vision=?,hearing=?,dental=?,blood_type=?,
    emergency_name=?,emergency_phone=?,note=? WHERE id=?`,
    [b.student_name, w||null, h||null, bmi, b.congenital||'ไม่มี', b.drug_allergy||'ไม่มี',
     b.food_allergy||'ไม่มี', b.current_meds||'ไม่มี', b.symptoms||'', b.vision||'ปกติ',
     b.hearing||'ปกติ', b.dental||'ปกติ', b.blood_type||'', b.emergency_name||'',
     b.emergency_phone||'', b.note||'', req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/screenings/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM screenings WHERE id=?', [req.params.id]);
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

app.get('/api/qr/teacher', requireAuth, async (req, res) => {
  const url = `${BASE_URL}/teacher`;
  try {
    const dataUrl = await qrcode.toDataURL(url, { width:400, margin:2, color:{ dark:'#185FA5', light:'#ffffff' } });
    res.json({ qr: dataUrl, url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/qr/screening', requireAuth, async (req, res) => {
  const url = `${BASE_URL}/screening`;
  try {
    const dataUrl = await qrcode.toDataURL(url, { width:400, margin:2, color:{ dark:'#7C3AED', light:'#ffffff' } });
    res.json({ qr: dataUrl, url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── ROUTING ─────────────────────────────────────────────────
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student', 'index.html')));
app.get('/screening', (req, res) => res.sendFile(path.join(__dirname, 'public', 'screening', 'index.html')));
app.get('/teacher', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher', 'index.html')));
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/', (req, res) => res.redirect('/admin'));

// ─── START ───────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🏥 MedStock on port ${PORT} | Admin: ${BASE_URL}/admin`);
  });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
