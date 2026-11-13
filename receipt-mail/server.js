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
  -- 1 แถว = ซอง/พัสดุ 1 ชิ้นที่ส่งให้ลูกค้า (ในซองมีใบเสร็จได้หลายใบ ดู parcel_receipts)
  CREATE TABLE IF NOT EXISTS parcels (
    id INTEGER PRIMARY KEY,
    customer TEXT NOT NULL,                -- ชื่อลูกค้า
    destination TEXT NOT NULL DEFAULT '',  -- ส่งไปที่ไหน (ผู้รับ/ที่อยู่)
    sent_date TEXT NOT NULL DEFAULT '',    -- วันที่ส่ง YYYY-MM-DD (ว่าง = ยังไม่ส่ง)
    carrier TEXT NOT NULL DEFAULT '',      -- ส่งทาง
    tracking_no TEXT NOT NULL DEFAULT '',  -- เลขพัสดุ
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','received','returned')),
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id), updated_at TEXT,
    deleted INTEGER NOT NULL DEFAULT 0, deleted_by INTEGER REFERENCES users(id), deleted_at TEXT, delete_reason TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_parcel_customer ON parcels(customer);
  CREATE INDEX IF NOT EXISTS idx_parcel_tracking ON parcels(tracking_no);
  CREATE INDEX IF NOT EXISTS idx_parcel_sent ON parcels(sent_date);
  -- ใบเสร็จในซอง
  CREATE TABLE IF NOT EXISTS parcel_receipts (
    id INTEGER PRIMARY KEY, parcel_id INTEGER NOT NULL REFERENCES parcels(id),
    receipt_no TEXT NOT NULL,              -- เลขที่ใบเสร็จ
    bill_date TEXT NOT NULL                -- วันที่ตัดบิล YYYY-MM-DD
  );
  CREATE INDEX IF NOT EXISTS idx_pr_parcel ON parcel_receipts(parcel_id);
  CREATE INDEX IF NOT EXISTS idx_pr_receipt ON parcel_receipts(receipt_no);
  CREATE INDEX IF NOT EXISTS idx_pr_bill ON parcel_receipts(bill_date);
  -- ประวัติการแก้ไข: before = ข้อมูลก่อนแก้ (JSON) ไว้ตรวจสอบย้อนหลัง
  CREATE TABLE IF NOT EXISTS parcel_edits (
    id INTEGER PRIMARY KEY, parcel_id INTEGER NOT NULL REFERENCES parcels(id),
    edited_by INTEGER NOT NULL REFERENCES users(id), edited_at TEXT NOT NULL, before TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_edits_parcel ON parcel_edits(parcel_id);
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
const PARCEL_FIELDS = ['customer', 'destination', 'sent_date', 'carrier', 'tracking_no', 'status', 'note'];

// ตรวจข้อมูลซอง + รายการใบเสร็จในซอง
function parcelInput(body) {
  const p = {
    customer: str(body.customer, 200),
    destination: str(body.destination, 500),
    sent_date: str(body.sent_date, 10),
    carrier: str(body.carrier, 60),
    tracking_no: normTracking(body.tracking_no),
    note: str(body.note, 500),
  };
  if (!p.customer) fail(400, 'กรอกชื่อลูกค้า');
  if (p.sent_date && !isDate(p.sent_date)) fail(400, 'วันที่ส่งไม่ถูกต้อง');
  const list = Array.isArray(body.receipts) ? body.receipts : [];
  if (list.length > 500) fail(400, 'ใบเสร็จในซองเดียวได้ไม่เกิน 500 ใบ');
  const seen = new Set();
  p.receipts = [];
  for (const r of list) {
    const receipt_no = str(r?.receipt_no, 60), bill_date = str(r?.bill_date, 10);
    if (!receipt_no && !bill_date) continue; // แถวว่างในฟอร์ม
    if (!receipt_no) fail(400, 'มีแถวที่ไม่ได้กรอกเลขที่ใบเสร็จ');
    if (!isDate(bill_date)) fail(400, `ใบเสร็จ ${receipt_no}: กรอกวันที่ตัดบิลให้ถูกต้อง`);
    if (seen.has(receipt_no)) fail(400, `ใบเสร็จ ${receipt_no} ซ้ำในซองนี้`);
    if (p.sent_date && p.sent_date < bill_date) fail(400, `ใบเสร็จ ${receipt_no} ตัดบิลหลังวันที่ส่ง`);
    seen.add(receipt_no);
    p.receipts.push({ receipt_no, bill_date });
  }
  if (!p.receipts.length) fail(400, 'ใส่ใบเสร็จในซองอย่างน้อย 1 ใบ');
  // สถานะ: ถ้าไม่ระบุ ให้คำนวณจากวันที่ส่ง; ถ้ามีวันที่ส่งแล้วจะเป็น "รอส่ง" ไม่ได้
  let status = STATUSES.includes(body.status) ? body.status : '';
  if (!status || (status === 'pending' && p.sent_date)) status = p.sent_date ? 'sent' : 'pending';
  if (status !== 'pending' && !p.sent_date) fail(400, `สถานะ "${STATUS_TH[status]}" ต้องกรอกวันที่ส่ง`);
  p.status = status;
  return p;
}
const receiptsText = (list) => list.map((r) => `${r.receipt_no} (${r.bill_date})`).join(', ');

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
// ค่าหน้าซอง: ขนาดซอง (นิ้ว, ด้านยาว x ด้านสั้น) และตำแหน่งชดเชยของเครื่องพิมพ์ (มม.)
const ENVELOPE = {
  env_sender_name: { def: '', max: 200 },
  env_sender_address: { def: '', max: 500 },
  env_w: { def: '12.5', num: [3, 20] },
  env_h: { def: '9', num: [3, 20] },
  env_dx: { def: '0', num: [-50, 50] },
  env_dy: { def: '0', num: [-50, 50] },
};
async function envelopeSettings() {
  const rows = await db.all(`SELECT key, value FROM settings WHERE key LIKE 'env_%'`);
  const got = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(Object.entries(ENVELOPE).map(([k, d]) => [k, d.num ? Number(got[k] ?? d.def) : got[k] ?? d.def]));
}

app.get('/api/state', async (req, res) => {
  const needSetup = (await db.get('SELECT COUNT(*) c FROM users')).c === 0;
  res.json({ needSetup, user: req.user || null, orgName: await setting('org_name'), carriers: CARRIERS, statuses: STATUS_TH,
    envelope: req.user ? await envelopeSettings() : null });
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

const UPSERT_SETTING = `INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
app.put('/api/settings', admin, async (req, res) => {
  const stmts = [];
  if (req.body.orgName !== undefined) {
    const orgName = str(req.body.orgName, 200);
    if (!orgName) fail(400, 'กรอกชื่อหน่วยงาน');
    stmts.push({ sql: UPSERT_SETTING, args: ['org_name', orgName] });
  }
  for (const [k, d] of Object.entries(ENVELOPE)) {
    if (req.body[k] === undefined) continue;
    let v = str(req.body[k], d.max || 20);
    if (d.num) {
      const n = Number(v);
      if (v === '' || !Number.isFinite(n) || n < d.num[0] || n > d.num[1]) fail(400, `ค่า ${k} ต้องอยู่ระหว่าง ${d.num[0]} ถึง ${d.num[1]}`);
      v = String(n);
    }
    stmts.push({ sql: UPSERT_SETTING, args: [k, v] });
  }
  if (stmts.length) await client.batch(stmts, 'write');
  res.json({ ok: true, envelope: await envelopeSettings() });
});

// ---------- parcels ----------
const PARCEL_COLS = `p.id, p.customer, p.destination, p.sent_date, p.carrier, p.tracking_no, p.status, p.note,
  p.created_at, p.updated_at, cu.name AS created_name, uu.name AS updated_name`;
const PARCEL_FROM = `FROM parcels p JOIN users cu ON cu.id = p.created_by LEFT JOIN users uu ON uu.id = p.updated_by`;

// ตัวกรอง: q = ค้นเลขใบเสร็จ/ลูกค้า/เลขพัสดุ/ที่อยู่, status, ช่วงวันที่ (by = bill: วันที่ตัดบิลของใบเสร็จในซอง | sent)
function listFilter(q) {
  const where = ['p.deleted = 0'], args = [];
  const text = str(q.q, 100);
  if (text) {
    const like = `%${text.replace(/[%_\\]/g, '\\$&')}%`;
    const cols = ['p.customer', 'p.tracking_no', 'p.destination', 'p.note'];
    where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')}
      OR EXISTS (SELECT 1 FROM parcel_receipts r WHERE r.parcel_id = p.id AND r.receipt_no LIKE ? ESCAPE '\\'))`);
    for (let i = 0; i <= cols.length; i++) args.push(like);
  }
  if (STATUSES.includes(q.status)) { where.push('p.status = ?'); args.push(q.status); }
  if (q.by === 'sent') {
    if (isDate(q.from)) { where.push('p.sent_date >= ?'); args.push(q.from); }
    if (isDate(q.to)) { where.push(`p.sent_date <= ? AND p.sent_date <> ''`); args.push(q.to); }
  } else if (isDate(q.from) || isDate(q.to)) {
    const c = ['r.parcel_id = p.id'];
    if (isDate(q.from)) { c.push('r.bill_date >= ?'); args.push(q.from); }
    if (isDate(q.to)) { c.push('r.bill_date <= ?'); args.push(q.to); }
    where.push(`EXISTS (SELECT 1 FROM parcel_receipts r WHERE ${c.join(' AND ')})`);
  }
  return { sql: where.join(' AND '), args };
}
const ORDER = `ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END, COALESCE(NULLIF(p.sent_date, ''), p.created_at) DESC, p.id DESC`;

async function withReceipts(parcels) {
  if (!parcels.length) return parcels;
  const rs = await db.all(`SELECT parcel_id, receipt_no, bill_date FROM parcel_receipts
    WHERE parcel_id IN (${parcels.map(() => '?').join(',')}) ORDER BY id`, ...parcels.map((p) => p.id));
  const by = new Map(parcels.map((p) => [p.id, (p.receipts = [])]));
  for (const r of rs) by.get(r.parcel_id).push({ receipt_no: r.receipt_no, bill_date: r.bill_date });
  return parcels;
}

app.get('/api/parcels', auth, async (req, res) => {
  const f = listFilter(req.query);
  const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 2000);
  const rows = await withReceipts(await db.all(`SELECT ${PARCEL_COLS} ${PARCEL_FROM} WHERE ${f.sql} ${ORDER} LIMIT ${limit}`, ...f.args));
  const totals = await db.all(`SELECT p.status, COUNT(*) c, SUM((SELECT COUNT(*) FROM parcel_receipts r WHERE r.parcel_id = p.id)) n
    FROM parcels p WHERE ${f.sql} GROUP BY p.status`, ...f.args);
  res.json({ rows, totals: Object.fromEntries(totals.map((t) => [t.status, { parcels: t.c, receipts: t.n }])) });
});

app.get('/api/parcels/:id', auth, async (req, res) => {
  const p = await db.get(`SELECT ${PARCEL_COLS} ${PARCEL_FROM} WHERE p.id = ? AND p.deleted = 0`, Number(req.params.id));
  if (!p) fail(404, 'ไม่พบรายการ');
  await withReceipts([p]);
  p.edits = await db.all(`SELECT e.edited_at, e.before, u.name FROM parcel_edits e JOIN users u ON u.id = e.edited_by
                          WHERE e.parcel_id = ? ORDER BY e.id DESC`, p.id);
  res.json(p);
});

// เช็กเลขใบเสร็จ/เลขพัสดุที่เคยบันทึกในซองอื่น (เตือนเท่านั้น เพราะอาจส่งซ้ำได้จริง)
app.post('/api/check', auth, async (req, res) => {
  const exclude = Number(req.body.exclude) || 0;
  const nos = [...new Set((Array.isArray(req.body.receipts) ? req.body.receipts : []).map((v) => str(v, 60)).filter(Boolean))].slice(0, 500);
  const tracking = normTracking(req.body.tracking_no);
  const receipts = nos.length ? await db.all(`SELECT r.receipt_no, p.id, p.customer, p.sent_date FROM parcel_receipts r JOIN parcels p ON p.id = r.parcel_id
    WHERE p.deleted = 0 AND p.id <> ? AND r.receipt_no IN (${nos.map(() => '?').join(',')}) ORDER BY p.id DESC`, exclude, ...nos) : [];
  const parcels = tracking ? await db.all(`SELECT id, customer, sent_date FROM parcels WHERE deleted = 0 AND id <> ? AND tracking_no = ? LIMIT 5`, exclude, tracking) : [];
  res.json({ receipts, tracking: parcels });
});

// รายชื่อลูกค้าพร้อมที่อยู่ล่าสุดที่เคยส่ง (ช่วยกรอกให้เร็วขึ้น)
app.get('/api/customers', auth, async (req, res) => {
  res.json(await db.all(`SELECT customer, destination, carrier FROM parcels
    WHERE id IN (SELECT MAX(id) FROM parcels WHERE deleted = 0 GROUP BY customer) ORDER BY customer`));
});

const insertReceipts = (id, list) => list.map((r) => ({ sql: 'INSERT INTO parcel_receipts (parcel_id, receipt_no, bill_date) VALUES (?, ?, ?)', args: [id, r.receipt_no, r.bill_date] }));
const INSERT_PARCEL = `INSERT INTO parcels (customer, destination, sent_date, carrier, tracking_no, status, note, created_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const parcelArgs = (p) => [p.customer, p.destination, p.sent_date, p.carrier, p.tracking_no, p.status, p.note];

async function createParcel(p, userId, t = now()) {
  const tx = await client.transaction('write');
  try {
    const id = Number((await tx.execute({ sql: INSERT_PARCEL, args: [...parcelArgs(p), userId, t] })).lastInsertRowid);
    for (const s of insertReceipts(id, p.receipts)) await tx.execute(s);
    await tx.commit();
    return id;
  } catch (e) { await tx.rollback().catch(() => {}); throw e; }
  finally { tx.close(); }
}

// คำสั่งแก้ไขซอง (พร้อมประวัติ); คืน [] ถ้าไม่มีอะไรเปลี่ยน
function updateStatements(old, p, userId, t, via) {
  const before = Object.fromEntries(PARCEL_FIELDS.filter((k) => old[k] !== p[k]).map((k) => [k, old[k]]));
  const changedReceipts = receiptsText(old.receipts) !== receiptsText(p.receipts);
  if (changedReceipts) before.receipts = receiptsText(old.receipts);
  if (!Object.keys(before).length) return [];
  if (via) before.via = via;
  return [
    { sql: 'INSERT INTO parcel_edits (parcel_id, edited_by, edited_at, before) VALUES (?, ?, ?, ?)', args: [old.id, userId, t, JSON.stringify(before)] },
    { sql: `UPDATE parcels SET customer = ?, destination = ?, sent_date = ?, carrier = ?, tracking_no = ?, status = ?, note = ?,
              updated_by = ?, updated_at = ? WHERE id = ?`, args: [...parcelArgs(p), userId, t, old.id] },
    ...(changedReceipts ? [{ sql: 'DELETE FROM parcel_receipts WHERE parcel_id = ?', args: [old.id] }, ...insertReceipts(old.id, p.receipts)] : []),
  ];
}

app.post('/api/parcels', auth, async (req, res) => {
  res.json({ ok: true, id: await createParcel(parcelInput(req.body), req.user.id) });
});

app.put('/api/parcels/:id', auth, async (req, res) => {
  const old = await db.get('SELECT * FROM parcels WHERE id = ? AND deleted = 0', Number(req.params.id));
  if (!old) fail(404, 'ไม่พบรายการ');
  await withReceipts([old]);
  const stmts = updateStatements(old, parcelInput({ ...old, ...req.body }), req.user.id, now());
  if (!stmts.length) return res.json({ ok: true, unchanged: true });
  await client.batch(stmts, 'write');
  res.json({ ok: true });
});

// ลบ = ซ่อนไว้ (ไม่ลบจริง) เฉพาะผู้ดูแล และต้องระบุเหตุผล
app.post('/api/parcels/:id/delete', admin, async (req, res) => {
  const reason = str(req.body.reason, 200);
  if (!reason) fail(400, 'ระบุเหตุผลที่ลบ');
  const r = await db.run('UPDATE parcels SET deleted = 1, deleted_by = ?, deleted_at = ?, delete_reason = ? WHERE id = ? AND deleted = 0',
    req.user.id, now(), reason, Number(req.params.id));
  if (!r.changes) fail(404, 'ไม่พบรายการ');
  res.json({ ok: true });
});

// ---------- import from Excel ----------
// 1 แถวในไฟล์ = ใบเสร็จ 1 ใบ; แถวที่เลขพัสดุเดียวกัน (หรือลูกค้า+วันที่ส่ง+ที่อยู่เดียวกัน ถ้าไม่มีเลขพัสดุ) รวมเป็นซองเดียว
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
const ALIASES = Object.entries(IMPORT_COLS).flatMap(([k, list]) => list.map((a) => [k, normHead(a)])).sort((a, b) => b[1].length - a[1].length);
function mapHeader(row) {
  const map = {};
  row.forEach((cell, i) => {
    const h = normHead(cell);
    if (!h) return;
    const hit = ALIASES.find(([k, a]) => !(k in map) && h === a) || ALIASES.find(([k, a]) => !(k in map) && h.includes(a));
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
  const addr = '99/1 ถ.สุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพฯ 10110';
  const ws = XLSX.utils.aoa_to_sheet([
    ['เลขที่ใบเสร็จ', 'วันที่ตัดบิล', 'ชื่อลูกค้า', 'วันที่ส่ง', 'ส่งไปที่', 'ส่งทาง', 'เลขพัสดุ', 'หมายเหตุ'],
    ['RC0001', '01/11/2569', 'บริษัท ตัวอย่าง จำกัด', '05/11/2569', addr, 'ไปรษณีย์ไทย (EMS)', 'EF123456789TH', 'ใบเสร็จที่เลขพัสดุเดียวกัน = ซองเดียวกัน'],
    ['RC0002', '01/11/2569', 'บริษัท ตัวอย่าง จำกัด', '05/11/2569', addr, 'ไปรษณีย์ไทย (EMS)', 'EF123456789TH', ''],
    ['RC0003', '03/11/2569', 'ร้านตัวอย่าง', '', '', '', '', 'ยังไม่ส่ง เว้นวันที่ส่งไว้'],
  ]);
  ws['!cols'] = [16, 14, 30, 14, 44, 20, 18, 36].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ใบเสร็จ');
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', 'attachment; filename="receipt-import-template.xlsx"');
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

// body: { file: base64, mode: 'skip' | 'update', commit: bool }
// commit = false → ตรวจอย่างเดียว (แสดงตัวอย่างก่อนยืนยัน), true → บันทึกจริง
// mode update: ใบเสร็จที่มีอยู่แล้ว → เติม/แก้ข้อมูลการส่งของซองที่ใบเสร็จนั้นอยู่
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

  // ใบเสร็จที่มีอยู่แล้ว → ซองที่ใบเสร็จนั้นอยู่ (ล่าสุด)
  const parcels = await withReceipts(await db.all('SELECT * FROM parcels WHERE deleted = 0 ORDER BY id'));
  const byReceipt = new Map();
  for (const p of parcels) for (const r of p.receipts) byReceipt.set(r.receipt_no, p);

  const seen = new Set(), errors = [], groups = new Map(), updates = new Map();
  let skipped = 0;
  for (let i = headIdx + 1; i < grid.length; i++) {
    const row = grid[i], line = i + 1;
    const get = (k) => (k in map ? row[map[k]] : '');
    const receipt_no = str(get('receipt_no'), 60);
    if (!receipt_no) { if (Object.values(map).some((c) => String(row[c] ?? '').trim())) errors.push({ line, msg: 'ไม่มีเลขที่ใบเสร็จ' }); continue; }
    if (seen.has(receipt_no)) { errors.push({ line, receipt_no, msg: 'เลขที่ใบเสร็จซ้ำกับแถวก่อนหน้าในไฟล์' }); continue; }
    seen.add(receipt_no);
    try {
      const v = {};
      for (const k of ['bill_date', 'sent_date']) {
        const dt = parseDate(get(k));
        if (dt === null) fail(400, `${k === 'bill_date' ? 'วันที่ตัดบิล' : 'วันที่ส่ง'} "${get(k)}" อ่านไม่ได้ (ใช้ วว/ดด/ปปปป)`);
        if (dt) v[k] = dt;
      }
      for (const k of ['customer', 'destination', 'carrier', 'note']) { const s = str(get(k), 500); if (s) v[k] = s; }
      const tn = normTracking(get('tracking_no')); if (tn) v.tracking_no = tn;
      const st = normHead(get('status'));
      if (st) { if (!STATUS_FROM_TH[st]) fail(400, `สถานะ "${get('status')}" ไม่รู้จัก`); v.status = STATUS_FROM_TH[st]; }
      const old = byReceipt.get(receipt_no);
      if (old && !update) { skipped++; continue; }
      if (old) {
        // เติมข้อมูลการส่งให้ซองเดิม (ข้อมูลระดับซอง ไม่แก้รายการใบเสร็จ ยกเว้นวันที่ตัดบิลของใบนี้)
        const u = updates.get(old.id) || { old, v: {}, lines: [], bills: {} };
        Object.assign(u.v, Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'bill_date')));
        if (v.bill_date) u.bills[receipt_no] = v.bill_date;
        u.lines.push(line);
        updates.set(old.id, u);
        continue;
      }
      if (update && (!v.bill_date || !v.customer)) fail(400, 'ไม่พบเลขที่ใบเสร็จนี้ในระบบ (และไม่มีวันที่ตัดบิล/ชื่อลูกค้าพอจะเพิ่มเป็นรายการใหม่)');
      if (!v.bill_date) fail(400, 'ไม่มีวันที่ตัดบิล');
      if (!v.customer) fail(400, 'ไม่มีชื่อลูกค้า');
      const key = v.tracking_no ? `T|${v.tracking_no}` : `C|${v.customer}|${v.sent_date || ''}|${v.destination || ''}|${v.carrier || ''}`;
      const g = groups.get(key) || { v: { ...v }, receipts: [], lines: [] };
      if (g.v.customer !== v.customer) fail(400, `เลขพัสดุ ${v.tracking_no} ถูกใช้กับลูกค้ามากกว่า 1 ราย ("${g.v.customer}" และ "${v.customer}")`);
      for (const k of ['destination', 'carrier', 'note', 'sent_date', 'status']) if (!g.v[k] && v[k]) g.v[k] = v[k];
      g.receipts.push({ receipt_no, bill_date: v.bill_date });
      g.lines.push(line);
      groups.set(key, g);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      errors.push({ line, receipt_no, msg: e.message });
    }
  }
  const creates = [], edits = [];
  for (const g of groups.values()) {
    try { creates.push({ p: parcelInput({ ...g.v, receipts: g.receipts }), lines: g.lines }); }
    catch (e) { if (!(e instanceof HttpError)) throw e; errors.push({ line: g.lines[0], receipt_no: g.receipts.map((r) => r.receipt_no).join(', '), msg: e.message }); }
  }
  for (const u of updates.values()) {
    try {
      const receipts = u.old.receipts.map((r) => ({ ...r, bill_date: u.bills[r.receipt_no] || r.bill_date }));
      const p = parcelInput({ ...u.old, ...u.v, status: u.v.status || u.old.status, receipts });
      if (updateStatements(u.old, p, 0, '').length) edits.push({ old: u.old, p, lines: u.lines }); else skipped += u.lines.length;
    } catch (e) { if (!(e instanceof HttpError)) throw e; errors.push({ line: u.lines[0], msg: `ซองของ ${u.old.customer}: ${e.message}` }); }
  }
  errors.sort((a, b) => a.line - b.line);
  const summary = {
    sheet: sheetName, createParcels: creates.length, createReceipts: creates.reduce((n, c) => n + c.p.receipts.length, 0),
    updateParcels: edits.length, skipped, errors: errors.slice(0, 200), errorCount: errors.length,
    preview: [...creates.map((c) => ({ action: 'create', ...c.p })), ...edits.map((e) => ({ action: 'update', ...e.p }))].slice(0, 50),
  };
  if (!req.body.commit) return res.json(summary);
  if (!creates.length && !edits.length) fail(400, 'ไม่มีรายการให้นำเข้า');
  // บันทึกทั้งไฟล์ใน transaction เดียว: สำเร็จทั้งหมด หรือไม่บันทึกเลย
  const t = now(), tx = await client.transaction('write');
  try {
    for (const { p } of creates) {
      const r = await tx.execute({ sql: INSERT_PARCEL, args: [...parcelArgs(p), req.user.id, t] });
      for (const s of insertReceipts(Number(r.lastInsertRowid), p.receipts)) await tx.execute(s);
    }
    for (const { old, p } of edits) for (const s of updateStatements(old, p, req.user.id, t, 'นำเข้า Excel')) await tx.execute(s);
    await tx.commit();
  } catch (e) { await tx.rollback().catch(() => {}); throw e; }
  finally { tx.close(); }
  res.json({ ...summary, committed: true });
});

// ---------- export ----------
const thDate = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${Number(d.slice(0, 4)) + 543}` : '');
// 1 แถว = ใบเสร็จ 1 ใบ พร้อมข้อมูลซองที่ใส่ไป
app.get('/api/export.xlsx', auth, async (req, res) => {
  const f = listFilter(req.query);
  const rows = await withReceipts(await db.all(`SELECT ${PARCEL_COLS} ${PARCEL_FROM} WHERE ${f.sql} ${ORDER}`, ...f.args));
  const aoa = [['ซองที่', 'เลขที่ใบเสร็จ', 'วันที่ตัดบิล', 'ชื่อลูกค้า', 'วันที่ส่ง', 'ส่งไปที่', 'ส่งทาง', 'เลขพัสดุ', 'สถานะ', 'หมายเหตุ', 'ผู้บันทึก']];
  for (const p of rows) for (const r of p.receipts)
    aoa.push([p.id, r.receipt_no, thDate(r.bill_date), p.customer, thDate(p.sent_date), p.destination, p.carrier, p.tracking_no, STATUS_TH[p.status], p.note, p.created_name]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [7, 16, 12, 32, 12, 50, 22, 18, 16, 30, 18].map((wch) => ({ wch }));
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
