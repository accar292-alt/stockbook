// ระบบบันทึกการส่งใบเสร็จให้ลูกค้า : เซิร์ฟเวอร์ (Express + libSQL/SQLite)
// - รันในออฟฟิศ: node server.js  → ฐานข้อมูลไฟล์ data/receipts.db
// - รันบน Vercel: api/index.js ใช้ app นี้ → ฐานข้อมูล Turso (ตั้ง TURSO_DATABASE_URL / TURSO_AUTH_TOKEN)
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const PORT = Number(process.env.PORT) || 3001;
const ON_VERCEL = !!process.env.VERCEL;
const { createClient } = ON_VERCEL ? require('@libsql/client/web') : require('@libsql/client');

// ---------- database ----------
let dbUrl = (process.env.TURSO_DATABASE_URL || '').trim();
if (!dbUrl && !ON_VERCEL) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  dbUrl = 'file:' + path.join(dataDir, 'receipts.db');
}
let configError = !dbUrl ? 'ยังไม่ได้ตั้งค่า TURSO_DATABASE_URL ใน Vercel (Settings → Environment Variables) แล้ว Redeploy' : '';
let client;
try {
  client = createClient({ url: dbUrl || 'libsql://unset.invalid', authToken: (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined });
} catch (e) {
  configError ||= `ค่า TURSO_DATABASE_URL ไม่ถูกต้อง: ${e.message}`;
}

const exec = async (sql, args = []) => client.execute({ sql, args });
const db = {
  get: async (sql, ...args) => { const r = (await exec(sql, args)).rows[0]; return r ? { ...r } : undefined; },
  all: async (sql, ...args) => (await exec(sql, args)).rows.map((r) => ({ ...r })),
  run: async (sql, ...args) => { const r = await exec(sql, args); return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid) }; },
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff', active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
  );
  -- 1 แถว = ใบเสร็จ 1 ใบที่ต้องส่งให้ลูกค้า
  CREATE TABLE IF NOT EXISTS shipments (
    id INTEGER PRIMARY KEY,
    receipt_no TEXT NOT NULL,              -- เลขที่ใบเสร็จ
    bill_date TEXT NOT NULL,               -- วันที่ตัดบิล (YYYY-MM-DD)
    customer TEXT NOT NULL,                -- ชื่อลูกค้า
    sent_date TEXT NOT NULL DEFAULT '',    -- วันที่ส่ง (ว่าง = ยังไม่ส่ง)
    destination TEXT NOT NULL DEFAULT '',  -- ส่งไปที่ไหน (ที่อยู่/ผู้รับ)
    carrier TEXT NOT NULL DEFAULT '',      -- ส่งทาง
    tracking_no TEXT NOT NULL DEFAULT '',  -- เลขพัสดุ
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','received','returned')),
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id), updated_at TEXT,
    deleted INTEGER NOT NULL DEFAULT 0, deleted_by INTEGER REFERENCES users(id), deleted_at TEXT, delete_reason TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_ship_receipt ON shipments(receipt_no);
  CREATE INDEX IF NOT EXISTS idx_ship_customer ON shipments(customer);
  CREATE INDEX IF NOT EXISTS idx_ship_tracking ON shipments(tracking_no);
  CREATE INDEX IF NOT EXISTS idx_ship_bill ON shipments(bill_date);
  CREATE INDEX IF NOT EXISTS idx_ship_sent ON shipments(sent_date);
  -- ประวัติการแก้ไข: before = ข้อมูลก่อนแก้ (JSON) ไว้ตรวจสอบย้อนหลัง
  CREATE TABLE IF NOT EXISTS shipment_edits (
    id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL REFERENCES shipments(id),
    edited_by INTEGER NOT NULL REFERENCES users(id), edited_at TEXT NOT NULL, before TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_edits_ship ON shipment_edits(shipment_id);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT OR IGNORE INTO settings VALUES ('org_name', 'บริษัทของฉัน');
`;

let ready = null;
const ensureReady = () => (ready ??= (async () => {
  if (configError) throw new HttpError(500, configError);
  try { await client.executeMultiple(SCHEMA); }
  catch (e) { throw new HttpError(500, `เชื่อมต่อฐานข้อมูลไม่ได้: ${e.message}`); }
})().catch((e) => { ready = null; throw e; }));

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(Date.parse(v));
const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 6) fail(400, 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร');
  return password;
}
const setting = async (key) => (await db.get('SELECT value FROM settings WHERE key = ?', key))?.value ?? '';

const STATUSES = ['pending', 'sent', 'received', 'returned'];
const STATUS_TH = { pending: 'รอส่ง', sent: 'ส่งแล้ว', received: 'ลูกค้าได้รับแล้ว', returned: 'ตีกลับ' };
const CARRIERS = ['ไปรษณีย์ไทย (EMS)', 'ไปรษณีย์ไทย (ลงทะเบียน)', 'Kerry Express', 'Flash Express', 'J&T Express', 'ส่งเอง/แมสเซนเจอร์', 'อีเมล', 'อื่น ๆ'];

const normTracking = (v) => str(v, 60).toUpperCase().replace(/\s+/g, '');

function shipmentInput(body) {
  const s = {
    receipt_no: str(body.receipt_no, 60),
    bill_date: str(body.bill_date, 10),
    customer: str(body.customer, 200),
    sent_date: str(body.sent_date, 10),
    destination: str(body.destination, 500),
    carrier: str(body.carrier, 60),
    tracking_no: normTracking(body.tracking_no),
    note: str(body.note, 500),
  };
  if (!s.receipt_no) fail(400, 'กรอกเลขที่ใบเสร็จ');
  if (!isDate(s.bill_date)) fail(400, 'กรอกวันที่ตัดบิลให้ถูกต้อง');
  if (!s.customer) fail(400, 'กรอกชื่อลูกค้า');
  if (s.sent_date && !isDate(s.sent_date)) fail(400, 'วันที่ส่งไม่ถูกต้อง');
  if (s.sent_date && s.sent_date < s.bill_date) fail(400, 'วันที่ส่งต้องไม่ก่อนวันที่ตัดบิล');
  // สถานะ: ถ้าไม่ระบุ ให้คำนวณจากวันที่ส่ง; ถ้ามีวันที่ส่งแล้วจะเป็น "รอส่ง" ไม่ได้
  let status = STATUSES.includes(body.status) ? body.status : '';
  if (!status || (status === 'pending' && s.sent_date)) status = s.sent_date ? 'sent' : 'pending';
  if (status !== 'pending' && !s.sent_date) fail(400, `สถานะ "${STATUS_TH[status]}" ต้องกรอกวันที่ส่ง`);
  s.status = status;
  return s;
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '8mb' })); // ใหญ่พอสำหรับไฟล์ Excel ที่นำเข้า
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  await ensureReady();
  const m = /(?:^|;\s*)rsid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (m) {
    req.sid = sha(m[1]);
    req.user = await db.get(`SELECT u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
                             WHERE s.token_hash = ? AND s.expires > ? AND u.active = 1`, req.sid, Date.now());
  }
  next();
});
const auth = (req, res, next) => (req.user ? next() : fail(401, 'กรุณาเข้าสู่ระบบ'));
const admin = (req, res, next) =>
  !req.user ? fail(401, 'กรุณาเข้าสู่ระบบ') : req.user.role === 'admin' ? next() : fail(403, 'เฉพาะผู้ดูแลระบบ');
const parseRole = (r) => (r === 'admin' ? 'admin' : 'staff');

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = 30 * 24 * 3600;
  await db.run('DELETE FROM sessions WHERE expires < ?', Date.now());
  await db.run('INSERT INTO sessions VALUES (?, ?, ?)', sha(token), userId, Date.now() + maxAge * 1000);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.set('Set-Cookie', `rsid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

// ---------- auth ----------
app.get('/api/state', async (req, res) => {
  const needSetup = (await db.get('SELECT COUNT(*) c FROM users')).c === 0;
  res.json({ needSetup, user: req.user || null, orgName: await setting('org_name'), carriers: CARRIERS, statuses: STATUS_TH });
});

app.post('/api/setup', async (req, res) => {
  const username = str(req.body.username, 40).toLowerCase(), name = str(req.body.name, 80);
  if (!username || !name) fail(400, 'กรอกชื่อผู้ใช้และชื่อ-สกุลให้ครบ');
  const { salt, hash } = hashPassword(checkPassword(req.body.password));
  // INSERT แบบมีเงื่อนไข: กันสองเครื่องกดตั้งค่าพร้อมกัน
  const r = await db.run(`INSERT INTO users (username, name, pass_hash, salt, role)
                          SELECT ?, ?, ?, ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users)`, username, name, hash, salt);
  if (!r.changes) fail(403, 'ตั้งค่าระบบไปแล้ว');
  await startSession(req, res, r.lastInsertRowid);
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
  res.set('Set-Cookie', 'rsid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.post('/api/password', auth, async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (hashPassword(String(req.body.current ?? ''), u.salt).hash !== u.pass_hash) fail(400, 'รหัสผ่านเดิมไม่ถูกต้อง');
  const { salt, hash } = hashPassword(checkPassword(req.body.password));
  await db.run('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?', hash, salt, u.id);
  await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', u.id, req.sid);
  res.json({ ok: true });
});

// ---------- users & settings (admin) ----------
app.get('/api/users', admin, async (req, res) => {
  res.json(await db.all('SELECT id, username, name, role, active FROM users ORDER BY id'));
});

app.post('/api/users', admin, async (req, res) => {
  const username = str(req.body.username, 40).toLowerCase(), name = str(req.body.name, 80);
  if (!username || !name) fail(400, 'กรอกชื่อผู้ใช้และชื่อ-สกุลให้ครบ');
  if (await db.get('SELECT 1 FROM users WHERE username = ?', username)) fail(400, 'ชื่อผู้ใช้นี้มีอยู่แล้ว');
  const { salt, hash } = hashPassword(checkPassword(req.body.password));
  await db.run('INSERT INTO users (username, name, pass_hash, salt, role) VALUES (?, ?, ?, ?, ?)', username, name, hash, salt, parseRole(req.body.role));
  res.json({ ok: true });
});

app.put('/api/users/:id', admin, async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) fail(404, 'ไม่พบผู้ใช้');
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

// ---------- shipments ----------
const SHIP_COLS = `s.id, s.receipt_no, s.bill_date, s.customer, s.sent_date, s.destination, s.carrier, s.tracking_no,
  s.status, s.note, s.created_at, s.updated_at, cu.name AS created_name, uu.name AS updated_name`;
const SHIP_FROM = `FROM shipments s JOIN users cu ON cu.id = s.created_by LEFT JOIN users uu ON uu.id = s.updated_by`;

// ตัวกรองรายการ: q = ค้นเลขใบเสร็จ/ลูกค้า/เลขพัสดุ/ที่อยู่, status, ช่วงวันที่ (by = bill|sent)
function listFilter(q) {
  const where = ['s.deleted = 0'], args = [];
  const text = str(q.q, 100);
  if (text) {
    const cols = ['s.receipt_no', 's.customer', 's.tracking_no', 's.destination', 's.note'];
    where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    const like = `%${text.replace(/[%_\\]/g, '\\$&')}%`;
    for (const _ of cols) args.push(like);
  }
  if (STATUSES.includes(q.status)) { where.push('s.status = ?'); args.push(q.status); }
  const col = q.by === 'sent' ? 's.sent_date' : 's.bill_date';
  if (isDate(q.from)) { where.push(`${col} >= ?`); args.push(q.from); }
  if (isDate(q.to)) { where.push(`${col} <= ? AND ${col} <> ''`); args.push(q.to); }
  return { sql: where.join(' AND '), args };
}
const ORDER = `ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END, COALESCE(NULLIF(s.sent_date, ''), s.bill_date) DESC, s.id DESC`;

app.get('/api/shipments', auth, async (req, res) => {
  const f = listFilter(req.query);
  const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 2000);
  const rows = await db.all(`SELECT ${SHIP_COLS} ${SHIP_FROM} WHERE ${f.sql} ${ORDER} LIMIT ${limit}`, ...f.args);
  const totals = await db.all(`SELECT s.status, COUNT(*) c FROM shipments s WHERE ${f.sql} GROUP BY s.status`, ...f.args);
  res.json({ rows, totals: Object.fromEntries(totals.map((t) => [t.status, t.c])) });
});

app.get('/api/shipments/:id', auth, async (req, res) => {
  const s = await db.get(`SELECT ${SHIP_COLS}, s.deleted, s.delete_reason ${SHIP_FROM} WHERE s.id = ?`, Number(req.params.id));
  if (!s) fail(404, 'ไม่พบรายการ');
  s.edits = await db.all(`SELECT e.edited_at, e.before, u.name FROM shipment_edits e JOIN users u ON u.id = e.edited_by
                          WHERE e.shipment_id = ? ORDER BY e.id DESC`, s.id);
  res.json(s);
});

// เช็กเลขใบเสร็จ/เลขพัสดุซ้ำ (เตือนเท่านั้น ไม่บังคับ เพราะอาจส่งซ้ำได้จริง)
app.get('/api/check', auth, async (req, res) => {
  const exclude = Number(req.query.exclude) || 0;
  const field = req.query.field === 'tracking_no' ? 'tracking_no' : 'receipt_no';
  const value = str(req.query.value, 60);
  if (!value) return res.json([]);
  res.json(await db.all(`SELECT id, receipt_no, customer, bill_date, sent_date, tracking_no FROM shipments
                         WHERE deleted = 0 AND ${field} = ? AND id <> ? ORDER BY id DESC LIMIT 5`, value, exclude));
});

// รายชื่อลูกค้าพร้อมที่อยู่ล่าสุดที่เคยส่ง (ช่วยกรอกให้เร็วขึ้น)
app.get('/api/customers', auth, async (req, res) => {
  res.json(await db.all(`SELECT customer, destination, carrier FROM shipments
    WHERE id IN (SELECT MAX(id) FROM shipments WHERE deleted = 0 GROUP BY customer) ORDER BY customer`));
});

app.post('/api/shipments', auth, async (req, res) => {
  const s = shipmentInput(req.body);
  const r = await db.run(`INSERT INTO shipments (receipt_no, bill_date, customer, sent_date, destination, carrier, tracking_no, status, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.receipt_no, s.bill_date, s.customer, s.sent_date, s.destination, s.carrier, s.tracking_no, s.status, s.note, req.user.id, now());
  res.json({ ok: true, id: r.lastInsertRowid });
});

const EDIT_FIELDS = ['receipt_no', 'bill_date', 'customer', 'sent_date', 'destination', 'carrier', 'tracking_no', 'status', 'note'];

app.put('/api/shipments/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  const old = await db.get('SELECT * FROM shipments WHERE id = ? AND deleted = 0', id);
  if (!old) fail(404, 'ไม่พบรายการ');
  const s = shipmentInput({ ...old, ...req.body });
  const before = Object.fromEntries(EDIT_FIELDS.filter((k) => old[k] !== s[k]).map((k) => [k, old[k]]));
  if (!Object.keys(before).length) return res.json({ ok: true, unchanged: true });
  const t = now();
  await client.batch([
    { sql: 'INSERT INTO shipment_edits (shipment_id, edited_by, edited_at, before) VALUES (?, ?, ?, ?)', args: [id, req.user.id, t, JSON.stringify(before)] },
    { sql: `UPDATE shipments SET receipt_no = ?, bill_date = ?, customer = ?, sent_date = ?, destination = ?, carrier = ?,
              tracking_no = ?, status = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      args: [s.receipt_no, s.bill_date, s.customer, s.sent_date, s.destination, s.carrier, s.tracking_no, s.status, s.note, req.user.id, t, id] },
  ], 'write');
  res.json({ ok: true });
});

// บันทึก "ส่งแล้ว" ทีละหลายรายการ (ใส่ซองเดียวกัน / ส่งวันเดียวกัน)
app.post('/api/shipments/mark-sent', auth, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500) : [];
  if (!ids.length) fail(400, 'เลือกรายการที่จะบันทึก');
  const sent_date = str(req.body.sent_date, 10);
  if (!isDate(sent_date)) fail(400, 'กรอกวันที่ส่ง');
  const fields = { sent_date, status: 'sent' };
  // ช่องที่เว้นว่าง = คงค่าเดิมของแต่ละรายการไว้
  if (str(req.body.carrier)) fields.carrier = str(req.body.carrier, 60);
  if (str(req.body.tracking_no)) fields.tracking_no = normTracking(req.body.tracking_no);
  if (str(req.body.destination)) fields.destination = str(req.body.destination, 500);
  const rows = await db.all(`SELECT * FROM shipments WHERE deleted = 0 AND id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const late = rows.find((r) => r.bill_date > sent_date);
  if (late) fail(400, `ใบเสร็จ ${late.receipt_no} ตัดบิลหลังวันที่ส่ง`);
  const t = now(), stmts = [];
  for (const r of rows) {
    const before = Object.fromEntries(Object.keys(fields).filter((k) => r[k] !== fields[k]).map((k) => [k, r[k]]));
    if (!Object.keys(before).length) continue;
    stmts.push({ sql: 'INSERT INTO shipment_edits (shipment_id, edited_by, edited_at, before) VALUES (?, ?, ?, ?)', args: [r.id, req.user.id, t, JSON.stringify(before)] });
    const keys = Object.keys(fields);
    stmts.push({ sql: `UPDATE shipments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`,
      args: [...keys.map((k) => fields[k]), req.user.id, t, r.id] });
  }
  if (stmts.length) await client.batch(stmts, 'write');
  res.json({ ok: true, count: stmts.length / 2 });
});

// ลบ = ซ่อนไว้ (ไม่ลบจริง) เฉพาะผู้ดูแล และต้องระบุเหตุผล
app.post('/api/shipments/:id/delete', admin, async (req, res) => {
  const reason = str(req.body.reason, 200);
  if (!reason) fail(400, 'ระบุเหตุผลที่ลบ');
  const r = await db.run('UPDATE shipments SET deleted = 1, deleted_by = ?, deleted_at = ?, delete_reason = ? WHERE id = ? AND deleted = 0',
    req.user.id, now(), reason, Number(req.params.id));
  if (!r.changes) fail(404, 'ไม่พบรายการ');
  res.json({ ok: true });
});

// ---------- import from Excel ----------
// หัวคอลัมน์ที่รู้จัก (เทียบแบบตัดช่องว่าง/ตัวพิมพ์เล็ก) — ชื่อยาวก่อน เพื่อให้ "วันที่ตัดบิล" ไม่ไปจับ "วันที่"
const IMPORT_COLS = {
  receipt_no: ['เลขที่ใบเสร็จ', 'เลขที่ใบเสร็จรับเงิน', 'เลขใบเสร็จ', 'ใบเสร็จเลขที่', 'ใบเสร็จ', 'receiptno', 'receipt'],
  bill_date: ['วันที่ตัดบิล', 'วันตัดบิล', 'ตัดบิล', 'วันที่บิล', 'วันที่ใบเสร็จ', 'billdate'],
  customer: ['ชื่อลูกค้า', 'ลูกค้า', 'ชื่อบริษัท', 'customer'],
  sent_date: ['วันที่ส่ง', 'วันส่ง', 'วันที่จัดส่ง', 'sentdate'],
  destination: ['ส่งไปที่', 'ที่อยู่จัดส่ง', 'ที่อยู่', 'ผู้รับ', 'สถานที่ส่ง', 'address'],
  carrier: ['ส่งทาง', 'ช่องทางส่ง', 'บริษัทขนส่ง', 'ขนส่ง', 'carrier'],
  tracking_no: ['เลขพัสดุ', 'เลขที่พัสดุ', 'เลขแทรค', 'เลขติดตาม', 'trackingno', 'tracking'],
  status: ['สถานะ', 'status'],
  note: ['หมายเหตุ', 'note', 'remark'],
};
const normHead = (s) => String(s ?? '').toLowerCase().replace(/[\s._\-/()*:]/g, '');
function mapHeader(row) {
  const map = {};
  const aliases = Object.entries(IMPORT_COLS).flatMap(([k, list]) => list.map((a) => [k, normHead(a)])).sort((a, b) => b[1].length - a[1].length);
  row.forEach((cell, i) => {
    const h = normHead(cell);
    if (!h) return;
    const hit = aliases.find(([k, a]) => !(k in map) && h === a) || aliases.find(([k, a]) => !(k in map) && h.includes(a));
    if (hit) map[hit[0]] = i;
  });
  return map;
}
// วันที่จาก Excel: เลขวันที่ของ Excel, dd/mm/yyyy (พ.ศ. หรือ ค.ศ., ปี 2 หลักถือเป็น พ.ศ.), yyyy-mm-dd
function parseDate(v) {
  if (v === '' || v == null) return '';
  let y, m, d;
  if (typeof v === 'number') {
    const p = XLSX.SSF.parse_date_code(v);
    if (!p) return null;
    ({ y, m, d } = p);
  } else {
    const s = String(v).trim();
    let r;
    if ((r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) [, y, m, d] = r.map(Number);
    else if ((r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) { [, d, m, y] = r.map(Number); if (y < 100) y += 2500; }
    else return null;
  }
  if (y > 2400) y -= 543;
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(iso + 'T00:00:00Z');
  return !isNaN(t) && t.getUTCDate() === d && y >= 2000 && y <= 2100 ? iso : null;
}
const STATUS_FROM_TH = Object.fromEntries(Object.entries(STATUS_TH).flatMap(([k, t]) => [[normHead(t), k], [k, k]]));
STATUS_FROM_TH[normHead('ได้รับแล้ว')] = 'received';

app.get('/api/import-template.xlsx', auth, (req, res) => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['เลขที่ใบเสร็จ', 'วันที่ตัดบิล', 'ชื่อลูกค้า', 'วันที่ส่ง', 'ส่งไปที่', 'ส่งทาง', 'เลขพัสดุ', 'หมายเหตุ'],
    ['RC0001', '01/11/2569', 'บริษัท ตัวอย่าง จำกัด', '05/11/2569', '99/1 ถ.สุขุมวิท กรุงเทพฯ 10110', 'ไปรษณีย์ไทย (EMS)', 'EF123456789TH', ''],
    ['RC0002', '01/11/2569', 'ร้านตัวอย่าง', '', '', '', '', 'ยังไม่ส่ง เว้นวันที่ส่งไว้'],
  ]);
  ws['!cols'] = [16, 14, 30, 14, 40, 20, 18, 26].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ใบเสร็จ');
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', 'attachment; filename="receipt-import-template.xlsx"');
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

// body: { file: base64, mode: 'skip' | 'update', commit: bool }
// commit = false → ตรวจอย่างเดียว (แสดงตัวอย่างก่อนยืนยัน), true → บันทึกจริง
app.post('/api/import', auth, async (req, res) => {
  let wb;
  try { wb = XLSX.read(Buffer.from(String(req.body.file || ''), 'base64'), { type: 'buffer' }); }
  catch { fail(400, 'อ่านไฟล์ไม่ได้ — ต้องเป็นไฟล์ Excel (.xlsx / .xls) หรือ .csv'); }
  const update = req.body.mode === 'update';
  // หาแผ่นงานและแถวหัวคอลัมน์ (ใน 15 แถวแรก) ที่ตรงกับชื่อคอลัมน์มากที่สุด — ข้ามแถวชื่อรายงานด้านบน
  let best = null;
  for (const name of wb.SheetNames) {
    const g = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
    g.slice(0, 15).forEach((row, i) => {
      const m = mapHeader(row), score = Object.keys(m).length;
      if ('receipt_no' in m && (!best || score > best.score)) best = { name, grid: g, headIdx: i, score };
    });
  }
  if (!best) fail(400, 'ไม่พบหัวคอลัมน์ "เลขที่ใบเสร็จ" ในไฟล์ (ดูตัวอย่างจากไฟล์แม่แบบ)');
  const { name: sheetName, grid, headIdx } = best;
  const map = mapHeader(grid[headIdx]);
  const missing = ['bill_date', 'customer'].filter((k) => !(k in map));
  if (missing.length && !update) fail(400, `ไม่พบคอลัมน์ ${missing.map((k) => `"${IMPORT_COLS[k][0]}"`).join(', ')} (ถ้าต้องการเติมข้อมูลให้รายการเดิม เลือก "อัปเดตรายการเดิม")`);

  const existing = new Map((await db.all('SELECT * FROM shipments WHERE deleted = 0 ORDER BY id')).map((r) => [r.receipt_no, r]));
  const seen = new Set(), items = [], errors = [];
  let skipped = 0;
  for (let i = headIdx + 1; i < grid.length; i++) {
    const row = grid[i], line = i + 1;
    const get = (k) => (k in map ? row[map[k]] : '');
    const receipt_no = str(get('receipt_no'), 60);
    if (!receipt_no) { if (Object.values(map).some((c) => String(row[c] ?? '').trim())) errors.push({ line, msg: 'ไม่มีเลขที่ใบเสร็จ' }); continue; }
    if (seen.has(receipt_no)) { errors.push({ line, receipt_no, msg: 'เลขที่ใบเสร็จซ้ำกับแถวก่อนหน้าในไฟล์' }); continue; }
    seen.add(receipt_no);
    const v = { receipt_no };
    try {
      for (const k of ['bill_date', 'sent_date']) {
        const dt = parseDate(get(k));
        if (dt === null) fail(400, `${k === 'bill_date' ? 'วันที่ตัดบิล' : 'วันที่ส่ง'} "${get(k)}" อ่านไม่ได้ (ใช้ วว/ดด/ปปปป)`);
        if (dt) v[k] = dt;
      }
      for (const k of ['customer', 'destination', 'carrier', 'tracking_no', 'note']) { const s = str(get(k), 500); if (s) v[k] = s; }
      const st = normHead(get('status'));
      if (st) { if (!STATUS_FROM_TH[st]) fail(400, `สถานะ "${get('status')}" ไม่รู้จัก`); v.status = STATUS_FROM_TH[st]; }
      const old = existing.get(receipt_no);
      if (old && !update) { skipped++; continue; }
      if (old) {
        const s = shipmentInput({ ...old, ...v, status: v.status || old.status });
        const before = Object.fromEntries(EDIT_FIELDS.filter((k) => old[k] !== s[k]).map((k) => [k, old[k]]));
        if (!Object.keys(before).length) { skipped++; continue; }
        items.push({ action: 'update', id: old.id, s, before, line });
      } else {
        if (update && (!v.bill_date || !v.customer)) fail(400, 'ไม่พบเลขที่ใบเสร็จนี้ในระบบ (และไม่มีวันที่ตัดบิล/ชื่อลูกค้าพอจะเพิ่มเป็นรายการใหม่)');
        items.push({ action: 'create', s: shipmentInput(v), line });
      }
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      errors.push({ line, receipt_no, msg: e.message });
    }
  }
  const summary = {
    sheet: sheetName, create: items.filter((x) => x.action === 'create').length, update: items.filter((x) => x.action === 'update').length,
    skipped, errors: errors.slice(0, 200), errorCount: errors.length,
    preview: items.slice(0, 50).map(({ action, s, line }) => ({ action, line, ...s })),
  };
  if (!req.body.commit) return res.json(summary);
  if (!items.length) fail(400, 'ไม่มีรายการให้นำเข้า');
  const t = now(), stmts = [];
  for (const { action, id, s, before } of items) {
    if (action === 'create') stmts.push({ sql: `INSERT INTO shipments (receipt_no, bill_date, customer, sent_date, destination, carrier, tracking_no, status, note, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: [s.receipt_no, s.bill_date, s.customer, s.sent_date, s.destination, s.carrier, s.tracking_no, s.status, s.note, req.user.id, t] });
    else stmts.push(
      { sql: 'INSERT INTO shipment_edits (shipment_id, edited_by, edited_at, before) VALUES (?, ?, ?, ?)', args: [id, req.user.id, t, JSON.stringify({ ...before, via: 'นำเข้า Excel' })] },
      { sql: `UPDATE shipments SET receipt_no = ?, bill_date = ?, customer = ?, sent_date = ?, destination = ?, carrier = ?,
                tracking_no = ?, status = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
        args: [s.receipt_no, s.bill_date, s.customer, s.sent_date, s.destination, s.carrier, s.tracking_no, s.status, s.note, req.user.id, t, id] });
  }
  await client.batch(stmts, 'write'); // ทั้งไฟล์สำเร็จหรือไม่บันทึกเลย
  res.json({ ...summary, committed: true });
});

// ---------- export ----------
const thDate = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${Number(d.slice(0, 4)) + 543}` : '');
app.get('/api/export.xlsx', auth, async (req, res) => {
  const f = listFilter(req.query);
  const rows = await db.all(`SELECT ${SHIP_COLS} ${SHIP_FROM} WHERE ${f.sql} ${ORDER}`, ...f.args);
  const aoa = [['เลขที่ใบเสร็จ', 'วันที่ตัดบิล', 'ชื่อลูกค้า', 'วันที่ส่ง', 'ส่งไปที่', 'ส่งทาง', 'เลขพัสดุ', 'สถานะ', 'หมายเหตุ', 'ผู้บันทึก']];
  for (const r of rows) aoa.push([r.receipt_no, thDate(r.bill_date), r.customer, thDate(r.sent_date), r.destination, r.carrier,
    r.tracking_no, STATUS_TH[r.status], r.note, r.created_name]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [16, 12, 32, 12, 50, 22, 18, 16, 30, 18].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'การส่งใบเสร็จ');
  const name = `receipt-mail_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'ไม่พบรายการที่เรียก' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err instanceof HttpError ? err.message : 'เกิดข้อผิดพลาดในระบบ' });
});

module.exports = app;

if (require.main === module) {
  ensureReady().then(() => app.listen(PORT, '0.0.0.0', (err) => {
    if (err) {
      console.error(err.code === 'EADDRINUSE' ? `พอร์ต ${PORT} ถูกใช้อยู่ — โปรแกรมอาจเปิดอยู่แล้วในหน้าต่างอื่น` : `เปิดเซิร์ฟเวอร์ไม่ได้: ${err.message}`);
      process.exit(1);
    }
    console.log('ระบบบันทึกการส่งใบเสร็จพร้อมใช้งาน');
    console.log(`  เครื่องนี้:        http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces()))
      for (const n of list) if (n.family === 'IPv4' && !n.internal) console.log(`  เครื่องอื่นในวง LAN: http://${n.address}:${PORT}`);
  })).catch((e) => { console.error('เปิดฐานข้อมูลไม่ได้:', e.message); process.exit(1); });
}
