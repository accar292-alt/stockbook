// คัดลอกข้อมูลจากฐานข้อมูลในเครื่อง (data/stock.db) ขึ้นฐานข้อมูล Turso ที่ใช้กับเว็บบน Vercel
// ใช้งาน: สร้างไฟล์ .env ที่มี TURSO_DATABASE_URL=... และ TURSO_AUTH_TOKEN=... แล้วรัน  node copy-to-turso.js
// ใช้ได้เฉพาะตอน Turso ยังว่างอยู่ (ยังไม่มีเอกสาร/หนังสือ) เพื่อไม่ให้ข้อมูลซ้ำหรือทับกัน
const path = require('path');
const { createClient } = require('@libsql/client');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* ใช้ตัวแปรจากระบบแทน */ }
const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken } = process.env;
if (!url || url.startsWith('file:')) { console.error('ยังไม่ได้ตั้ง TURSO_DATABASE_URL ในไฟล์ .env'); process.exit(1); }

const TABLES = {
  users: ['id', 'username', 'name', 'pass_hash', 'salt', 'role', 'active'],
  books: ['id', 'code', 'name', 'unit', 'min_qty', 'active'],
  settings: ['key', 'value'],
  docs: ['id', 'doc_no', 'type', 'year', 'seq', 'date', 'party', 'po_no', 'dept', 'reason', 'note',
         'created_by', 'created_at', 'cancelled', 'cancelled_by', 'cancelled_at'],
  doc_items: ['id', 'doc_id', 'book_id', 'qty'],
};

(async () => {
  const local = createClient({ url: 'file:' + path.join(__dirname, 'data', 'stock.db') });
  const remote = createClient({ url, authToken });

  // สร้างตารางบน Turso ด้วยโครงสร้างเดียวกับเซิร์ฟเวอร์ (server.js อ่าน TURSO_DATABASE_URL จาก .env ที่โหลดไว้แล้ว)
  await require('./server.js').ensureReady();

  const count = async (t) => (await remote.execute(`SELECT COUNT(*) c FROM ${t}`)).rows[0].c;
  if ((await count('docs')) > 0 || (await count('books')) > 0) {
    console.error('Turso มีข้อมูลอยู่แล้ว — หยุดเพื่อไม่ให้ข้อมูลซ้ำ');
    process.exit(1);
  }

  const stmts = [];
  for (const [table, cols] of Object.entries(TABLES)) {
    const rows = (await local.execute(`SELECT ${cols.join(', ')} FROM ${table}`)).rows;
    const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    for (const r of rows) stmts.push({ sql, args: cols.map((c) => r[c]) });
    console.log(`${table}: ${rows.length} แถว`);
  }
  await remote.batch(stmts, 'write'); // ทั้งหมดในธุรกรรมเดียว: สำเร็จทั้งหมดหรือไม่เข้าเลย

  const check = await remote.execute(`SELECT
    (SELECT COUNT(*) FROM books) books, (SELECT COUNT(*) FROM docs) docs,
    (SELECT COALESCE(SUM(CASE d.type WHEN 'IN' THEN i.qty ELSE -i.qty END), 0)
       FROM doc_items i JOIN docs d ON d.id = i.doc_id WHERE d.cancelled = 0) stock`);
  console.log('บน Turso ตอนนี้:', JSON.stringify(check.rows[0]));
  local.close(); remote.close();
})().catch((e) => { console.error('คัดลอกไม่สำเร็จ:', e.message); process.exit(1); });
