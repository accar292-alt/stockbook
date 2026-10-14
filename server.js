// ระบบรับ-เบิกสต็อกหนังสือ : เซิร์ฟเวอร์ (Express + SQLite)
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'stock.db'));
db.exec(`
  PRAGMA foreign_keys = ON;
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
    unit TEXT NOT NULL DEFAULT 'เล่ม', min_qty INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
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
`);

// ฐานข้อมูลรุ่นแรกใช้ช่อง "หน่วยงาน" (dept) — ย้ายไปเป็นเลขที่ใบสั่งซื้อ (po_no) แล้วเพิ่มช่องชื่อหน่วยงาน (dept) กลับมาแยกต่างหาก
const docCols = db.prepare(`SELECT name FROM pragma_table_info('docs')`).all().map((c) => c.name);
if (!docCols.includes('po_no')) db.exec('ALTER TABLE docs RENAME COLUMN dept TO po_no');
if (!docCols.includes('po_no') || !docCols.includes('dept')) db.exec(`ALTER TABLE docs ADD COLUMN dept TEXT NOT NULL DEFAULT ''`);

// เพิ่มประเภทเอกสาร DMG (ตัดชำรุด/เสียหาย) และช่องสาเหตุ: SQLite แก้ CHECK ไม่ได้ จึงสร้างตาราง docs ใหม่แล้วย้ายข้อมูล
if (!db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'docs'`).get().sql.includes("'DMG'")) {
  db.exec(`PRAGMA foreign_keys = OFF; BEGIN;
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
const DOC_PREFIX = { IN: 'รับ', OUT: 'เบิก', DMG: 'ชำรุด' };
const DMG_REASONS = ['ชำรุด', 'เสียหาย', 'สูญหาย', 'พิมพ์ผิด', 'อื่น ๆ'];

// config.json: { "requireLogin": false } = ใช้งานได้เลยโดยไม่ต้องเข้าสู่ระบบ (ทุกคนมีสิทธิ์เต็ม)
const CONFIG_FILE = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify({ requireLogin: false }, null, 2));
const REQUIRE_LOGIN = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).requireLogin === true;
// ผู้ใช้กลางสำหรับโหมดไม่ต้องเข้าสู่ระบบ (active = 0 จึงใช้ล็อกอินไม่ได้)
db.exec(`INSERT OR IGNORE INTO users (username, name, pass_hash, salt, role, active) VALUES ('system', 'ไม่ระบุผู้ใช้', '', '', 'admin', 0)`);
const SYSTEM_USER = db.prepare(`SELECT id, username, name, role FROM users WHERE username = 'system'`).get();
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

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
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
const stockOf = (bookId) =>
  db.prepare(`SELECT ${STOCK_SQL} AS s FROM books b WHERE b.id = ?`).get(bookId)?.s ?? 0;
const setting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!REQUIRE_LOGIN) { req.user = SYSTEM_USER; return next(); }
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (m) {
    req.sid = sha(m[1]);
    req.user = db.prepare(`SELECT u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
                           WHERE s.token_hash = ? AND s.expires > ? AND u.active = 1`).get(req.sid, Date.now());
  }
  next();
});
const auth = (req, res, next) => (req.user ? next() : fail(401, 'กรุณาเข้าสู่ระบบ'));
const admin = (req, res, next) =>
  !req.user ? fail(401, 'กรุณาเข้าสู่ระบบ') : req.user.role === 'admin' ? next() : fail(403, 'เฉพาะผู้ดูแลระบบ');

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = 30 * 24 * 3600;
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(sha(token), userId, Date.now() + maxAge * 1000);
  res.set('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

// ---------- auth ----------
app.get('/api/state', (req, res) => {
  const needSetup = REQUIRE_LOGIN && db.prepare(REAL_USERS).get().c === 0;
  res.json({ needSetup, requireLogin: REQUIRE_LOGIN, user: req.user || null, orgName: setting('org_name') });
});

app.post('/api/setup', (req, res) => {
  const username = str(req.body.username, 40).toLowerCase(), name = str(req.body.name, 80);
  if (!username || !name) fail(400, 'กรอกชื่อผู้ใช้และชื่อ-สกุลให้ครบ');
  const { salt, hash } = hashPassword(checkPassword(req.body.password));
  const id = tx(() => {
    if (db.prepare(REAL_USERS).get().c > 0) fail(403, 'ตั้งค่าระบบไปแล้ว');
    return db.prepare(`INSERT INTO users (username, name, pass_hash, salt, role) VALUES (?, ?, ?, ?, 'admin')`)
      .run(username, name, hash, salt).lastInsertRowid;
  });
  startSession(res, id);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1')
    .get(str(req.body.username, 40).toLowerCase());
  const given = hashPassword(String(req.body.password ?? ''), u ? u.salt : 'x').hash;
  if (!u || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(u.pass_hash)))
    fail(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  startSession(res, u.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (req.sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sid);
  res.set('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.post('/api/password', auth, (req, res) => {
  if (!REQUIRE_LOGIN) fail(400, 'ระบบยังไม่เปิดใช้การเข้าสู่ระบบ');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (hashPassword(String(req.body.current ?? ''), u.salt).hash !== u.pass_hash) fail(400, 'รหัสผ่านเดิมไม่ถูกต้อง');
  const { salt, hash } = hashPassword(checkPassword(req.body.password));
  db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hash, salt, u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(u.id, req.sid);
  res.json({ ok: true });
});

// ---------- users (admin) ----------
app.get('/api/users', admin, (req, res) => {
  res.json(db.prepare(`SELECT id, username, name, role, active FROM users WHERE username <> 'system' ORDER BY id`).all());
});

app.post('/api/users', admin, (req, res) => {
  const username = str(req.body.username, 40).toLowerCase(), name = str(req.body.name, 80);
  const role = req.body.role === 'admin' ? 'admin' : 'staff';
  if (!username || !name) fail(400, 'กรอกชื่อผู้ใช้และชื่อ-สกุลให้ครบ');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(400, 'ชื่อผู้ใช้นี้มีอยู่แล้ว');
  const { salt, hash } = hashPassword(checkPassword(req.body.password));
  db.prepare('INSERT INTO users (username, name, pass_hash, salt, role) VALUES (?, ?, ?, ?, ?)')
    .run(username, name, hash, salt, role);
  res.json({ ok: true });
});

app.put('/api/users/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u || u.username === 'system') fail(404, 'ไม่พบผู้ใช้');
  const name = str(req.body.name ?? u.name, 80) || u.name;
  const role = req.body.role === undefined ? u.role : req.body.role === 'admin' ? 'admin' : 'staff';
  const active = req.body.active === undefined ? u.active : req.body.active ? 1 : 0;
  if (id === req.user.id && (role !== 'admin' || !active)) fail(400, 'ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตนเองได้');
  db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(name, role, active, id);
  if (req.body.password) {
    const { salt, hash } = hashPassword(checkPassword(req.body.password));
    db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hash, salt, id);
  }
  if (req.body.password || !active) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(id, req.sid);
  res.json({ ok: true });
});

app.put('/api/settings', admin, (req, res) => {
  const orgName = str(req.body.orgName, 200);
  if (!orgName) fail(400, 'กรอกชื่อหน่วยงาน');
  db.prepare(`INSERT INTO settings VALUES ('org_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(orgName);
  res.json({ ok: true });
});

// ---------- books ----------
const listBooks = () => db.prepare(`SELECT b.*, ${STOCK_SQL} AS stock FROM books b ORDER BY b.code`).all();
app.get('/api/books', auth, (req, res) => res.json(listBooks()));

function bookInput(body) {
  const b = { code: str(body.code, 40), name: str(body.name, 300), unit: str(body.unit, 20) || 'เล่ม',
              min_qty: Number(body.min_qty) || 0, active: body.active === false || body.active === 0 ? 0 : 1 };
  if (!b.code || !b.name) fail(400, 'กรอกรหัสและชื่อหนังสือให้ครบ');
  if (!Number.isInteger(b.min_qty) || b.min_qty < 0) fail(400, 'ยอดขั้นต่ำไม่ถูกต้อง');
  return b;
}
app.post('/api/books', admin, (req, res) => {
  const b = bookInput(req.body);
  if (db.prepare('SELECT 1 FROM books WHERE code = ?').get(b.code)) fail(400, 'รหัสหนังสือนี้มีอยู่แล้ว');
  db.prepare('INSERT INTO books (code, name, unit, min_qty, active) VALUES (?, ?, ?, ?, ?)')
    .run(b.code, b.name, b.unit, b.min_qty, b.active);
  res.json({ ok: true });
});
app.put('/api/books/:id', admin, (req, res) => {
  const id = Number(req.params.id), b = bookInput(req.body);
  if (db.prepare('SELECT 1 FROM books WHERE code = ? AND id <> ?').get(b.code, id)) fail(400, 'รหัสหนังสือนี้มีอยู่แล้ว');
  const r = db.prepare('UPDATE books SET code = ?, name = ?, unit = ?, min_qty = ?, active = ? WHERE id = ?')
    .run(b.code, b.name, b.unit, b.min_qty, b.active, id);
  if (!r.changes) fail(404, 'ไม่พบหนังสือ');
  res.json({ ok: true });
});

// บัตรสต็อก: ความเคลื่อนไหวของหนังสือ 1 เล่ม พร้อมยอดคงเหลือสะสม
app.get('/api/books/:id/card', auth, (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) fail(404, 'ไม่พบหนังสือ');
  let balance = 0;
  const rows = db.prepare(`SELECT d.id doc_id, d.doc_no, d.type, d.date, d.party, d.po_no, d.dept, d.reason, i.qty
                           FROM doc_items i JOIN docs d ON d.id = i.doc_id
                           WHERE i.book_id = ? AND d.cancelled = 0 ORDER BY d.date, d.id`).all(book.id)
    .map((r) => ({ ...r, balance: (balance += r.type === 'IN' ? r.qty : -r.qty) }));
  res.json({ book, rows });
});

// ---------- documents (ใบรับ / ใบเบิก) ----------
app.post('/api/docs', auth, (req, res) => {
  const type = DOC_PREFIX[req.body.type] ? req.body.type : fail(400, 'ประเภทเอกสารไม่ถูกต้อง');
  const date = isDate(req.body.date) ? req.body.date : fail(400, 'วันที่ไม่ถูกต้อง');
  const party = str(req.body.party, 120), po_no = str(req.body.po_no, 120), dept = str(req.body.dept, 120), note = str(req.body.note, 300);
  const reason = type === 'DMG' ? str(req.body.reason, 40) : '';
  if (type === 'OUT' && !party) fail(400, 'กรอกชื่อผู้เบิก');
  if (type === 'DMG' && !DMG_REASONS.includes(reason)) fail(400, 'เลือกสาเหตุ');
  if (type === 'DMG' && !party) fail(400, 'กรอกชื่อผู้รายงาน');
  if (!Array.isArray(req.body.items) || !req.body.items.length) fail(400, 'ยังไม่มีรายการหนังสือ');
  const items = new Map(); // รวมรายการซ้ำของหนังสือเล่มเดียวกัน
  for (const it of req.body.items) {
    if (!posInt(it.book_id) || !posInt(it.qty)) fail(400, 'จำนวนต้องเป็นจำนวนเต็มมากกว่า 0');
    items.set(it.book_id, (items.get(it.book_id) || 0) + it.qty);
  }
  const doc = tx(() => {
    for (const [bookId, qty] of items) {
      const b = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
      if (!b) fail(400, 'ไม่พบหนังสือในระบบ');
      const stock = stockOf(bookId);
      if (type !== 'IN' && qty > stock) fail(400, `"${b.name}" คงเหลือ ${stock} ${b.unit} ไม่พอ${type === 'DMG' ? 'ตัดชำรุด' : 'เบิก'} ${qty}`);
    }
    const year = Number(date.slice(0, 4)) + 543;
    const seq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 n FROM docs WHERE type = ? AND year = ?').get(type, year).n;
    const docNo = `${DOC_PREFIX[type]}-${year}-${String(seq).padStart(4, '0')}`;
    const id = db.prepare(`INSERT INTO docs (doc_no, type, year, seq, date, party, po_no, dept, reason, note, created_by, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(docNo, type, year, seq, date, party, po_no, dept, reason, note, req.user.id, now()).lastInsertRowid;
    const ins = db.prepare('INSERT INTO doc_items (doc_id, book_id, qty) VALUES (?, ?, ?)');
    for (const [bookId, qty] of items) ins.run(id, bookId, qty);
    return { id: Number(id), doc_no: docNo };
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

app.get('/api/docs', auth, (req, res) => {
  const f = docFilter(req.query);
  res.json(db.prepare(`SELECT d.id, d.doc_no, d.type, d.date, d.party, d.po_no, d.dept, d.reason, d.note, d.cancelled, u.name created_by,
                         (SELECT COUNT(*) FROM doc_items i WHERE i.doc_id = d.id) item_count,
                         (SELECT SUM(qty) FROM doc_items i WHERE i.doc_id = d.id) total_qty
                       FROM docs d JOIN users u ON u.id = d.created_by ${f.sql}
                       ORDER BY d.date DESC, d.id DESC LIMIT 1000`).all(...f.args));
});

app.get('/api/docs/:id', auth, (req, res) => {
  const doc = db.prepare(`SELECT d.*, u.name created_by_name, c.name cancelled_by_name FROM docs d
                          JOIN users u ON u.id = d.created_by LEFT JOIN users c ON c.id = d.cancelled_by
                          WHERE d.id = ?`).get(Number(req.params.id));
  if (!doc) fail(404, 'ไม่พบเอกสาร');
  doc.items = db.prepare(`SELECT b.code, b.name, b.unit, i.qty FROM doc_items i JOIN books b ON b.id = i.book_id
                          WHERE i.doc_id = ? ORDER BY i.id`).all(doc.id);
  res.json({ doc, orgName: setting('org_name') });
});

// ยกเลิกเอกสาร (ไม่ลบทิ้ง เพื่อให้ตรวจสอบย้อนหลังได้)
app.post('/api/docs/:id/cancel', admin, (req, res) => {
  tx(() => {
    const doc = db.prepare('SELECT * FROM docs WHERE id = ?').get(Number(req.params.id));
    if (!doc) fail(404, 'ไม่พบเอกสาร');
    if (doc.cancelled) fail(400, 'เอกสารนี้ถูกยกเลิกไปแล้ว');
    if (doc.type === 'IN') {
      const items = db.prepare(`SELECT i.book_id, i.qty, b.name FROM doc_items i JOIN books b ON b.id = i.book_id
                                WHERE i.doc_id = ?`).all(doc.id);
      for (const it of items)
        if (stockOf(it.book_id) - it.qty < 0) fail(400, `ยกเลิกไม่ได้: "${it.name}" ถูกเบิกออกไปแล้ว ยอดจะติดลบ`);
    }
    db.prepare('UPDATE docs SET cancelled = 1, cancelled_by = ?, cancelled_at = ? WHERE id = ?')
      .run(req.user.id, now(), doc.id);
  });
  res.json({ ok: true });
});

// ---------- reports ----------
function summary(from, to) {
  return db.prepare(`
    SELECT b.id, b.code, b.name, b.unit,
      COALESCE(SUM(CASE WHEN d.date < ? THEN ${SIGNED} END), 0) opening,
      COALESCE(SUM(CASE WHEN d.date BETWEEN ? AND ? AND d.type = 'IN' THEN i.qty END), 0) qty_in,
      COALESCE(SUM(CASE WHEN d.date BETWEEN ? AND ? AND d.type = 'OUT' THEN i.qty END), 0) qty_out,
      COALESCE(SUM(CASE WHEN d.date BETWEEN ? AND ? AND d.type = 'DMG' THEN i.qty END), 0) qty_dmg
    FROM books b
    LEFT JOIN doc_items i ON i.book_id = b.id
    LEFT JOIN docs d ON d.id = i.doc_id AND d.cancelled = 0
    GROUP BY b.id ORDER BY b.code`).all(from, from, to, from, to, from, to)
    .map((r) => ({ ...r, closing: r.opening + r.qty_in - r.qty_out - r.qty_dmg }));
}
function range(q) {
  if (!isDate(q.from) || !isDate(q.to) || q.from > q.to) fail(400, 'ช่วงวันที่ไม่ถูกต้อง');
  return [q.from, q.to];
}
app.get('/api/report/summary', auth, (req, res) => res.json(summary(...range(req.query))));

function sendXlsx(res, filename, sheetName, rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = widths.map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

app.get('/api/export/stock.xlsx', auth, (req, res) => {
  const rows = [[setting('org_name')], ['รายงานสต็อกคงเหลือ ณ วันที่ ' + now().slice(0, 10)], [],
    ['รหัส', 'ชื่อหนังสือ', 'หน่วย', 'คงเหลือ', 'ยอดขั้นต่ำ', 'สถานะ']];
  const onlyLow = req.query.low === '1';
  if (onlyLow) rows[1] = ['รายงานหนังสือที่ยอดคงเหลือต่ำกว่าขั้นต่ำ ณ วันที่ ' + now().slice(0, 10)];
  for (const b of listBooks()) {
    const low = b.min_qty > 0 && b.stock < b.min_qty;
    if (b.active && (low || !onlyLow)) rows.push([b.code, b.name, b.unit, b.stock, b.min_qty, low ? 'ต่ำกว่าขั้นต่ำ' : '']);
  }
  sendXlsx(res, onlyLow ? 'low-stock.xlsx' : 'stock.xlsx', 'คงเหลือ', rows, [12, 60, 8, 10, 12, 16]);
});

app.get('/api/export/summary.xlsx', auth, (req, res) => {
  const [from, to] = range(req.query);
  const rows = [[setting('org_name')], [`รายงานสรุปรับ-เบิก ตั้งแต่ ${from} ถึง ${to}`], [],
    ['รหัส', 'ชื่อหนังสือ', 'หน่วย', 'ยกมา', 'รับ', 'เบิก', 'ชำรุด/เสียหาย', 'คงเหลือ']];
  for (const r of summary(from, to)) rows.push([r.code, r.name, r.unit, r.opening, r.qty_in, r.qty_out, r.qty_dmg, r.closing]);
  sendXlsx(res, `summary_${from}_${to}.xlsx`, 'สรุปรับ-เบิก', rows, [12, 60, 8, 10, 10, 10, 14, 10]);
});

app.get('/api/export/movements.xlsx', auth, (req, res) => {
  const [from, to] = range(req.query);
  const rows = [[setting('org_name')], [`รายการรับ-เบิก ตั้งแต่ ${from} ถึง ${to}`], [],
    ['วันที่', 'เลขที่เอกสาร', 'ประเภท', 'รหัส', 'ชื่อหนังสือ', 'จำนวน', 'หน่วย', 'ผู้เบิก/ใบรับงาน/ผู้รายงาน', 'ใบสั่งซื้อเลขที่', 'หน่วยงาน', 'สาเหตุ', 'หมายเหตุ', 'ผู้บันทึก']];
  const data = db.prepare(`SELECT d.date, d.doc_no, d.type, b.code, b.name, i.qty, b.unit, d.party, d.po_no, d.dept, d.reason, d.note, u.name uname
                           FROM doc_items i JOIN docs d ON d.id = i.doc_id JOIN books b ON b.id = i.book_id
                           JOIN users u ON u.id = d.created_by
                           WHERE d.cancelled = 0 AND d.date BETWEEN ? AND ? ORDER BY d.date, d.id, i.id`).all(from, to);
  for (const r of data)
    rows.push([r.date, r.doc_no, DOC_PREFIX[r.type], r.code, r.name, r.qty, r.unit, r.party, r.po_no, r.dept, r.reason, r.note, r.uname]);
  sendXlsx(res, `movements_${from}_${to}.xlsx`, 'รายการ', rows, [12, 16, 8, 12, 60, 8, 8, 24, 20, 28, 12, 30, 20]);
});

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'ไม่พบรายการที่เรียก' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'เกิดข้อผิดพลาดในระบบ' : err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('ระบบสต็อกหนังสือพร้อมใช้งาน' + (REQUIRE_LOGIN ? '' : ' (โหมดไม่ต้องเข้าสู่ระบบ)'));
  console.log(`  เครื่องนี้:        http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list) if (n.family === 'IPv4' && !n.internal) console.log(`  เครื่องอื่นในวง LAN: http://${n.address}:${PORT}`);
});
