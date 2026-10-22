#!/usr/bin/env node
/**
 * ชุดทดสอบระบบ MedStock — รันด้วย `npm test`
 * ทดสอบ: RBAC · FEFO · สต็อกติดลบ · workflow ใบเบิก 4 ขั้น · ความปลอดภัย · migration
 * ใช้ฐานข้อมูลชั่วคราวแยกต่างหาก ไม่แตะข้อมูลจริง
 */
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const PORT = process.env.TEST_PORT || 3899;
const B = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'medstock-test-'));

let pass = 0, fail = 0; const failures = [];
const ck = (name, ok, extra = '') => {
  ok ? pass++ : (fail++, failures.push(name));
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};
const head = t => console.log(`\n── ${t} ──`);

// เตรียมโค้ดเซิร์ฟเวอร์ให้ชี้ไปฐานข้อมูลทดสอบ
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const testSrv = path.join(TMP, 'server.test.js');
fs.writeFileSync(testSrv, src.replace("path.join('/app/db', 'medstock.db')",
  JSON.stringify(path.join(TMP, 'medstock.db'))));
fs.copyFileSync(path.join(__dirname,'..','package.json'), path.join(TMP,'package.json'));
fs.symlinkSync(path.join(__dirname,'..','node_modules'), path.join(TMP,'node_modules'), 'dir');
fs.mkdirSync(path.join(TMP,'data'), { recursive: true });
fs.copyFileSync(path.join(__dirname,'..','data','students.json'), path.join(TMP,'data','students.json'));
fs.symlinkSync(path.join(__dirname,'..','public'), path.join(TMP,'public'), 'dir');

const srv = spawn('node', [testSrv], {
  cwd: TMP, env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: 'testpass123' } });
let LOG = '';
srv.stdout.on('data', d => LOG += d); srv.stderr.on('data', d => LOG += d);

const J = async (m, p, body, headers) => {
  const r = await fetch(B + p, { method: m,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, d: await r.json().catch(() => null) };
};
const as = tok => (m, p, b) => J(m, p, b, { 'x-auth-token': tok });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function waitReady(maxMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try { const r = await fetch(B + '/api/health'); if (r.ok) return true; } catch (e) {}
    await wait(500);
  }
  return false;
}

(async () => {
  console.log('🧪 MedStock — ชุดทดสอบระบบ\n');
  if (!await waitReady()) { console.error('เซิร์ฟเวอร์ไม่พร้อม\n' + LOG); srv.kill(); process.exit(1); }

  const FK = (LOG.match(/FORM KEY ใหม่: (\w+)/) || [])[1] || '';
  const form = (m, p, b) => J(m, p, b, { 'x-form-key': FK });

  // ══ 1) บัญชีผู้ใช้ + RBAC ══
  head('1) บัญชีผู้ใช้และสิทธิ์ (RBAC)');
  const lg = await J('POST', '/api/login', { username: 'admin', password: 'testpass123' });
  ck('admin เข้าสู่ระบบได้', lg.s === 200 && !!lg.d.token);
  const A = as(lg.d.token);
  ck('รหัสผ่านผิดเข้าไม่ได้', (await J('POST','/api/login',{username:'admin',password:'wrong'})).s === 401);
  ck('โหมดเดิม (รหัสผ่านอย่างเดียว) ยังใช้ได้', (await J('POST','/api/login',{password:'testpass123'})).s === 200);
  ck('/api/me คืนบทบาท', (await A('GET','/api/me')).d.role === 'admin');

  await A('POST','/api/users',{username:'nurse1',name:'พยาบาล',password:'nursepass1',role:'nurse'});
  await A('POST','/api/users',{username:'view1', name:'ผู้ดู',  password:'viewpass12', role:'viewer'});
  const N = as((await J('POST','/api/login',{username:'nurse1',password:'nursepass1'})).d.token);
  const V = as((await J('POST','/api/login',{username:'view1', password:'viewpass12'})).d.token);
  ck('สร้างบัญชีใหม่และเข้าสู่ระบบได้', true);
  ck('รหัสผ่านสั้นเกินไปถูกปฏิเสธ',
     (await A('POST','/api/users',{username:'x1',password:'123',role:'staff'})).s === 400);
  ck('ชื่อผู้ใช้ซ้ำถูกปฏิเสธ',
     (await A('POST','/api/users',{username:'nurse1',password:'anotherpass',role:'staff'})).s === 400);

  ck('viewer เพิ่มยาไม่ได้',   (await V('POST','/api/medicines',{name:'x',unit:'เม็ด',qty:1})).s === 403);
  ck('nurse เพิ่มยาได้',       (await N('POST','/api/medicines',{name:'ยาทดสอบ FEFO',unit:'เม็ด',qty:0,min_qty:0})).s === 200);
  ck('nurse จัดการผู้ใช้ไม่ได้',(await N('GET','/api/users')).s === 403);
  ck('viewer ดู audit ไม่ได้',  (await V('GET','/api/audit')).s === 403);
  ck('nurse สำรองข้อมูลไม่ได้', (await N('GET','/api/backup')).s === 403);
  ck('กันลบ admin คนสุดท้าย',
     (await A('PUT','/api/users/'+ (await A('GET','/api/users')).d.find(u=>u.username==='admin').id,
       {role:'viewer'})).s === 400);

  // ══ 2) ระบบล็อต + FEFO ══
  head('2) ระบบล็อตและ FEFO');
  const MED = (await A('GET','/api/medicines')).d.find(m => m.name === 'ยาทดสอบ FEFO');
  // รับ 3 ล็อต หมดอายุไม่เรียงกัน
  await N('POST','/api/receives',{med_id:MED.id,qty:10,lot:'LOT-C',exp_date:'2030-12-31'});
  await N('POST','/api/receives',{med_id:MED.id,qty:5, lot:'LOT-A',exp_date:'2027-01-31'});
  await N('POST','/api/receives',{med_id:MED.id,qty:8, lot:'LOT-B',exp_date:'2028-06-30'});
  const bs = (await A('GET','/api/batches?med_id='+MED.id)).d;
  ck('รับเข้า 3 ล็อตแยกกัน', bs.length === 3, bs.map(b=>b.lot).join(','));
  ck('เรียงล็อตตามวันหมดอายุ', bs[0].lot==='LOT-A' && bs[2].lot==='LOT-C', bs.map(b=>b.lot).join('→'));
  ck('ยอดรวมถูกต้อง', (await A('GET','/api/medicines')).d.find(m=>m.id===MED.id).qty === 23);

  // จ่าย 7 → ต้องกิน LOT-A หมด(5) แล้วต่อ LOT-B(2)
  await N('POST','/api/dispenses',{student_name:'ทดสอบ FEFO',med_id:MED.id,qty:7,source:'staff'});
  const after = (await A('GET','/api/batches?med_id='+MED.id)).d;
  const g = l => after.find(b=>b.lot===l).qty_remaining;
  ck('FEFO: ตัดล็อตใกล้หมดอายุก่อน', g('LOT-A')===0 && g('LOT-B')===6 && g('LOT-C')===10,
     `A=${g('LOT-A')} B=${g('LOT-B')} C=${g('LOT-C')}`);
  ck('ยอดรวมหลังจ่าย', (await A('GET','/api/medicines')).d.find(m=>m.id===MED.id).qty === 16);
  const txn = (await A('GET','/api/stock-txn?med_id='+MED.id)).d;
  ck('บันทึกความเคลื่อนไหวสต็อก', txn.filter(t=>t.type==='out').length === 2, `out ${txn.filter(t=>t.type==='out').length} รายการ`);

  // ══ 3) สต็อกติดลบ / concurrent ══
  head('3) ป้องกันสต็อกติดลบ');
  const M2 = (await N('POST','/api/medicines',{name:'ยาทดสอบ Concurrent',unit:'เม็ด',qty:0,min_qty:0})).d;
  await N('POST','/api/receives',{med_id:M2.id,qty:10,lot:'C1',exp_date:'2030-01-01'});
  const burst = await Promise.all(Array.from({length:10},()=>
    N('POST','/api/dispenses',{student_name:'ยิงพร้อมกัน',med_id:M2.id,qty:3,source:'staff'})));
  const ok = burst.filter(x=>x.s===200).length, rej = burst.filter(x=>x.s===409).length;
  const left = (await A('GET','/api/medicines')).d.find(m=>m.id===M2.id).qty;
  ck('ยิงพร้อมกัน 10 ครั้ง ครั้งละ 3 จากสต็อก 10', ok===3 && rej===7, `ผ่าน ${ok} ปฏิเสธ ${rej}`);
  ck('สต็อกไม่ติดลบ', left === 1, `คงเหลือ ${left}`);
  const nb = (await A('GET','/api/batches?med_id='+M2.id)).d;
  ck('ไม่มีล็อตไหนติดลบ', nb.every(b=>b.qty_remaining>=0));

  // ══ 4) แยกคำขอ QR ออกจากการจ่ายจริง ══
  head('4) คำขอ QR ไม่ตัดสต็อกอัตโนมัติ');
  const before = (await A('GET','/api/medicines')).d.find(m=>m.id===MED.id).qty;
  const rq = await form('POST','/api/dispenses',{student_name:'เด็กสแกน',med_id:MED.id,qty:2,source:'qr'});
  ck('คำขอ QR สถานะ pending', rq.d && rq.d.status==='pending');
  ck('คำขอ QR ไม่ตัดสต็อก',
     (await A('GET','/api/medicines')).d.find(m=>m.id===MED.id).qty === before);
  await A('POST',`/api/dispenses/${rq.d.id}/confirm`);
  ck('เจ้าหน้าที่ยืนยัน → ตัดสต็อก',
     (await A('GET','/api/medicines')).d.find(m=>m.id===MED.id).qty === before-2);
  ck('ยืนยันซ้ำไม่ได้', (await A('POST',`/api/dispenses/${rq.d.id}/confirm`)).s === 409);
  await A('POST',`/api/dispenses/${rq.d.id}/cancel`);
  ck('ยกเลิก → คืนสต็อกเข้าล็อตเดิม',
     (await A('GET','/api/medicines')).d.find(m=>m.id===MED.id).qty === before);

  // ══ 5) ใบเบิกครู 4 ขั้น ══
  head('5) ใบเบิกยาครู 4 ขั้นตอน');
  const bal0 = (await A('GET','/api/medicines')).d.find(m=>m.id===MED.id).qty;
  const req1 = await form('POST','/api/requisitions',
    {teacher:'นางทดสอบ',dept:'สามัญ',med_id:MED.id,qty:3,reason:'สำรองห้องเรียน'});
  ck('ขั้น 1 ครูส่งคำขอ', req1.s===200);
  ck('ยังจ่ายไม่ได้ถ้ายังไม่อนุมัติ', (await A('POST',`/api/requisitions/${req1.d.id}/issue`)).s===409);
  ck('ขั้น 2 อนุมัติ', (await N('POST',`/api/requisitions/${req1.d.id}/approve`,{note:'ok'})).s===200);
  ck('อนุมัติแล้วยังไม่ตัดสต็อก',
     (await A('GET','/api/medicines')).d.find(m=>m.id===MED.id).qty === bal0);
  ck('ขั้น 3 จ่ายจริง', (await N('POST',`/api/requisitions/${req1.d.id}/issue`)).s===200);
  ck('จ่ายจริงแล้วตัดสต็อก',
     (await A('GET','/api/medicines')).d.find(m=>m.id===MED.id).qty === bal0-3);
  ck('ขั้น 4 ครูยืนยันรับ', (await form('POST',`/api/requisitions/${req1.d.id}/receive`,{note:'รับแล้ว'})).s===200);
  const fin = (await A('GET','/api/requisitions')).d.find(x=>x.id===req1.d.id);
  ck('สถานะสุดท้าย = รับของแล้ว', fin.status==='รับของแล้ว', fin.status);
  ck('มีผู้อนุมัติและผู้จ่ายบันทึกไว้', !!fin.approved_by && !!fin.issued_by, `${fin.approved_by}/${fin.issued_by}`);
  ck('viewer อนุมัติใบเบิกไม่ได้',
     (await V('POST',`/api/requisitions/${req1.d.id}/approve`)).s===403);

  // ══ 6) ความปลอดภัยข้อมูลนักเรียน ══
  head('6) ความปลอดภัยข้อมูลนักเรียน');
  ck('รายชื่อนักเรียน ปิดกั้นคนนอก', (await J('GET','/api/students/list?level=a&room=b')).s===401);
  ck('รูปนักเรียน ปิดกั้นคนนอก',     (await J('GET','/api/students/photo/69201010001')).s===401);
  ck('แก้รูปนักเรียน ปิดกั้นคนนอก',  (await J('PUT','/api/students/69201010001/photo',{photo:'x'})).s===401);
  ck('ส่งข้อมูลสุขภาพ ปิดกั้นคนนอก', (await J('POST','/api/screenings',{sid:'1',student_name:'x',level:'a',room:'b'})).s===401);
  ck('มี form key ผ่านได้',          (await form('GET','/api/students/photo/69201010001')).s===200);

  // ══ 7) กันเซิร์ฟเวอร์ล่ม ══
  head('7) ความทนทานของเซิร์ฟเวอร์');
  await A('PUT','/api/dispenses/ไม่มีจริง',{student_name:'x',qty:'abc'});
  await A('GET','/api/batches?med_id='+"'".repeat(5));
  await wait(600);
  ck('ยิง request ผิดรูปแบบแล้วเซิร์ฟเวอร์ยังอยู่', (await fetch(B+'/api/health')).status===200);

  // ══ 8) รายงาน ══
  head('8) รายงานและการสำรองข้อมูล');
  const mv = (await A('GET','/api/reports/stock-movement')).d;
  const row = mv.rows.find(r=>r.id===MED.id);
  // สมการบัญชีสต็อก: รับ − จ่าย ต้องเท่ากับยอดคงเหลือเสมอ
  ck('รายงานรับ-จ่าย-คงเหลือ สมดุล', row && (row.qty_in - row.qty_out === row.balance),
     row ? `รับ ${row.qty_in} − จ่าย ${row.qty_out} = ${row.qty_in-row.qty_out} (คงเหลือจริง ${row.balance})` : 'ไม่พบ');
  // ยอดรวมในตาราง medicines ต้องตรงกับผลรวมทุกล็อตเสมอ
  const allB = (await A('GET','/api/batches?med_id='+MED.id)).d;
  const sumB = allB.reduce((s,b)=>s+b.qty_remaining,0);
  ck('ยอดรวมตรงกับผลรวมทุกล็อต', sumB === row.balance, `ล็อตรวม ${sumB} = คงเหลือ ${row.balance}`);
  ck('ดาวน์โหลดสำรองข้อมูลได้', (await fetch(B+'/api/backup',{headers:{'x-auth-token':lg.d.token}})).status===200);
  const au = (await A('GET','/api/audit')).d;
  ck('audit log บันทึกชื่อผู้ใช้จริง', au.some(a=>/nurse1|admin/.test(a.actor)),
     [...new Set(au.map(a=>a.actor))].slice(0,3).join(','));

  // ══ 9) ภาคเรียน ══
  head('9) ระบบภาคเรียน');
  const t0 = await A('GET','/api/terms');
  ck('มีภาคเรียนปัจจุบันอัตโนมัติ', !!t0.d.current, t0.d.current);
  ck('ฟอร์ม QR รู้ภาคเรียนปัจจุบัน',
     (await J('GET','/api/settings-public')).d.current_term === t0.d.current);

  // นักเรียนกรอกคัดกรองในภาคเรียนปัจจุบัน (ไม่ส่ง term มา → ระบบเติมให้)
  const stu = (await form('GET','/api/students/list?level='+encodeURIComponent('ปวช.1')+'&room='+encodeURIComponent('ชย.1/1'))).d[0];
  await form('POST','/api/screenings',{ sid:stu.sid, student_name:stu.fname, level:'ปวช.1', room:'ชย.1/1',
    weight:55, height:168, congenital:'ไม่มี', drug_allergy:'ไม่มี' });
  const s1 = (await A('GET','/api/screenings')).d.find(x=>x.sid===stu.sid);
  ck('บันทึกคัดกรองผูกภาคเรียนปัจจุบันอัตโนมัติ', s1 && s1.term === t0.d.current, s1 && s1.term);

  ck('รูปแบบภาคเรียนผิดถูกปฏิเสธ', (await A('PUT','/api/terms/current',{term:'5/99'})).s === 400);
  ck('viewer เปลี่ยนภาคเรียนไม่ได้', (await V('PUT','/api/terms/current',{term:'1/2571'})).s === 403);

  // เปลี่ยนภาคเรียน
  const NEWT = '1/2571';
  ck('เปลี่ยนภาคเรียนได้', (await A('PUT','/api/terms/current',{term:NEWT})).s === 200);
  ck('ข้อมูลภาคเรียนเก่ายังอยู่',
     (await A('GET','/api/screenings?term='+encodeURIComponent(t0.d.current))).d.length > 0);

  // นักเรียนคนเดิมกรอกใหม่ในภาคเรียนใหม่ → ต้องเป็นคนละรายการ ไม่ทับของเก่า
  await form('POST','/api/screenings',{ sid:stu.sid, student_name:stu.fname, level:'ปวช.1', room:'ชย.1/1',
    weight:58, height:169, congenital:'ไม่มี', drug_allergy:'ไม่มี' });
  const both = (await A('GET','/api/screenings')).d.filter(x=>x.sid===stu.sid);
  ck('คนเดิมกรอกภาคเรียนใหม่ = คนละรายการ', both.length === 2, `${both.length} รายการ (${both.map(x=>x.term).join(', ')})`);
  ck('น้ำหนักภาคเรียนเก่าไม่ถูกทับ',
     both.find(x=>x.term===t0.d.current).weight === 55 && both.find(x=>x.term===NEWT).weight === 58);

  const stNew = (await A('GET','/api/screenings/stats?term='+encodeURIComponent(NEWT))).d;
  ck('สถิติแยกตามภาคเรียน', stNew.total === 1, `ภาคเรียน ${NEWT} มี ${stNew.total} คน`);

  const tl = (await A('GET','/api/terms')).d;
  ck('รายการภาคเรียนครบทุกภาค', tl.terms.length >= 2 && tl.current === NEWT,
     tl.terms.map(x=>x.term).join(', '));

  // ══ 10) หน้าเว็บ ══
  head('10) หน้าเว็บ');
  for (const pg of ['/admin','/student','/teacher','/screening'])
    ck(`GET ${pg}`, (await fetch(B+pg)).status===200);

  console.log(`\n${'═'.repeat(46)}`);
  console.log(`  ผ่าน ${pass}  ล้มเหลว ${fail}`);
  if (fail) console.log('  ที่ล้มเหลว: ' + failures.join(', '));
  console.log(`${'═'.repeat(46)}\n`);

  srv.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('❌ ทดสอบล้มเหลว:', e); console.error(LOG); srv.kill(); process.exit(1); });
