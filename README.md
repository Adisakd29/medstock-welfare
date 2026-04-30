# 🏥 MedStock สวัสดิการ — คู่มือการติดตั้ง

ระบบจัดการยาและเวชภัณฑ์สำหรับงานสวัสดิการนักเรียน/นักศึกษา  
รองรับ QR Code สำหรับนักเรียนกรอกฟอร์มผ่านมือถือ

---

## โครงสร้างไฟล์

```
medstock/
├── server.js              ← API Server (Node.js + Express)
├── package.json
├── db/
│   └── medstock.db        ← SQLite database (สร้างอัตโนมัติ)
└── public/
    ├── student/
    │   └── index.html     ← หน้าฟอร์มสำหรับนักเรียน (สแกน QR)
    └── admin/
        └── index.html     ← Dashboard สำหรับครู/เจ้าหน้าที่
```

---

## วิธีติดตั้งบน Railway (ฟรี แนะนำ)

### ขั้นตอนที่ 1: สมัคร Railway
1. ไปที่ **https://railway.app**
2. กด **"Start a New Project"** → Login ด้วย GitHub
3. สมัครฟรี (ได้ $5/เดือน เพียงพอสำหรับระบบนี้)

### ขั้นตอนที่ 2: อัพโหลดโค้ด
1. สร้าง GitHub Repository ใหม่ (ชื่ออะไรก็ได้)
2. อัพโหลดไฟล์ทั้งหมดในโฟลเดอร์นี้ขึ้น GitHub
3. ใน Railway → **"New Project"** → **"Deploy from GitHub repo"**
4. เลือก repository ที่สร้างไว้

### ขั้นตอนที่ 3: ตั้งค่า Environment Variables
ใน Railway → Settings → Variables → เพิ่ม:

| Key | Value | คำอธิบาย |
|-----|-------|---------|
| `ADMIN_PASSWORD` | `welfare2567` | รหัสผ่านครู (เปลี่ยนได้) |
| `PORT` | `3000` | พอร์ต (Railway ตั้งให้อัตโนมัติ) |
| `BASE_URL` | `https://xxx.railway.app` | URL ของ app คุณ (ได้จาก Railway) |

### ขั้นตอนที่ 4: รับ URL
- Railway จะให้ URL เช่น `https://medstock-welfare.railway.app`
- เข้า **`/admin`** → Login ด้วยรหัสผ่าน
- เข้า **`/student`** → หน้าฟอร์มนักเรียน

---

## วิธีรันบนเครื่องตัวเอง (Localhost)

```bash
# 1. ติดตั้ง Node.js จาก https://nodejs.org (เลือก LTS)

# 2. เปิด Terminal ใน folder medstock แล้วรัน:
npm install

# 3. รัน server:
node server.js

# 4. เปิดเบราว์เซอร์:
#    Admin:   http://localhost:3000/admin
#    Student: http://localhost:3000/student
```

---

## การใช้งาน QR Code

1. Login เข้า **Admin** (`/admin`)
2. กดปุ่ม **"QR Code นักเรียน"** (ปุ่มเขียวบนแถบด้านบน)
3. กด **"พิมพ์ QR"** → พิมพ์และติดไว้ที่ห้องพยาบาล
4. นักเรียนสแกน QR → กรอกชื่อ ชั้น/ห้อง เลือกยา อาการ → กดส่ง
5. ข้อมูลจะปรากฏใน Dashboard ของครูทันที (อัพเดทอัตโนมัติทุก 8 วินาที)

---

## การเปลี่ยนรหัสผ่าน

**วิธีที่ 1 (Railway):** ไปที่ Variables → เปลี่ยน `ADMIN_PASSWORD`  
**วิธีที่ 2 (Local):** แก้ไขในไฟล์ `server.js` บรรทัด:
```js
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'welfare2567';
```

---

## URL สรุป

| หน้า | URL |
|------|-----|
| Admin Dashboard | `https://your-app.railway.app/admin` |
| ฟอร์มนักเรียน (QR) | `https://your-app.railway.app/student` |

---

## ฟีเจอร์ระบบ

- ✅ นักเรียนสแกน QR กรอกฟอร์มผ่านมือถือ
- ✅ หักสต็อกยาอัตโนมัติเมื่อนักเรียนส่งฟอร์ม
- ✅ Dashboard อัพเดท real-time (ทุก 8 วินาที)
- ✅ แยกช่องทาง QR vs เจ้าหน้าที่จ่าย
- ✅ แจ้งเตือนยาใกล้หมดอายุ / สต็อกต่ำ
- ✅ บันทึกรับยาเข้าคลัง
- ✅ Login ด้วยรหัสผ่าน
- ✅ พิมพ์ QR Code ได้โดยตรง
- ✅ ฐานข้อมูล SQLite (ไม่ต้องตั้งค่า database แยก)
