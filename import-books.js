// นำเข้ารายชื่อหนังสือจากไฟล์ Excel (คอลัมน์: ลำดับ, รหัส, ชื่อเต็มสินค้า)
// ใช้งาน: node import-books.js [ไฟล์.xlsx]   — รหัสที่มีอยู่แล้วจะอัปเดตชื่อ ไม่สร้างซ้ำ
// ไม่แตะยอดคงเหลือ: ยอดต้องบันทึกผ่านใบรับเข้าสินค้าเท่านั้น
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');

const file = process.argv[2] || path.join(__dirname, 'รายการหนังสือทั้งหมด.xlsx');
if (!fs.existsSync(file)) { console.error(`ไม่พบไฟล์ ${file}`); process.exit(1); }

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'stock.db');
if (!fs.existsSync(dbPath)) { console.error('ยังไม่มีฐานข้อมูล ให้เปิดโปรแกรม (node server.js) หนึ่งครั้งก่อน'); process.exit(1); }
const db = new DatabaseSync(dbPath);

const wb = XLSX.readFile(file);
// ถ้าชื่อในไฟล์เป็นแค่ส่วนต้นของชื่อเดิม (ถูกตัดท้ายในไฟล์) ให้คงชื่อเดิมที่ยาวกว่าไว้
const upsert = db.prepare(`INSERT INTO books (code, name, min_qty) VALUES (?, ?, 500)
                           ON CONFLICT(code) DO UPDATE SET name = excluded.name
                           WHERE substr(books.name, 1, length(excluded.name)) <> excluded.name`);
let count = 0;
db.exec('BEGIN');
for (const sheetName of wb.SheetNames) {
  for (const row of XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' })) {
    const code = String(row[1]).trim(), name = String(row[2]).trim().replace(/\s+/g, ' ');
    if (typeof row[0] !== 'number' || !code || !name) continue; // ข้ามหัวรายงาน/เส้นคั่น
    upsert.run(code, name);
    count++;
  }
}
db.exec('COMMIT');
console.log(`นำเข้าจาก "${path.basename(file)}" ${count} รายการ — ในระบบมีหนังสือทั้งหมด ${db.prepare('SELECT COUNT(*) c FROM books').get().c} รายการ`);
