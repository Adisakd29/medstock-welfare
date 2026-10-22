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
// ═══ ป้องกัน process ตายจาก error ใน route (P0) ═══
const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);


// ═══ บัญชีผู้ใช้ + สิทธิ์ (RBAC) ═══
const ROLES = {
  admin:  { label: 'ผู้ดูแลระบบ',   rank: 4 },
  nurse:  { label: 'เจ้าหน้าที่พยาบาล', rank: 3 },
  staff:  { label: 'เจ้าหน้าที่',     rank: 2 },
  viewer: { label: 'ผู้ดูอย่างเดียว',  rank: 1 },
};

function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${h}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const cand = crypto.scryptSync(String(pw), salt, 64);
  const want = Buffer.from(h, 'hex');
  return cand.length === want.length && crypto.timingSafeEqual(cand, want);
}

// ต้องมีสิทธิ์ขั้นต่ำตามบทบาท
function requireRole(...allowed) {
  return async (req, res, next) => {
    const tok = req.headers['x-auth-token'];
    if (!tok) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    const s = await get(
      `SELECT s.token, u.id, u.username, u.name, u.role, u.active
         FROM sessions s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.token = ?`, [tok]).catch(()=>null);
    if (!s) return res.status(401).json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    if (s.id && !s.active) return res.status(403).json({ error: 'บัญชีนี้ถูกระงับการใช้งาน' });
    req.user = s.id ? { id: s.id, username: s.username, name: s.name, role: s.role }
                    : { id: '', username: 'legacy', name: 'ผู้ดูแลระบบ', role: 'admin' };
    req.isStaff = true;
    if (allowed.length && !allowed.includes(req.user.role))
      return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ใช้งานส่วนนี้' });
    next();
  };
}

// ═══ FORM KEY: กุญแจสำหรับฟอร์ม QR (ผู้ใช้ไม่ต้อง login แต่คนนอกเข้าไม่ได้) ═══
const ALLOW_LEGACY_QR = process.env.ALLOW_LEGACY_QR === '1';
let FORM_KEY = '';

async function requireFormKey(req, res, next) {
  // เจ้าหน้าที่ที่ login แล้วผ่านได้เสมอ
  const tok = req.headers['x-auth-token'];
  if (tok) {
    const s = await get('SELECT token FROM sessions WHERE token = ?', [tok]).catch(()=>null);
    if (s) { req.isStaff = true; return next(); }
  }
  const k = req.headers['x-form-key'] || req.query.k || '';
  if (FORM_KEY && k === FORM_KEY) return next();
  if (ALLOW_LEGACY_QR) return next();   // โหมดเปลี่ยนผ่าน: QR เก่าที่พิมพ์ไปแล้วยังใช้ได้
  return res.status(401).json({ error: 'ลิงก์ไม่ถูกต้องหรือหมดอายุ กรุณาสแกน QR Code ใหม่' });
}


// ═══ ระบบล็อต + FEFO (จ่ายยาที่ใกล้หมดอายุก่อน) ═══

// ตัดสต็อกตามหลัก FEFO — คืน null ถ้าสำเร็จ, คืนข้อความถ้าไม่พอ
async function consumeFEFO(medId, amount, ref, actor) {
  // ล็อตที่ยังมีของ เรียงวันหมดอายุใกล้สุดก่อน (ไม่ระบุวันหมดอายุไว้ท้ายสุด)
  const batches = await all(
    `SELECT * FROM stock_batches
      WHERE med_id = ? AND qty_remaining > 0
      ORDER BY CASE WHEN exp_date IS NULL OR exp_date = '' THEN 1 ELSE 0 END,
               exp_date ASC, created_at ASC`, [medId]);

  const total = batches.reduce((s, b) => s + b.qty_remaining, 0);
  if (total < amount) return { error: `ยาไม่เพียงพอ (คงเหลือรวมทุกล็อต ${total})`, total };

  let left = amount;
  const used = [];
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(b.qty_remaining, left);
    // ตัดแบบ atomic กัน concurrent
    const r = await run(
      'UPDATE stock_batches SET qty_remaining = qty_remaining - ? WHERE id = ? AND qty_remaining >= ?',
      [take, b.id, take]);
    if (!r || r.changes === 0) continue;   // ล็อตนี้ถูกคนอื่นตัดไปก่อน ข้ามไปล็อตถัดไป
    left -= take;
    used.push({ batch_id: b.id, lot: b.lot, exp_date: b.exp_date, qty: take });
    await run(`INSERT INTO stock_txn (id,med_id,batch_id,type,qty,ref_type,ref_id,actor,note,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uid(), medId, b.id, 'out', take, ref.type||'', ref.id||'', actor||'',
       `ล็อต ${b.lot||'-'} หมดอายุ ${b.exp_date||'-'}`, nowBKK()]);
  }

  if (left > 0) {
    // ตัดได้ไม่ครบ (แข่งกับคนอื่น) → คืนของที่ตัดไปแล้วทั้งหมด
    for (const u of used) {
      await run('UPDATE stock_batches SET qty_remaining = qty_remaining + ? WHERE id = ?', [u.qty, u.batch_id]);
      await run('DELETE FROM stock_txn WHERE med_id=? AND batch_id=? AND ref_id=? AND type=\'out\'',
        [medId, u.batch_id, ref.id||'']);
    }
    return { error: 'ยาไม่เพียงพอ (มีผู้ใช้รายการนี้พร้อมกัน กรุณาลองใหม่)' };
  }

  await syncMedQty(medId);
  return { ok: true, used };
}

// คืนสต็อกเข้าล็อตเดิม
async function returnToBatches(medId, refId, actor) {
  const txns = await all(
    "SELECT * FROM stock_txn WHERE med_id=? AND ref_id=? AND type='out'", [medId, refId]);
  for (const t of txns) {
    await run('UPDATE stock_batches SET qty_remaining = qty_remaining + ? WHERE id = ?', [t.qty, t.batch_id]);
    await run(`INSERT INTO stock_txn (id,med_id,batch_id,type,qty,ref_type,ref_id,actor,note,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uid(), medId, t.batch_id, 'in', t.qty, 'return', refId, actor||'', 'คืนสต็อกจากการยกเลิก', nowBKK()]);
  }
  await syncMedQty(medId);
  return txns.length;
}

// อัปเดตยอดรวมในตาราง medicines ให้ตรงกับผลรวมทุกล็อต
async function syncMedQty(medId) {
  const r = await get('SELECT COALESCE(SUM(qty_remaining),0) as n FROM stock_batches WHERE med_id=?', [medId]);
  await run('UPDATE medicines SET qty = ? WHERE id = ?', [r ? r.n : 0, medId]);
  return r ? r.n : 0;
}

// ═══ ภาคเรียน ═══
async function currentTerm() {
  const r = await get("SELECT value FROM settings WHERE key='current_term'").catch(()=>null);
  return (r && r.value) ? r.value : '';
}

// ═══ AUDIT LOG ═══
async function audit(req, action, entity, entity_id, detail) {
  try {
    await run(`INSERT INTO audit_log (id,actor,action,entity,entity_id,detail,ip,created_at)
      VALUES (?,?,?,?,?,?,?,?)`,
      [uid(), req.user ? (req.user.username + ' (' + req.user.role + ')') : (req.headers['x-form-key'] ? 'qr-form' : 'public'),
       action, entity, entity_id || '', typeof detail === 'string' ? detail : JSON.stringify(detail||{}),
       (req.headers['x-forwarded-for']||req.ip||'').toString().slice(0,60), nowBKK()]);
  } catch(e) { console.error('audit failed:', e.message); }
}


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

  await run(`CREATE TABLE IF NOT EXISTS stock_batches (
    id TEXT PRIMARY KEY, med_id TEXT NOT NULL, lot TEXT DEFAULT '',
    exp_date TEXT DEFAULT '', qty_received INTEGER NOT NULL DEFAULT 0,
    qty_remaining INTEGER NOT NULL DEFAULT 0, source TEXT DEFAULT '',
    received_date TEXT DEFAULT '', note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')))`);
  await run(`CREATE INDEX IF NOT EXISTS idx_batch_fefo ON stock_batches(med_id, qty_remaining, exp_date)`);
  await run(`CREATE TABLE IF NOT EXISTS stock_txn (
    id TEXT PRIMARY KEY, med_id TEXT NOT NULL, batch_id TEXT DEFAULT '',
    type TEXT NOT NULL, qty INTEGER NOT NULL,
    ref_type TEXT DEFAULT '', ref_id TEXT DEFAULT '',
    actor TEXT DEFAULT '', note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')))`);
  await run(`CREATE INDEX IF NOT EXISTS idx_txn_med ON stock_txn(med_id, created_at DESC)`);
  await run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer',
    active INTEGER DEFAULT 1, last_login TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')))`);
  await run(`CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, actor TEXT DEFAULT '', action TEXT NOT NULL,
    entity TEXT DEFAULT '', entity_id TEXT DEFAULT '', detail TEXT DEFAULT '',
    ip TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC)`);

  // เพิ่ม column ที่อาจไม่มีใน database เก่า (ไม่ error ถ้ามีอยู่แล้ว)
  const alterCmds = [
    "ALTER TABLE dispenses ADD COLUMN note TEXT DEFAULT ''",
    "ALTER TABLE dispenses ADD COLUMN allergy TEXT DEFAULT 'ไม่แพ้ยา'",
    "ALTER TABLE requisitions ADD COLUMN note TEXT DEFAULT ''",
    "ALTER TABLE requisitions ADD COLUMN processed_at TEXT DEFAULT ''",
    "ALTER TABLE students ADD COLUMN photo TEXT DEFAULT ''",
    "ALTER TABLE students ADD COLUMN phone TEXT DEFAULT ''",
    "ALTER TABLE students ADD COLUMN note TEXT DEFAULT ''",
    "ALTER TABLE dispenses ADD COLUMN status TEXT DEFAULT 'dispensed'",
    "ALTER TABLE dispenses ADD COLUMN confirmed_at TEXT DEFAULT ''",
    "ALTER TABLE sessions ADD COLUMN user_id TEXT DEFAULT ''",
    "ALTER TABLE requisitions ADD COLUMN approved_by TEXT DEFAULT ''",
    "ALTER TABLE requisitions ADD COLUMN approved_at TEXT DEFAULT ''",
    "ALTER TABLE requisitions ADD COLUMN issued_by TEXT DEFAULT ''",
    "ALTER TABLE requisitions ADD COLUMN issued_at TEXT DEFAULT ''",
    "ALTER TABLE requisitions ADD COLUMN received_at TEXT DEFAULT ''",
    "ALTER TABLE requisitions ADD COLUMN receiver_note TEXT DEFAULT ''",
    "ALTER TABLE dispenses ADD COLUMN term TEXT DEFAULT ''",
    "ALTER TABLE requisitions ADD COLUMN term TEXT DEFAULT ''",
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
  // ── ย้ายยอดคงเหลือเดิมเข้าระบบล็อต (ทำครั้งเดียว ไม่แตะข้อมูลเดิม) ──
  const bcount = await get('SELECT COUNT(*) as n FROM stock_batches').catch(()=>({n:0}));
  if (!bcount || bcount.n === 0) {
    const olds = await all('SELECT * FROM medicines').catch(()=>[]);
    let made = 0;
    for (const m of olds) {
      const q = parseInt(m.qty) || 0;
      if (q <= 0) continue;
      const bid = uid();
      await run(`INSERT INTO stock_batches (id,med_id,lot,exp_date,qty_received,qty_remaining,source,received_date,note,created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [bid, m.id, m.lot||'', m.exp_date||'', q, q, 'ยอดยกมา',
         (m.created_at||nowBKK()).slice(0,10), 'ล็อตตั้งต้นจากยอดคงเหลือเดิม', nowBKK()]);
      await run(`INSERT INTO stock_txn (id,med_id,batch_id,type,qty,ref_type,ref_id,actor,note,created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uid(), m.id, bid, 'in', q, 'migration', '', 'system', 'ยอดยกมาตอนเริ่มใช้ระบบล็อต', nowBKK()]);
      made++;
    }
    if (made) console.log(`📦 ย้ายยอดคงเหลือเดิมเข้าระบบล็อต ${made} รายการ`);
  }

  // ── สร้างบัญชี admin ครั้งแรก ──
  const ucount = await get('SELECT COUNT(*) as n FROM users').catch(()=>({n:0}));
  if (!ucount || ucount.n === 0) {
    await run('INSERT INTO users (id,username,name,pass_hash,role) VALUES (?,?,?,?,?)',
      [uid(), 'admin', 'ผู้ดูแลระบบ', hashPassword(ADMIN_PASSWORD), 'admin']);
    console.log('👤 สร้างบัญชีแรก: admin / (ใช้ค่า ADMIN_PASSWORD)');
  }

  // ── ภาคเรียนปัจจุบัน ──
  const ct = await get("SELECT value FROM settings WHERE key='current_term'").catch(()=>null);
  if (!ct || !ct.value) {
    // ไทย: พ.ค.–ต.ค. = ภาคเรียนที่ 1, พ.ย.–เม.ย. = ภาคเรียนที่ 2 (ปีการศึกษาเดิม)
    const d = new Date(nowBKK().replace(' ', 'T'));
    const m = d.getMonth() + 1, by = d.getFullYear() + 543;
    const term = (m >= 5 && m <= 10) ? `1/${by}` : (m >= 11 ? `2/${by}` : `2/${by - 1}`);
    await run("INSERT OR REPLACE INTO settings (key,value) VALUES ('current_term',?)", [term]);
    console.log('📅 ตั้งภาคเรียนปัจจุบัน:', term);
  }

  // ── FORM KEY ──
  let fk = await get("SELECT value FROM settings WHERE key='form_key'").catch(()=>null);
  if (!fk || !fk.value) {
    const nk = crypto.randomBytes(16).toString('hex');
    await run("INSERT OR REPLACE INTO settings (key,value) VALUES ('form_key',?)", [nk]);
    FORM_KEY = nk;
    console.log('🔑 สร้าง FORM KEY ใหม่:', nk);
  } else FORM_KEY = fk.value;
  if (ALLOW_LEGACY_QR) console.log('⚠️  ALLOW_LEGACY_QR=1 : QR เก่ายังใช้ได้ (ควรปิดเมื่อพิมพ์ QR ใหม่แล้ว)');

  // แถวเดิมที่ยังไม่มี status ให้ถือว่าจ่ายแล้ว (เข้ากันได้กับข้อมูลเดิม)
  await run("UPDATE dispenses SET status='dispensed' WHERE status IS NULL OR status=''").catch(()=>{});

  console.log('✅ SQLite ready at', dbPath);
}

app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const requireAuth = requireRole();

// ─── AUTH ────────────────────────────────────────────────────
app.post('/api/login', asyncH(async (req, res) => {
  const { username, password } = req.body;
  let user = null;

  if (username) {
    user = await get('SELECT * FROM users WHERE username = ?', [String(username).trim().toLowerCase()]);
    if (!user || !verifyPassword(password, user.pass_hash)) {
      await audit(req, 'login_failed', 'users', String(username).slice(0,40), {});
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
    if (!user.active) return res.status(403).json({ error: 'บัญชีนี้ถูกระงับการใช้งาน' });
  } else {
    // โหมดเดิม: ใส่แค่รหัสผ่าน → เข้าเป็นบัญชี admin
    user = await get("SELECT * FROM users WHERE username='admin'");
    if (!user || !verifyPassword(password, user.pass_hash)) {
      await audit(req, 'login_failed', 'users', 'admin', {});
      return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  await run('INSERT INTO sessions (token,user_id) VALUES (?,?)', [token, user.id]);
  await run('UPDATE users SET last_login=? WHERE id=?', [nowBKK(), user.id]);
  req.user = { id: user.id, username: user.username, name: user.name, role: user.role };
  await audit(req, 'login', 'users', user.id, { role: user.role });
  res.json({ token, user: { username: user.username, name: user.name, role: user.role } });
}));

// ข้อมูลผู้ใช้ที่ล็อกอินอยู่
app.get('/api/me', requireAuth, asyncH(async (req, res) => {
  res.json({ ...req.user, roleLabel: (ROLES[req.user.role]||{}).label || req.user.role });
}));

// ─── จัดการผู้ใช้ (เฉพาะ admin) ───────────────────────────────
app.get('/api/users', requireRole('admin'), asyncH(async (req, res) => {
  res.json(await all('SELECT id,username,name,role,active,last_login,created_at FROM users ORDER BY username'));
}));

app.post('/api/users', requireRole('admin'), asyncH(async (req, res) => {
  const { username, name, password, role } = req.body;
  const u = String(username||'').trim().toLowerCase();
  if (!u || !/^[a-z0-9._-]{3,32}$/.test(u))
    return res.status(400).json({ error: 'ชื่อผู้ใช้ต้องเป็น a-z 0-9 . _ - ยาว 3-32 ตัว' });
  if (!password || String(password).length < 8)
    return res.status(400).json({ error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร' });
  if (!ROLES[role]) return res.status(400).json({ error: 'บทบาทไม่ถูกต้อง' });
  if (await get('SELECT id FROM users WHERE username=?', [u]))
    return res.status(400).json({ error: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' });
  const id = uid();
  await run('INSERT INTO users (id,username,name,pass_hash,role) VALUES (?,?,?,?,?)',
    [id, u, name||'', hashPassword(password), role]);
  await audit(req, 'create_user', 'users', id, { username: u, role });
  res.json({ ok: true, id });
}));

app.put('/api/users/:id', requireRole('admin'), asyncH(async (req, res) => {
  const { name, role, active, password } = req.body;
  const t = await get('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  if (role && !ROLES[role]) return res.status(400).json({ error: 'บทบาทไม่ถูกต้อง' });

  // กันล็อกตัวเองออกจากระบบ: ต้องเหลือ admin ที่ใช้งานได้อย่างน้อย 1 คน
  const willDemote = (role && role !== 'admin') || active === 0 || active === false;
  if (t.role === 'admin' && willDemote) {
    const others = await get("SELECT COUNT(*) as n FROM users WHERE role='admin' AND active=1 AND id<>?", [t.id]);
    if (!others || others.n === 0)
      return res.status(400).json({ error: 'ต้องเหลือผู้ดูแลระบบที่ใช้งานได้อย่างน้อย 1 บัญชี' });
  }
  if (password) {
    if (String(password).length < 8) return res.status(400).json({ error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร' });
    await run('UPDATE users SET pass_hash=? WHERE id=?', [hashPassword(password), t.id]);
    await run('DELETE FROM sessions WHERE user_id=?', [t.id]);   // บังคับ login ใหม่
  }
  await run('UPDATE users SET name=?, role=?, active=? WHERE id=?',
    [name !== undefined ? name : t.name, role || t.role,
     active === undefined ? t.active : (active ? 1 : 0), t.id]);
  await audit(req, 'update_user', 'users', t.id, { role: role||t.role, pwChanged: !!password });
  res.json({ ok: true });
}));

app.delete('/api/users/:id', requireRole('admin'), asyncH(async (req, res) => {
  const t = await get('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  if (t.id === req.user.id) return res.status(400).json({ error: 'ลบบัญชีตัวเองไม่ได้' });
  if (t.role === 'admin') {
    const others = await get("SELECT COUNT(*) as n FROM users WHERE role='admin' AND active=1 AND id<>?", [t.id]);
    if (!others || others.n === 0) return res.status(400).json({ error: 'ต้องเหลือผู้ดูแลระบบอย่างน้อย 1 บัญชี' });
  }
  await run('DELETE FROM sessions WHERE user_id=?', [t.id]);
  await run('DELETE FROM users WHERE id=?', [t.id]);
  await audit(req, 'delete_user', 'users', t.id, { username: t.username });
  res.json({ ok: true });
}));

// เปลี่ยนรหัสผ่านตัวเอง
app.post('/api/me/password', requireAuth, asyncH(async (req, res) => {
  const { current, next: np } = req.body;
  if (!req.user.id) return res.status(400).json({ error: 'บัญชีนี้เปลี่ยนรหัสผ่านไม่ได้' });
  const u = await get('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!verifyPassword(current, u.pass_hash)) return res.status(401).json({ error: 'รหัสผ่านเดิมไม่ถูกต้อง' });
  if (!np || String(np).length < 8) return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร' });
  await run('UPDATE users SET pass_hash=? WHERE id=?', [hashPassword(np), u.id]);
  await audit(req, 'change_own_password', 'users', u.id, {});
  res.json({ ok: true });
}));

app.post('/api/logout', requireAuth, asyncH(async (req, res) => {
  await run('DELETE FROM sessions WHERE token = ?', [req.headers['x-auth-token']]);
  res.json({ ok: true });
}));

// ─── SETTINGS ────────────────────────────────────────────────
app.get('/api/settings-public', asyncH(async (req, res) => {
  const org = await get("SELECT value FROM settings WHERE key='org_name'");
  res.json({ org_name: org ? org.value : '', current_term: await currentTerm() });
}));

app.get('/api/settings', requireAuth, asyncH(async (req, res) => {
  const rows = await all('SELECT key, value FROM settings');
  const s = {}; rows.forEach(r => s[r.key] = r.value);
  res.json(s);
}));

app.put('/api/settings', requireRole('admin'), asyncH(async (req, res) => {
  for (const [k, v] of Object.entries(req.body))
    await run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, v]);
  res.json({ ok: true });
}));

// ─── MEDICINES ───────────────────────────────────────────────
app.get('/api/medicines', asyncH(async (req, res) => {
  res.json(await all('SELECT * FROM medicines ORDER BY name'));
}));

app.post('/api/medicines', requireRole('admin','nurse'), asyncH(async (req, res) => {
  const { name, generic, category, unit, qty, min_qty, exp_date, lot, note } = req.body;
  if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อยา' });
  const id = uid();
  await run(`INSERT INTO medicines (id,name,generic,category,unit,qty,min_qty,exp_date,lot,note) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, name, generic||'', category||'อื่นๆ', unit||'เม็ด', parseInt(qty)||0, parseInt(min_qty)||10, exp_date||'', lot||'', note||'']);
  res.json({ id, ok: true });
}));

app.put('/api/medicines/:id', requireRole('admin','nurse'), asyncH(async (req, res) => {
  const { name, generic, category, unit, qty, min_qty, exp_date, lot, note } = req.body;
  await run(`UPDATE medicines SET name=?,generic=?,category=?,unit=?,qty=?,min_qty=?,exp_date=?,lot=?,note=? WHERE id=?`,
    [name, generic||'', category||'อื่นๆ', unit||'เม็ด', parseInt(qty)||0, parseInt(min_qty)||10, exp_date||'', lot||'', note||'', req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/medicines/:id', requireRole('admin'), asyncH(async (req, res) => {
  await run('DELETE FROM medicines WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ─── DISPENSES ───────────────────────────────────────────────
app.get('/api/dispenses', requireAuth, asyncH(async (req, res) => {
  const { date, search, term } = req.query;
  let q = 'SELECT * FROM dispenses WHERE 1=1'; const params = [];
  if (term) { q += ' AND term = ?'; params.push(term); }
  if (date) { q += ' AND created_at LIKE ?'; params.push(date+'%'); }
  if (search) { q += ' AND (student_name LIKE ? OR med_name LIKE ?)'; params.push('%'+search+'%','%'+search+'%'); }
  res.json(await all(q+' ORDER BY created_at DESC', params));
}));

app.post('/api/dispenses', requireFormKey, asyncH(async (req, res) => {
  const { student_name, student_id, class_room, med_id, qty, symptom, allergy, source } = req.body;
  if (!student_name || !med_id) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const med = await get('SELECT * FROM medicines WHERE id = ?', [med_id]);
  if (!med) return res.status(404).json({ error: 'ไม่พบรายการยา' });

  const amount = parseInt(qty) || 1;
  if (amount < 1 || amount > 999) return res.status(400).json({ error: 'จำนวนไม่ถูกต้อง' });

  // คำขอผ่าน QR = รอเจ้าหน้าที่จ่ายจริง ไม่ตัดสต็อกอัตโนมัติ (ข้อกำหนดข้อ 10)
  const byStaff = !!req.isStaff;
  const status  = byStaff ? 'dispensed' : 'pending';

  const id = uid();
  const TERM = await currentTerm();
  if (byStaff) {
    // ตัดสต็อกตามหลัก FEFO (ใกล้หมดอายุก่อน) แบบ atomic
    const fe = await consumeFEFO(med_id, amount, { type: 'dispense', id }, req.user && req.user.username);
    if (fe.error) return res.status(409).json({ error: fe.error + ' ' + med.unit });
  }

  await run(`INSERT INTO dispenses (id,student_name,student_id,class_room,med_id,med_name,unit,qty,
      symptom,allergy,source,status,confirmed_at,term,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, student_name, student_id||'', class_room||'', med_id, med.name, med.unit, amount,
     symptom||'', allergy||'ไม่แพ้ยา', source||'qr', status, byStaff ? nowBKK() : '', TERM, nowBKK()]);

  await audit(req, byStaff ? 'dispense' : 'request', 'dispenses', id,
    { med: med.name, qty: amount, student: student_name });

  res.json({ id, med_name: med.name, unit: med.unit, qty: amount, status, ok: true });
}));

// เจ้าหน้าที่ยืนยันจ่ายยาจริงจากคำขอ QR — ตรงนี้เท่านั้นที่ตัดสต็อก
app.post('/api/dispenses/:id/confirm', requireRole('admin','nurse','staff'), asyncH(async (req, res) => {
  const d = await get('SELECT * FROM dispenses WHERE id=?', [req.params.id]);
  if (!d) return res.status(404).json({ error: 'ไม่พบคำขอ' });
  if (d.status === 'dispensed') return res.status(409).json({ error: 'คำขอนี้จ่ายยาไปแล้ว' });
  if (d.status === 'cancelled') return res.status(409).json({ error: 'คำขอนี้ถูกยกเลิกแล้ว' });

  const amount = parseInt(d.qty) || 1;
  const fe = await consumeFEFO(d.med_id, amount, { type: 'dispense', id: d.id }, req.user && req.user.username);
  if (fe.error) return res.status(409).json({ error: fe.error + ' ' + d.unit });
  await run("UPDATE dispenses SET status='dispensed', confirmed_at=? WHERE id=?", [nowBKK(), req.params.id]);
  await audit(req, 'confirm_dispense', 'dispenses', req.params.id, { med: d.med_name, qty: amount });
  res.json({ ok: true });
}));

app.post('/api/dispenses/:id/cancel', requireRole('admin','nurse','staff'), asyncH(async (req, res) => {
  const d = await get('SELECT * FROM dispenses WHERE id=?', [req.params.id]);
  if (!d) return res.status(404).json({ error: 'ไม่พบคำขอ' });
  if (d.status === 'dispensed') {
    // คืนสต็อกกลับเข้าล็อตเดิมที่ตัดไป
    await returnToBatches(d.med_id, d.id, req.user && req.user.username);
  }
  await run("UPDATE dispenses SET status='cancelled' WHERE id=?", [req.params.id]);
  await audit(req, 'cancel_dispense', 'dispenses', req.params.id, { med: d.med_name, qty: d.qty });
  res.json({ ok: true });
}));

app.put('/api/dispenses/:id', requireRole('admin','nurse','staff'), asyncH(async (req, res) => {
  const { student_name, student_id, class_room, qty, symptom, allergy, note } = req.body;
  if (!student_name) return res.status(400).json({ error: 'กรุณากรอกชื่อ' });
  await run(`UPDATE dispenses SET student_name=?,student_id=?,class_room=?,qty=?,symptom=?,allergy=?,note=? WHERE id=?`,
    [student_name, student_id||'', class_room||'', parseInt(qty)||1, symptom||'', allergy||'ไม่แพ้ยา', note||'', req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/dispenses/:id', requireRole('admin'), asyncH(async (req, res) => {
  await run('DELETE FROM dispenses WHERE id = ?', [req.params.id]); res.json({ ok: true });
}));

// ─── RECEIVES ────────────────────────────────────────────────
app.get('/api/receives', requireAuth, asyncH(async (req, res) => {
  res.json(await all('SELECT * FROM receives ORDER BY created_at DESC'));
}));

app.post('/api/receives', requireRole('admin','nurse'), asyncH(async (req, res) => {
  const { med_id, qty, lot, exp_date, source, note, received_date } = req.body;
  const med = await get('SELECT * FROM medicines WHERE id = ?', [med_id]);
  if (!med) return res.status(404).json({ error: 'ไม่พบรายการยา' });
  const amount = parseInt(qty) || 0;
  if (amount <= 0) return res.status(400).json({ error: 'กรุณาระบุจำนวน' });

  const id = uid(), bid = uid();
  // รับเข้าเป็นล็อตใหม่ แยกวันหมดอายุชัดเจน
  await run(`INSERT INTO stock_batches (id,med_id,lot,exp_date,qty_received,qty_remaining,source,received_date,note,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [bid, med_id, lot||'', exp_date||'', amount, amount, source||'',
     received_date || nowBKK().slice(0,10), note||'', nowBKK()]);
  await run(`INSERT INTO stock_txn (id,med_id,batch_id,type,qty,ref_type,ref_id,actor,note,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [uid(), med_id, bid, 'in', amount, 'receive', id, req.user && req.user.username,
     `ล็อต ${lot||'-'} หมดอายุ ${exp_date||'-'}`, nowBKK()]);

  await run(`INSERT INTO receives (id,med_id,med_name,unit,qty,lot,exp_date,source,note,received_date,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, med_id, med.name, med.unit, amount, lot||'', exp_date||'', source||'', note||'',
     received_date || nowBKK().slice(0,10), nowBKK()]);

  const total = await syncMedQty(med_id);
  await audit(req, 'receive_stock', 'medicines', med_id, { lot, exp_date, qty: amount, total });
  res.json({ ok: true, batch_id: bid, total });
}));

app.delete('/api/receives/:id', requireRole('admin'), asyncH(async (req, res) => {
  await run('DELETE FROM receives WHERE id = ?', [req.params.id]); res.json({ ok: true });
}));

// ─── REQUISITIONS ────────────────────────────────────────────
app.get('/api/requisitions', requireAuth, asyncH(async (req, res) => {
  const { status, date } = req.query;
  let q = 'SELECT * FROM requisitions WHERE 1=1'; const params = [];
  if (status) { q += ' AND status = ?'; params.push(status); }
  if (date) { q += ' AND created_at LIKE ?'; params.push(date+'%'); }
  res.json(await all(q+' ORDER BY created_at DESC', params));
}));

app.post('/api/requisitions', requireFormKey, asyncH(async (req, res) => {
  const { teacher, dept, med_id, qty, reason, source } = req.body;
  if (!teacher || !med_id) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const med = await get('SELECT * FROM medicines WHERE id = ?', [med_id]);
  if (!med) return res.status(404).json({ error: 'ไม่พบรายการยา' });
  const id = uid();
  await run(`INSERT INTO requisitions (id,teacher,dept,med_id,med_name,unit,qty,reason,source,term,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, teacher, dept||'', med_id, med.name, med.unit, parseInt(qty)||1, reason||'', source||'qr',
     await currentTerm(), nowBKK()]);
  res.json({ id, med_name: med.name, unit: med.unit, ok: true });
}));

// ─── ใบเบิกยาครู: workflow 4 ขั้น ────────────────────────────
// ขอ(pending) → อนุมัติ(approved) → จ่ายจริง(issued) → ยืนยันรับ(received)

app.post('/api/requisitions/:id/approve', requireRole('admin','nurse'), asyncH(async (req, res) => {
  const r = await get('SELECT * FROM requisitions WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'ไม่พบใบเบิก' });
  if (r.status !== 'รออนุมัติ' && r.status !== 'pending')
    return res.status(409).json({ error: `ใบเบิกนี้อยู่ในสถานะ "${r.status}" แล้ว` });
  await run("UPDATE requisitions SET status='อนุมัติแล้ว', note=?, approved_by=?, approved_at=?, processed_at=? WHERE id=?",
    [req.body.note||'', req.user.username, nowBKK(), nowBKK(), r.id]);
  await audit(req, 'approve_requisition', 'requisitions', r.id, { med: r.med_name, qty: r.qty });
  res.json({ ok: true });
}));

app.post('/api/requisitions/:id/reject', requireRole('admin','nurse'), asyncH(async (req, res) => {
  const r = await get('SELECT * FROM requisitions WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'ไม่พบใบเบิก' });
  if (r.status === 'จ่ายแล้ว' || r.status === 'รับของแล้ว')
    return res.status(409).json({ error: 'ใบเบิกนี้จ่ายยาไปแล้ว ไม่สามารถไม่อนุมัติได้' });
  await run("UPDATE requisitions SET status='ไม่อนุมัติ', note=?, approved_by=?, approved_at=?, processed_at=? WHERE id=?",
    [req.body.note||'', req.user.username, nowBKK(), nowBKK(), r.id]);
  await audit(req, 'reject_requisition', 'requisitions', r.id, { reason: req.body.note||'' });
  res.json({ ok: true });
}));

// จ่ายจริง — ตรงนี้เท่านั้นที่ตัดสต็อก (FEFO)
app.post('/api/requisitions/:id/issue', requireRole('admin','nurse'), asyncH(async (req, res) => {
  const r = await get('SELECT * FROM requisitions WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'ไม่พบใบเบิก' });
  if (r.status !== 'อนุมัติแล้ว')
    return res.status(409).json({ error: 'ต้องอนุมัติใบเบิกก่อนจึงจะจ่ายยาได้' });
  const amount = parseInt(r.qty) || 1;
  const fe = await consumeFEFO(r.med_id, amount, { type: 'requisition', id: r.id }, req.user.username);
  if (fe.error) return res.status(409).json({ error: fe.error + ' ' + r.unit });
  await run("UPDATE requisitions SET status='จ่ายแล้ว', issued_by=?, issued_at=? WHERE id=?",
    [req.user.username, nowBKK(), r.id]);
  await audit(req, 'issue_requisition', 'requisitions', r.id, { med: r.med_name, qty: amount, batches: fe.used });
  res.json({ ok: true, batches: fe.used });
}));

// ครูยืนยันรับของ (ผ่าน QR ได้ ไม่ต้อง login)
app.post('/api/requisitions/:id/receive', requireFormKey, asyncH(async (req, res) => {
  const r = await get('SELECT * FROM requisitions WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'ไม่พบใบเบิก' });
  if (r.status !== 'จ่ายแล้ว')
    return res.status(409).json({ error: 'ใบเบิกนี้ยังไม่ได้จ่ายยา' });
  await run("UPDATE requisitions SET status='รับของแล้ว', received_at=?, receiver_note=? WHERE id=?",
    [nowBKK(), req.body.note||'', r.id]);
  await audit(req, 'receive_requisition', 'requisitions', r.id, { teacher: r.teacher });
  res.json({ ok: true });
}));

// ยกเลิก (คืนสต็อกถ้าจ่ายไปแล้ว)
app.post('/api/requisitions/:id/cancel', requireRole('admin','nurse'), asyncH(async (req, res) => {
  const r = await get('SELECT * FROM requisitions WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'ไม่พบใบเบิก' });
  if (r.status === 'จ่ายแล้ว' || r.status === 'รับของแล้ว')
    await returnToBatches(r.med_id, r.id, req.user.username);
  await run("UPDATE requisitions SET status='ยกเลิก', note=? WHERE id=?", [req.body.note||'', r.id]);
  await audit(req, 'cancel_requisition', 'requisitions', r.id, {});
  res.json({ ok: true });
}));

// ทางเดิม (เข้ากันได้ย้อนหลัง)
app.put('/api/requisitions/:id', requireRole('admin','nurse'), asyncH(async (req, res) => {
  const { status, note } = req.body;
  await run('UPDATE requisitions SET status=?, note=?, processed_at=? WHERE id=?',
    [status, note||'', nowBKK(), req.params.id]);
  await audit(req, 'update_requisition', 'requisitions', req.params.id, { status });
  res.json({ ok: true });
}));

app.delete('/api/requisitions/:id', requireRole('admin'), asyncH(async (req, res) => {
  await run('DELETE FROM requisitions WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ─── STUDENTS (ฐานข้อมูลนักเรียน) ─────────────────────────────
app.get('/api/students/levels', asyncH(async (req, res) => {
  const rows = await all('SELECT DISTINCT level FROM students ORDER BY level');
  res.json(rows.map(r => r.level));
}));

app.get('/api/students/depts', asyncH(async (req, res) => {
  const { level } = req.query;
  let q = 'SELECT dept, COUNT(*) as cnt FROM students WHERE 1=1'; const p = [];
  if (level) { q += ' AND level=?'; p.push(level); }
  q += " AND dept != '' GROUP BY dept ORDER BY dept";
  res.json(await all(q, p));
}));

app.get('/api/students/rooms', asyncH(async (req, res) => {
  const { level, dept } = req.query;
  let q = 'SELECT room, dept, level, COUNT(*) as cnt FROM students WHERE 1=1'; const p = [];
  if (level) { q += ' AND level=?'; p.push(level); }
  if (dept)  { q += ' AND dept=?';  p.push(dept); }
  q += ' GROUP BY room, dept, level ORDER BY level, room';
  res.json(await all(q, p));
}));

// รายชื่อนักเรียนทั้งห้อง + สถานะการกรอกแบบคัดกรอง
app.get('/api/screenings/roster', requireAuth, asyncH(async (req, res) => {
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
}));

app.get('/api/students/list', requireFormKey, asyncH(async (req, res) => {
  const { level, room } = req.query;
  if (!level || !room) return res.json([]);
  res.json(await all(
    'SELECT sid, prefix, fname, lname, dept FROM students WHERE level=? AND room=? ORDER BY sid',
    [level, room]));
}));

// ─── STUDENTS CRUD (จัดการข้อมูลนักเรียน) ────────────────────
app.get('/api/students', requireAuth, asyncH(async (req, res) => {
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
}));

app.get('/api/students/photo/:sid', requireFormKey, asyncH(async (req, res) => {
  const r = await get('SELECT photo FROM students WHERE sid=?', [req.params.sid]);
  res.json({ photo: (r && r.photo) ? r.photo : '' });
}));

app.post('/api/students', requireRole('admin','nurse'), asyncH(async (req, res) => {
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
}));

app.put('/api/students/:sid', requireRole('admin','nurse'), asyncH(async (req, res) => {
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
}));

app.put('/api/students/:sid/photo', requireFormKey, asyncH(async (req, res) => {
  const { photo } = req.body;
  const stu = await get('SELECT sid FROM students WHERE sid=?', [req.params.sid]);
  if (!stu) return res.status(404).json({ error: 'ไม่พบนักเรียน' });
  await run('UPDATE students SET photo=? WHERE sid=?', [photo||'', req.params.sid]);
  res.json({ ok: true });
}));

app.delete('/api/students/:sid', requireRole('admin'), asyncH(async (req, res) => {
  await run('DELETE FROM screenings WHERE sid=?', [req.params.sid]);
  await run('DELETE FROM students WHERE sid=?', [req.params.sid]);
  res.json({ ok: true });
}));

// ─── SCREENINGS (คัดกรองสุขภาพ) ───────────────────────────────
app.get('/api/screenings', requireAuth, asyncH(async (req, res) => {
  const { level, room, search, term } = req.query;
  let q = 'SELECT * FROM screenings WHERE 1=1'; const p = [];
  if (level) { q += ' AND level=?'; p.push(level); }
  if (room)  { q += ' AND room=?';  p.push(room); }
  if (term)  { q += ' AND term=?';  p.push(term); }
  if (search){ q += ' AND (student_name LIKE ? OR sid LIKE ?)'; p.push('%'+search+'%','%'+search+'%'); }
  res.json(await all(q + ' ORDER BY level, room, sid', p));
}));

app.get('/api/screenings/stats', requireAuth, asyncH(async (req, res) => {
  const t = req.query.term;
  if (t) {
    const total    = await get('SELECT COUNT(*) as n FROM screenings WHERE term=?', [t]);
    const students = await get('SELECT COUNT(*) as n FROM students');
    const byLevel  = await all('SELECT level, COUNT(*) as n FROM screenings WHERE term=? GROUP BY level ORDER BY level', [t]);
    const risk     = await get("SELECT COUNT(*) as n FROM screenings WHERE term=? AND (congenital <> 'ไม่มี' OR drug_allergy <> 'ไม่มี')", [t]);
    return res.json({ total: total.n, students: students.n, byLevel, risk: risk.n, term: t });
  }
  const total    = await get('SELECT COUNT(*) as n FROM screenings');
  const students = await get('SELECT COUNT(*) as n FROM students');
  const byLevel  = await all('SELECT level, COUNT(*) as n FROM screenings GROUP BY level ORDER BY level');
  const risk     = await get("SELECT COUNT(*) as n FROM screenings WHERE congenital != 'ไม่มี' OR drug_allergy != 'ไม่มี'");
  res.json({ total: total.n, students: students.n, byLevel, risk: risk.n });
}));

app.post('/api/screenings', requireFormKey, asyncH(async (req, res) => {
  const b = req.body;
  if (!b.sid || !b.student_name) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  if (!b.term) b.term = await currentTerm();
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
}));

app.put('/api/screenings/:id', requireRole('admin','nurse'), asyncH(async (req, res) => {
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
}));

app.delete('/api/screenings/:id', requireRole('admin'), asyncH(async (req, res) => {
  await run('DELETE FROM screenings WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ─── QR CODE ─────────────────────────────────────────────────
app.get('/api/qr', requireAuth, asyncH(async (req, res) => {
  const url = `${BASE_URL}/student?k=${FORM_KEY}`;
  try {
    const dataUrl = await qrcode.toDataURL(url, { width:400, margin:2, color:{ dark:'#1a1a18', light:'#ffffff' } });
    res.json({ qr: dataUrl, url });
  } catch(e) { res.status(500).json({ error: e.message }); }
}));

app.get('/api/qr/teacher', requireAuth, asyncH(async (req, res) => {
  const url = `${BASE_URL}/teacher?k=${FORM_KEY}`;
  try {
    const dataUrl = await qrcode.toDataURL(url, { width:400, margin:2, color:{ dark:'#185FA5', light:'#ffffff' } });
    res.json({ qr: dataUrl, url });
  } catch(e) { res.status(500).json({ error: e.message }); }
}));


app.get('/api/qr/screening', requireAuth, asyncH(async (req, res) => {
  const url = `${BASE_URL}/screening?k=${FORM_KEY}`;
  try {
    const dataUrl = await qrcode.toDataURL(url, { width:400, margin:2, color:{ dark:'#7C3AED', light:'#ffffff' } });
    res.json({ qr: dataUrl, url });
  } catch(e) { res.status(500).json({ error: e.message }); }
}));


// ─── ภาคเรียน ────────────────────────────────────────────────
// รายการภาคเรียนทั้งหมดที่มีข้อมูล + ภาคเรียนปัจจุบัน
app.get('/api/terms', requireAuth, asyncH(async (req, res) => {
  const cur = await currentTerm();
  const rows = await all(`
    SELECT term, COUNT(*) as screenings FROM screenings
     WHERE term IS NOT NULL AND term <> '' GROUP BY term`);
  const dis = await all(`
    SELECT term, COUNT(*) as dispenses FROM dispenses
     WHERE term IS NOT NULL AND term <> '' GROUP BY term`);
  const map = {};
  rows.forEach(r => map[r.term] = { term: r.term, screenings: r.screenings, dispenses: 0 });
  dis.forEach(d => { map[d.term] = map[d.term] || { term: d.term, screenings: 0, dispenses: 0 };
                     map[d.term].dispenses = d.dispenses; });
  if (cur) map[cur] = map[cur] || { term: cur, screenings: 0, dispenses: 0 };
  const list = Object.values(map).sort((a,b) => b.term.localeCompare(a.term, 'th', { numeric: true }));
  res.json({ current: cur, terms: list });
}));

// เปลี่ยนภาคเรียนปัจจุบัน — ข้อมูลภาคเรียนเก่ายังอยู่ครบ ไม่ถูกลบ
app.put('/api/terms/current', requireRole('admin','nurse'), asyncH(async (req, res) => {
  const t = String(req.body.term || '').trim();
  if (!/^[1-3]\/25\d{2}$/.test(t))
    return res.status(400).json({ error: 'รูปแบบภาคเรียนต้องเป็น เช่น 1/2570 หรือ 2/2570' });
  const old = await currentTerm();
  await run("INSERT OR REPLACE INTO settings (key,value) VALUES ('current_term',?)", [t]);
  await audit(req, 'change_term', 'settings', 'current_term', { from: old, to: t });
  res.json({ ok: true, current: t });
}));

// ─── รายงานล็อต / ความเคลื่อนไหวสต็อก / รับ-จ่าย-คงเหลือ ────
app.get('/api/batches', requireAuth, asyncH(async (req, res) => {
  const { med_id, expiring } = req.query;
  let q = `SELECT b.*, m.name as med_name, m.unit
             FROM stock_batches b LEFT JOIN medicines m ON m.id = b.med_id
            WHERE 1=1`;
  const p = [];
  if (med_id) { q += ' AND b.med_id = ?'; p.push(med_id); }
  if (expiring === '1') q += " AND b.qty_remaining > 0 AND b.exp_date <> '' AND b.exp_date <= date('now','+60 days')";
  q += " ORDER BY CASE WHEN b.exp_date='' THEN 1 ELSE 0 END, b.exp_date ASC";
  res.json(await all(q, p));
}));

app.get('/api/stock-txn', requireAuth, asyncH(async (req, res) => {
  const { med_id, from, to } = req.query;
  let q = `SELECT t.*, m.name as med_name, m.unit, b.lot, b.exp_date
             FROM stock_txn t
             LEFT JOIN medicines m ON m.id = t.med_id
             LEFT JOIN stock_batches b ON b.id = t.batch_id
            WHERE 1=1`;
  const p = [];
  if (med_id) { q += ' AND t.med_id = ?'; p.push(med_id); }
  if (from)   { q += ' AND t.created_at >= ?'; p.push(from); }
  if (to)     { q += ' AND t.created_at <= ?'; p.push(to + ' 23:59:59'); }
  q += ' ORDER BY t.created_at DESC LIMIT 2000';
  res.json(await all(q, p));
}));

// รายงานรับ–จ่าย–คงเหลือ ตามช่วงเวลา
app.get('/api/reports/stock-movement', requireAuth, asyncH(async (req, res) => {
  const from = req.query.from || '1900-01-01';
  const to   = (req.query.to || '2999-12-31') + ' 23:59:59';
  const rows = await all(`
    SELECT m.id, m.name, m.unit, m.category, m.qty as balance,
           COALESCE((SELECT SUM(t.qty) FROM stock_txn t
                      WHERE t.med_id=m.id AND t.type='in'  AND t.created_at BETWEEN ? AND ?),0) as qty_in,
           COALESCE((SELECT SUM(t.qty) FROM stock_txn t
                      WHERE t.med_id=m.id AND t.type='out' AND t.created_at BETWEEN ? AND ?),0) as qty_out
      FROM medicines m ORDER BY m.name`, [from, to, from, to]);
  res.json({ from: req.query.from||'', to: req.query.to||'', rows });
}));

// ─── AUDIT LOG (ดูได้เฉพาะเจ้าหน้าที่) ───────────────────────
app.get('/api/audit', requireRole('admin'), asyncH(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit)||200, 1000);
  res.json(await all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?', [limit]));
}));

// ─── สร้าง FORM KEY ใหม่ (QR เก่าจะใช้ไม่ได้ทันที) ───────────
app.post('/api/form-key/regenerate', requireRole('admin'), asyncH(async (req, res) => {
  const nk = crypto.randomBytes(16).toString('hex');
  await run("INSERT OR REPLACE INTO settings (key,value) VALUES ('form_key',?)", [nk]);
  FORM_KEY = nk;
  await audit(req, 'regenerate_form_key', 'settings', 'form_key', {});
  res.json({ ok: true });
}));

// ─── สำรองข้อมูล (ดาวน์โหลดไฟล์ฐานข้อมูลทั้งก้อน) ───────────
app.get('/api/backup', requireRole('admin'), asyncH(async (req, res) => {
  const stamp = nowBKK().replace(/[: ]/g,'-');
  await audit(req, 'backup', 'database', '', {});
  res.setHeader('Content-Disposition', `attachment; filename="medstock-backup-${stamp}.db"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(dbPath).pipe(res);
}));

// ─── ตรวจสุขภาพระบบ (ให้ Railway เช็คได้) ───────────────────
app.get('/api/health', asyncH(async (req, res) => {
  const r = await get('SELECT COUNT(*) as n FROM medicines');
  res.json({ ok: true, medicines: r ? r.n : 0, time: nowBKK() });
}));

// ─── ROUTING ─────────────────────────────────────────────────
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student', 'index.html')));
app.get('/screening', (req, res) => res.sendFile(path.join(__dirname, 'public', 'screening', 'index.html')));
app.get('/teacher', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher', 'index.html')));
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/', (req, res) => res.redirect('/admin'));

// ─── ERROR HANDLER (ต้องอยู่หลัง route ทั้งหมด) ─────────────
app.use((err, req, res, next) => {
  console.error('[API ERROR]', req.method, req.originalUrl, '-', err && err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่' });
});

// ─── กันไม่ให้ process ตาย (เหตุผลหลักที่ระบบเคยล่ม) ────────
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.message ? err.message : err);
});

// ─── START ───────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🏥 MedStock on port ${PORT} | Admin: ${BASE_URL}/admin`);
  });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
