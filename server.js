// ระบบรับ-เบิกสต็อกหนังสือ : เซิร์ฟเวอร์ (Express + libSQL/SQLite)
// - รันในออฟฟิศ: node server.js  → ฐานข้อมูลไฟล์ data/stock.db
// - รันบน Vercel: api/index.js ใช้ app นี้ → ฐานข้อมูล Turso (ตั้ง TURSO_DATABASE_URL / TURSO_AUTH_TOKEN)
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const PORT = Number(process.env.PORT) || 3000;
const ON_VERCEL = !!process.env.VERCEL;
// บน Vercel ใช้ตัวเชื่อมแบบ HTTP ล้วน (ไม่ต้องมีไฟล์ native ของ SQLite)
const { createClient } = ON_VERCEL ? require('@libsql/client/web') : require('@libsql/client');

// ---------- database ----------
let dbUrl = (process.env.TURSO_DATABASE_URL || '').trim();
if (!dbUrl && !ON_VERCEL) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  dbUrl = 'file:' + path.join(dataDir, 'stock.db');
}
// ตั้งค่าผิดบน Vercel: ไม่ล้มทั้งฟังก์ชัน แต่ตอบข้อความบอกสาเหตุแทน (ดู ensureReady)
let configError = !dbUrl ? 'ยังไม่ได้ตั้งค่า TURSO_DATABASE_URL ใน Vercel (Settings → Environment Variables) แล้ว Redeploy' : '';
let client;
try {
  client = createClient({ url: dbUrl || 'libsql://unset.invalid', authToken: (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined });
} catch (e) {
  configError ||= `ค่า TURSO_DATABASE_URL ไม่ถูกต้อง: ${e.message}`;
}

// get/all/run บน client หรือบน transaction (ex = ตัวที่มี execute)
function wrap(ex) {
  const exec = (sql, args) => ex.execute({ sql, args });
  return {
    get: async (sql, ...args) => { const r = (await exec(sql, args)).rows[0]; return r ? { ...r } : undefined; },
    all: async (sql, ...args) => (await exec(sql, args)).rows.map((r) => ({ ...r })),
    run: async (sql, ...args) => { const r = await exec(sql, args); return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid) }; },
  };
}
const db = wrap(client);
async function tx(fn) {
  const t = await client.transaction('write');
  try { const r = await fn(wrap(t)); await t.commit(); return r; }
  catch (e) { await t.rollback().catch(() => {}); throw e; }
  finally { t.close(); }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff', active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'เล่ม', min_qty INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    price REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY, doc_no TEXT UNIQUE NOT NULL, type TEXT NOT NULL CHECK (type IN ('IN','OUT','DMG')),
    year INTEGER NOT NULL, seq INTEGER NOT NULL, date TEXT NOT NULL,
    party TEXT NOT NULL DEFAULT '', po_no TEXT NOT NULL DEFAULT '', dept TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    cancelled INTEGER NOT NULL DEFAULT 0, cancelled_by INTEGER REFERENCES users(id), cancelled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS doc_items (
    id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL REFERENCES docs(id),
    book_id INTEGER NOT NULL REFERENCES books(id), qty INTEGER NOT NULL CHECK (qty > 0)
  );
  CREATE INDEX IF NOT EXISTS idx_items_book ON doc_items(book_id);
  CREATE INDEX IF NOT EXISTS idx_items_doc ON doc_items(doc_id);
  CREATE INDEX IF NOT EXISTS idx_docs_date ON docs(date);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT OR IGNORE INTO settings VALUES ('org_name', 'บริษัท ยงสวัสดิ์ อินเตอร์กรุ๊ป จำกัด (สำนักงานใหญ่)');
  -- ครั้งเดียว: ตั้งยอดขั้นต่ำเริ่มต้น 500 ให้หนังสือที่ยังไม่ได้กำหนด (เตือนเมื่อคงเหลือต่ำกว่านี้)
  UPDATE books SET min_qty = 500 WHERE min_qty = 0 AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'min_qty_500');
  INSERT OR IGNORE INTO settings VALUES ('min_qty_500', '1');
  -- ผู้ใช้กลางสำหรับโหมดไม่ต้องเข้าสู่ระบบ (active = 0 จึงใช้ล็อกอินไม่ได้)
  INSERT OR IGNORE INTO users (username, name, pass_hash, salt, role, active) VALUES ('system', 'ไม่ระบุผู้ใช้', '', '', 'admin', 0);
`;

async function migrate() {
  await client.executeMultiple(SCHEMA);
  // ฐานข้อมูลรุ่นแรกใช้ช่อง "หน่วยงาน" (dept) — ย้ายไปเป็นเลขที่ใบสั่งซื้อ (po_no) แล้วเพิ่มช่องชื่อหน่วยงาน (dept) กลับมาแยกต่างหาก
  const docCols = (await db.all(`SELECT name FROM pragma_table_info('docs')`)).map((c) => c.name);
  if (!docCols.includes('po_no')) await db.run('ALTER TABLE docs RENAME COLUMN dept TO po_no');
  if (!docCols.includes('po_no') || !docCols.includes('dept')) await db.run(`ALTER TABLE docs ADD COLUMN dept TEXT NOT NULL DEFAULT ''`);
  // เพิ่มประเภทเอกสาร DMG (ตัดชำรุด/เสียหาย) และช่องสาเหตุ: SQLite แก้ CHECK ไม่ได้ จึงสร้างตาราง docs ใหม่แล้วย้ายข้อมูล
  if (!(await db.get(`SELECT sql FROM sqlite_master WHERE name = 'docs'`)).sql.includes("'DMG'")) {
    await client.executeMultiple(`PRAGMA foreign_keys = OFF; BEGIN;
      CREATE TABLE docs_new (
        id INTEGER PRIMARY KEY, doc_no TEXT UNIQUE NOT NULL, type TEXT NOT NULL CHECK (type IN ('IN','OUT','DMG')),
        year INTEGER NOT NULL, seq INTEGER NOT NULL, date TEXT NOT NULL,
        party TEXT NOT NULL DEFAULT '', po_no TEXT NOT NULL DEFAULT '', dept TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
        cancelled INTEGER NOT NULL DEFAULT 0, cancelled_by INTEGER REFERENCES users(id), cancelled_at TEXT
      );
      INSERT INTO docs_new (id, doc_no, type, year, seq, date, party, po_no, dept, note, created_by, created_at, cancelled, cancelled_by, cancelled_at)
        SELECT id, doc_no, type, year, seq, date, party, po_no, dept, note, created_by, created_at, cancelled, cancelled_by, cancelled_at FROM docs;
      DROP TABLE docs;
      ALTER TABLE docs_new RENAME TO docs;
      CREATE INDEX IF NOT EXISTS idx_docs_date ON docs(date);
      COMMIT; PRAGMA foreign_keys = ON;`);
  }
  // ราคาปก (แสดงอย่างเดียว ไม่ใช้คำนวณยอดรับ-เบิก) + ใส่ราคาจากไฟล์ครั้งเดียว
  const bookCols = (await db.all(`SELECT name FROM pragma_table_info('books')`)).map((c) => c.name);
  if (!bookCols.includes('price')) await db.run('ALTER TABLE books ADD COLUMN price REAL NOT NULL DEFAULT 0');
  if (!(await db.get(`SELECT 1 FROM settings WHERE key = 'prices_2026_10_26'`)) && (await db.get('SELECT COUNT(*) c FROM books')).c > 0) {
    const { prices } = require('./seed/prices-2026-10-26.json');
    await client.batch([
      ...Object.entries(prices).map(([code, price]) => ({ sql: 'UPDATE books SET price = ? WHERE code = ?', args: [price, code] })),
      `INSERT OR IGNORE INTO settings VALUES ('prices_2026_10_26', '1')`,
    ], 'write');
  }
  SYSTEM_USER = await db.get(`SELECT id, username, name, role FROM users WHERE username = 'system'`);
}
let SYSTEM_USER;
let ready = null;
const ensureReady = () => (ready ??= (async () => {
  if (configError) throw new HttpError(500, configError);
  try { await migrate(); }
  catch (e) { throw new HttpError(500, `เชื่อมต่อฐานข้อมูลไม่ได้: ${e.message}`); }
})().catch((e) => { ready = null; throw e; }));

const DOC_PREFIX = { IN: 'รับ', OUT: 'เบิก', DMG: 'ชำรุด' };
const DMG_REASONS = ['ชำรุด', 'เสียหาย', 'สูญหาย', 'พิมพ์ผิด', 'อื่น ๆ'];

// เปิด/ปิดการเข้าสู่ระบบ: ตัวแปร REQUIRE_LOGIN (true/false) มาก่อน, ถัดมาคือ config.json
// บน Vercel (เว็บสาธารณะ) บังคับเข้าสู่ระบบเสมอ
function readRequireLogin() {
  if (ON_VERCEL) return true;
  if (process.env.REQUIRE_LOGIN) return process.env.REQUIRE_LOGIN === 'true';
  const file = path.join(__dirname, 'config.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ requireLogin: false }, null, 2));
  return JSON.parse(fs.readFileSync(file, 'utf8')).requireLogin === true;
}
const REQUIRE_LOGIN = readRequireLogin();
const REAL_USERS = `SELECT COUNT(*) c FROM users WHERE username <> 'system'`;

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(Date.parse(v));
const posInt = (v) => Number.isInteger(v) && v > 0 && v <= 1e7;
const now = () => new Date().toISOString();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 6) fail(400, 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร');
  return password;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SIGNED = `CASE d.type WHEN 'IN' THEN i.qty ELSE -i.qty END`;
const STOCK_SQL = `COALESCE((SELECT SUM(${SIGNED}) FROM doc_items i JOIN docs d ON d.id = i.doc_id
                   WHERE i.book_id = b.id AND d.cancelled = 0), 0)`;
const stockOf = async (q, bookId) => (await q.get(`SELECT ${STOCK_SQL} AS s FROM books b WHERE b.id = ?`, bookId))?.s ?? 0;
const setting = async (key) => (await db.get('SELECT value FROM settings WHERE key = ?', key))?.value ?? '';

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  await ensureReady();
  if (!REQUIRE_LOGIN) { req.user = SYSTEM_USER; return next(); }
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (m) {
    req.sid = sha(m[1]);
    req.user = await db.get(`SELECT u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
                             WHERE s.token_hash = ? AND s.expires > ? AND u.active = 1`, req.sid, Date.now());
  }
  next();
});
const auth = (req, res, next) => (req.user ? next() : fail(401, 'กรุณาเข้าสู่ระบบ'));
// ฝ่ายขาย (sales) ดูรายการหนังสือและยอดคงเหลือได้อย่างเดียว: ห้ามบันทึกเอกสาร ดูประวัติ/รายงาน/บัตรสต็อก
const staff = (req, res, next) =>
  !req.user ? fail(401, 'กรุณาเข้าสู่ระบบ') : req.user.role === 'sales' ? fail(403, 'ฝ่ายขายดูรายการหนังสือได้อย่างเดียว') : next();
const ROLES = ['admin', 'staff', 'sales'];
const parseRole = (r) => (ROLES.includes(r) ? r : 'staff');
const admin = (req, res, next) =>
  !req.user ? fail(401, 'กรุณาเข้าสู่ระบบ') : req.user.role === 'admin' ? next() : fail(403, 'เฉพาะผู้ดูแลระบบ');

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = 30 * 24 * 3600;
  await db.run('DELETE FROM sessions WHERE expires < ?', Date.now());
  await db.run('INSERT INTO sessions VALUES (?, ?, ?)', sha(token), userId, Date.now() + maxAge * 1000);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.set('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

// ---------- auth ----------
app.get('/api/state', async (req, res) => {
  const needSetup = REQUIRE_LOGIN && (await db.get(REAL_USERS)).c === 0;
  res.json({ needSetup, requireLogin: REQUIRE_LOGIN, user: req.user || null, orgName: await setting('org_name') });
});

app.post('/api/setup', async (req, res) => {
  const username = str(req.body.username, 40).toLowerCase(), name = str(req.body.name, 80);
  if (!username || !name) fail(400, 'กรอกชื่อผู้ใช้และชื่อ-สกุลให้ครบ');
  const { salt, hash } = hashPassword(checkPassword(req.body.password));
  const id = await tx(async (q) => {
    if ((await q.get(REAL_USERS)).c > 0) fail(403, 'ตั้งค่าระบบไปแล้ว');
    return (await q.run(`INSERT INTO users (username, name, pass_hash, salt, role) VALUES (?, ?, ?, ?, 'admin')`,
      username, name, hash, salt)).lastInsertRowid;
  });
  await startSession(req, res, id);
  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE username = ? AND active = 1', str(req.body.username, 40).toLowerCase());
  const given = hashPassword(String(req.body.password ?? ''), u ? u.salt : 'x').hash;
  if (!u || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(u.pass_hash)))
    fail(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  await startSession(req, res, u.id);
  res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
  if (req.sid) await db.run('DELETE FROM sessions WHERE token_hash = ?', req.sid);
  res.set('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.post('/api/password', auth, async (req, res) => {
  if (!REQUIRE_LOGIN) fail(400, 'ระบบยังไม่เปิดใช้การเข้าสู่ระบบ');
  const u = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (hashPassword(String(req.body.current ?? ''), u.salt).hash !== u.pass_hash) fail(400, 'รหัสผ่านเดิมไม่ถูกต้อง');
  const { salt, hash } = hashPassword(checkPassword(req.body.password));
  await db.run('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?', hash, salt, u.id);
  await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', u.id, req.sid);
  res.json({ ok: true });
});

// ---------- users (admin) ----------
app.get('/api/users', admin, async (req, res) => {
  res.json(await db.all(`SELECT id, username, name, role, active FROM users WHERE username <> 'system' ORDER BY id`));
});

app.post('/api/users', admin, async (req, res) => {
  const username = str(req.body.username, 40).toLowerCase(), name = str(req.body.name, 80);
  const role = parseRole(req.body.role);
  if (!username || !name) fail(400, 'กรอกชื่อผู้ใช้และชื่อ-สกุลให้ครบ');
  if (await db.get('SELECT 1 FROM users WHERE username = ?', username)) fail(400, 'ชื่อผู้ใช้นี้มีอยู่แล้ว');
  const { salt, hash } = hashPassword(checkPassword(req.body.password));
  await db.run('INSERT INTO users (username, name, pass_hash, salt, role) VALUES (?, ?, ?, ?, ?)', username, name, hash, salt, role);
  res.json({ ok: true });
});

app.put('/api/users/:id', admin, async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!u || u.username === 'system') fail(404, 'ไม่พบผู้ใช้');
  const name = str(req.body.name ?? u.name, 80) || u.name;
  const role = req.body.role === undefined ? u.role : parseRole(req.body.role);
  const active = req.body.active === undefined ? u.active : req.body.active ? 1 : 0;
  if (id === req.user.id && (role !== 'admin' || !active)) fail(400, 'ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตนเองได้');
  await db.run('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?', name, role, active, id);
  if (req.body.password) {
    const { salt, hash } = hashPassword(checkPassword(req.body.password));
    await db.run('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?', hash, salt, id);
  }
  if (req.body.password || !active) await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', id, req.sid ?? '');
  res.json({ ok: true });
});

app.put('/api/settings', admin, async (req, res) => {
  const orgName = str(req.body.orgName, 200);
  if (!orgName) fail(400, 'กรอกชื่อหน่วยงาน');
  await db.run(`INSERT INTO settings VALUES ('org_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, orgName);
  res.json({ ok: true });
});

// ---------- books ----------
const listBooks = () => db.all(`SELECT b.*, ${STOCK_SQL} AS stock FROM books b ORDER BY b.code`);
app.get('/api/books', auth, async (req, res) => res.json(await listBooks()));

function bookInput(body) {
  const b = { code: str(body.code, 40), name: str(body.name, 300), unit: str(body.unit, 20) || 'เล่ม',
              min_qty: Number(body.min_qty) || 0, active: body.active === false || body.active === 0 ? 0 : 1,
              price: Math.round((Number(body.price) || 0) * 100) / 100 };
  if (!b.code || !b.name) fail(400, 'กรอกรหัสและชื่อหนังสือให้ครบ');
  if (!Number.isInteger(b.min_qty) || b.min_qty < 0) fail(400, 'ยอดขั้นต่ำไม่ถูกต้อง');
  if (!(b.price >= 0 && b.price < 1e6)) fail(400, 'ราคาไม่ถูกต้อง');
  return b;
}
app.post('/api/books', admin, async (req, res) => {
  const b = bookInput(req.body);
  if (await db.get('SELECT 1 FROM books WHERE code = ?', b.code)) fail(400, 'รหัสหนังสือนี้มีอยู่แล้ว');
  await db.run('INSERT INTO books (code, name, unit, min_qty, active, price) VALUES (?, ?, ?, ?, ?, ?)', b.code, b.name, b.unit, b.min_qty, b.active, b.price);
  res.json({ ok: true });
});
app.put('/api/books/:id', admin, async (req, res) => {
  const id = Number(req.params.id), b = bookInput(req.body);
  if (await db.get('SELECT 1 FROM books WHERE code = ? AND id <> ?', b.code, id)) fail(400, 'รหัสหนังสือนี้มีอยู่แล้ว');
  const r = await db.run('UPDATE books SET code = ?, name = ?, unit = ?, min_qty = ?, active = ?, price = ? WHERE id = ?',
    b.code, b.name, b.unit, b.min_qty, b.active, b.price, id);
  if (!r.changes) fail(404, 'ไม่พบหนังสือ');
  res.json({ ok: true });
});

// บัตรสต็อก: ความเคลื่อนไหวของหนังสือ 1 เล่ม พร้อมยอดคงเหลือสะสม
app.get('/api/books/:id/card', staff, async (req, res) => {
  const book = await db.get('SELECT * FROM books WHERE id = ?', Number(req.params.id));
  if (!book) fail(404, 'ไม่พบหนังสือ');
  let balance = 0;
  const rows = (await db.all(`SELECT d.id doc_id, d.doc_no, d.type, d.date, d.party, d.po_no, d.dept, d.reason, i.qty
                              FROM doc_items i JOIN docs d ON d.id = i.doc_id
                              WHERE i.book_id = ? AND d.cancelled = 0 ORDER BY d.date, d.id`, book.id))
    .map((r) => ({ ...r, balance: (balance += r.type === 'IN' ? r.qty : -r.qty) }));
  res.json({ book, rows });
});

// ---------- documents (ใบรับ / ใบเบิก / ใบตัดชำรุด) ----------
app.post('/api/docs', staff, async (req, res) => {
  const type = DOC_PREFIX[req.body.type] ? req.body.type : fail(400, 'ประเภทเอกสารไม่ถูกต้อง');
  const date = isDate(req.body.date) ? req.body.date : fail(400, 'วันที่ไม่ถูกต้อง');
  // ผู้เบิก / ผู้รายงาน = ผู้ที่ login อยู่เสมอ, ใบรับเก็บเลขที่ใบรับงานในช่อง party (ผู้รับ = created_by)
  const party = type === 'IN' ? str(req.body.party, 120) : req.user.name, po_no = str(req.body.po_no, 120), dept = str(req.body.dept, 120), note = str(req.body.note, 300);
  const reason = type === 'DMG' ? str(req.body.reason, 40) : '';
  if (type === 'DMG' && !DMG_REASONS.includes(reason)) fail(400, 'เลือกสาเหตุ');
  if (!Array.isArray(req.body.items) || !req.body.items.length) fail(400, 'ยังไม่มีรายการหนังสือ');
  const items = new Map(); // รวมรายการซ้ำของหนังสือเล่มเดียวกัน
  for (const it of req.body.items) {
    if (!posInt(it.book_id) || !posInt(it.qty)) fail(400, 'จำนวนต้องเป็นจำนวนเต็มมากกว่า 0');
    items.set(it.book_id, (items.get(it.book_id) || 0) + it.qty);
  }
  const doc = await tx(async (q) => {
    for (const [bookId, qty] of items) {
      const b = await q.get('SELECT * FROM books WHERE id = ?', bookId);
      if (!b) fail(400, 'ไม่พบหนังสือในระบบ');
      const stock = await stockOf(q, bookId);
      if (type !== 'IN' && qty > stock) fail(400, `"${b.name}" คงเหลือ ${stock} ${b.unit} ไม่พอ${type === 'DMG' ? 'ตัดชำรุด' : 'เบิก'} ${qty}`);
    }
    const year = Number(date.slice(0, 4)) + 543;
    const seq = (await q.get('SELECT COALESCE(MAX(seq), 0) + 1 n FROM docs WHERE type = ? AND year = ?', type, year)).n;
    const docNo = `${DOC_PREFIX[type]}-${year}-${String(seq).padStart(4, '0')}`;
    const id = (await q.run(`INSERT INTO docs (doc_no, type, year, seq, date, party, po_no, dept, reason, note, created_by, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      docNo, type, year, seq, date, party, po_no, dept, reason, note, req.user.id, now())).lastInsertRowid;
    for (const [bookId, qty] of items) await q.run('INSERT INTO doc_items (doc_id, book_id, qty) VALUES (?, ?, ?)', id, bookId, qty);
    return { id, doc_no: docNo };
  });
  res.json(doc);
});

function docFilter(q) {
  const where = [], args = [];
  if (DOC_PREFIX[q.type]) { where.push('d.type = ?'); args.push(q.type); }
  if (isDate(q.from)) { where.push('d.date >= ?'); args.push(q.from); }
  if (isDate(q.to)) { where.push('d.date <= ?'); args.push(q.to); }
  if (q.q) {
    where.push(`(d.doc_no LIKE ? OR d.party LIKE ? OR d.po_no LIKE ? OR d.dept LIKE ? OR d.reason LIKE ? OR d.note LIKE ?)`);
    const like = `%${str(q.q, 80)}%`; args.push(like, like, like, like, like, like);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

app.get('/api/docs', staff, async (req, res) => {
  const f = docFilter(req.query);
  res.json(await db.all(`SELECT d.id, d.doc_no, d.type, d.date, d.party, d.po_no, d.dept, d.reason, d.note, d.cancelled, u.name created_by,
                           (SELECT COUNT(*) FROM doc_items i WHERE i.doc_id = d.id) item_count,
                           (SELECT SUM(qty) FROM doc_items i WHERE i.doc_id = d.id) total_qty
                         FROM docs d JOIN users u ON u.id = d.created_by ${f.sql}
                         ORDER BY d.date DESC, d.id DESC LIMIT 1000`, ...f.args));
});

app.get('/api/docs/:id', staff, async (req, res) => {
  const doc = await db.get(`SELECT d.*, u.name created_by_name, c.name cancelled_by_name FROM docs d
                            JOIN users u ON u.id = d.created_by LEFT JOIN users c ON c.id = d.cancelled_by
                            WHERE d.id = ?`, Number(req.params.id));
  if (!doc) fail(404, 'ไม่พบเอกสาร');
  doc.items = await db.all(`SELECT b.code, b.name, b.unit, b.price, i.qty FROM doc_items i JOIN books b ON b.id = i.book_id
                            WHERE i.doc_id = ? ORDER BY i.id`, doc.id);
  res.json({ doc, orgName: await setting('org_name') });
});

// ยกเลิกเอกสาร (ไม่ลบทิ้ง เพื่อให้ตรวจสอบย้อนหลังได้)
app.post('/api/docs/:id/cancel', admin, async (req, res) => {
  await tx(async (q) => {
    const doc = await q.get('SELECT * FROM docs WHERE id = ?', Number(req.params.id));
    if (!doc) fail(404, 'ไม่พบเอกสาร');
    if (doc.cancelled) fail(400, 'เอกสารนี้ถูกยกเลิกไปแล้ว');
    if (doc.type === 'IN') {
      const items = await q.all(`SELECT i.book_id, i.qty, b.name FROM doc_items i JOIN books b ON b.id = i.book_id
                                 WHERE i.doc_id = ?`, doc.id);
      for (const it of items)
        if ((await stockOf(q, it.book_id)) - it.qty < 0) fail(400, `ยกเลิกไม่ได้: "${it.name}" ถูกเบิกออกไปแล้ว ยอดจะติดลบ`);
    }
    await q.run('UPDATE docs SET cancelled = 1, cancelled_by = ?, cancelled_at = ? WHERE id = ?', req.user.id, now(), doc.id);
  });
  res.json({ ok: true });
});

// ---------- reports ----------
// ส่งออก Excel ได้เฉพาะผู้ดูแล (เจ้าหน้าที่ดูรายงานบนหน้าจอและพิมพ์ได้ แต่ดาวน์โหลดไฟล์ไม่ได้)
async function summary(from, to) {
  return (await db.all(`
    SELECT b.id, b.code, b.name, b.unit, b.price,
      COALESCE(SUM(CASE WHEN d.date < ? THEN ${SIGNED} END), 0) opening,
      COALESCE(SUM(CASE WHEN d.date BETWEEN ? AND ? AND d.type = 'IN' THEN i.qty END), 0) qty_in,
      COALESCE(SUM(CASE WHEN d.date BETWEEN ? AND ? AND d.type = 'OUT' THEN i.qty END), 0) qty_out,
      COALESCE(SUM(CASE WHEN d.date BETWEEN ? AND ? AND d.type = 'DMG' THEN i.qty END), 0) qty_dmg
    FROM books b
    LEFT JOIN doc_items i ON i.book_id = b.id
    LEFT JOIN docs d ON d.id = i.doc_id AND d.cancelled = 0
    GROUP BY b.id ORDER BY b.code`, from, from, to, from, to, from, to))
    .map((r) => ({ ...r, closing: r.opening + r.qty_in - r.qty_out - r.qty_dmg }));
}
function range(q) {
  if (!isDate(q.from) || !isDate(q.to) || q.from > q.to) fail(400, 'ช่วงวันที่ไม่ถูกต้อง');
  return [q.from, q.to];
}
app.get('/api/report/summary', staff, async (req, res) => res.json(await summary(...range(req.query))));

// priceCol = คอลัมน์ราคาปก (เริ่ม 0) ให้แสดงแบบ #,##0.00 — เป็นข้อมูลอ้างอิง ไม่มีสูตรคำนวณ
function sendXlsx(res, filename, sheetName, rows, widths, priceCol) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = widths.map((wch) => ({ wch }));
  if (priceCol !== undefined)
    for (let r = 4; r < rows.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: priceCol })];
      if (cell && cell.t === 'n') cell.z = '#,##0.00';
    }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

app.get('/api/export/stock.xlsx', admin, async (req, res) => {
  const rows = [[await setting('org_name')], ['รายงานสต็อกคงเหลือ ณ วันที่ ' + now().slice(0, 10)], [],
    ['รหัส', 'ชื่อหนังสือ', 'หน่วย', 'ราคาปก (บาท)', 'คงเหลือ', 'ยอดขั้นต่ำ', 'สถานะ']];
  const onlyLow = req.query.low === '1';
  if (onlyLow) rows[1] = ['รายงานหนังสือที่ยอดคงเหลือต่ำกว่าขั้นต่ำ ณ วันที่ ' + now().slice(0, 10)];
  for (const b of await listBooks()) {
    const low = b.min_qty > 0 && b.stock < b.min_qty;
    if (b.active && (low || !onlyLow)) rows.push([b.code, b.name, b.unit, b.price, b.stock, b.min_qty, low ? 'ต่ำกว่าขั้นต่ำ' : '']);
  }
  sendXlsx(res, onlyLow ? 'low-stock.xlsx' : 'stock.xlsx', 'คงเหลือ', rows, [12, 60, 8, 13, 10, 12, 16], 3);
});

app.get('/api/export/summary.xlsx', admin, async (req, res) => {
  const [from, to] = range(req.query);
  const rows = [[await setting('org_name')], [`รายงานสรุปรับ-เบิก ตั้งแต่ ${from} ถึง ${to}`], [],
    ['รหัส', 'ชื่อหนังสือ', 'หน่วย', 'ราคาปก (บาท)', 'ยกมา', 'รับ', 'เบิก', 'ชำรุด/เสียหาย', 'คงเหลือ']];
  for (const r of await summary(from, to)) rows.push([r.code, r.name, r.unit, r.price, r.opening, r.qty_in, r.qty_out, r.qty_dmg, r.closing]);
  sendXlsx(res, `summary_${from}_${to}.xlsx`, 'สรุปรับ-เบิก', rows, [12, 60, 8, 13, 10, 10, 10, 14, 10], 3);
});

app.get('/api/export/movements.xlsx', admin, async (req, res) => {
  const [from, to] = range(req.query);
  const rows = [[await setting('org_name')], [`รายการรับ-เบิก ตั้งแต่ ${from} ถึง ${to}`], [],
    ['วันที่', 'เลขที่เอกสาร', 'ประเภท', 'รหัส', 'ชื่อหนังสือ', 'ราคาปก (บาท)', 'จำนวน', 'หน่วย', 'ผู้เบิก/ใบรับงาน/ผู้รายงาน', 'ใบสั่งซื้อเลขที่', 'หน่วยงาน', 'สาเหตุ', 'หมายเหตุ', 'ผู้บันทึก']];
  const data = await db.all(`SELECT d.date, d.doc_no, d.type, b.code, b.name, b.price, i.qty, b.unit, d.party, d.po_no, d.dept, d.reason, d.note, u.name uname
                             FROM doc_items i JOIN docs d ON d.id = i.doc_id JOIN books b ON b.id = i.book_id
                             JOIN users u ON u.id = d.created_by
                             WHERE d.cancelled = 0 AND d.date BETWEEN ? AND ? ORDER BY d.date, d.id, i.id`, from, to);
  for (const r of data)
    rows.push([r.date, r.doc_no, DOC_PREFIX[r.type], r.code, r.name, r.price, r.qty, r.unit, r.party, r.po_no, r.dept, r.reason, r.note, r.uname]);
  sendXlsx(res, `movements_${from}_${to}.xlsx`, 'รายการ', rows, [12, 16, 8, 12, 60, 13, 8, 8, 24, 20, 28, 12, 30, 20], 5);
});

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'ไม่พบรายการที่เรียก' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err instanceof HttpError ? err.message : 'เกิดข้อผิดพลาดในระบบ' });
});

module.exports = app;
app.ensureReady = ensureReady; // ให้ copy-to-turso.js สร้างตารางบน Turso ก่อนคัดลอก

// รันตรง (node server.js / start.bat) = เปิดเซิร์ฟเวอร์ในออฟฟิศ
if (require.main === module) {
  ensureReady().then(() => app.listen(PORT, '0.0.0.0', (err) => {
    if (err) {
      console.error(err.code === 'EADDRINUSE' ? `พอร์ต ${PORT} ถูกใช้อยู่ — โปรแกรมอาจเปิดอยู่แล้วในหน้าต่างอื่น` : `เปิดเซิร์ฟเวอร์ไม่ได้: ${err.message}`);
      process.exit(1);
    }
    console.log('ระบบสต็อกหนังสือพร้อมใช้งาน' + (REQUIRE_LOGIN ? '' : ' (โหมดไม่ต้องเข้าสู่ระบบ)'));
    console.log(`  เครื่องนี้:        http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces()))
      for (const n of list) if (n.family === 'IPv4' && !n.internal) console.log(`  เครื่องอื่นในวง LAN: http://${n.address}:${PORT}`);
  })).catch((e) => { console.error('เปิดฐานข้อมูลไม่ได้:', e.message); process.exit(1); });
}
