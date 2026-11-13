// ระบบบันทึกการส่งใบเสร็จ : หน้าเว็บ
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const thDate = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${Number(d.slice(0, 4)) + 543}` : '');
const thTime = (iso) => (iso ? new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '');

// เงิน: แสดง 1,234.50 / รวมยอด (null = ไม่ได้ระบุ)
const money = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numOrNull = (v) => { const t = String(v ?? '').replace(/[,\s฿]/g, ''); return t === '' || !Number.isFinite(+t) ? null : +t; };
function sumAmount(list) {
  const xs = list.map((r) => numOrNull(r.amount)).filter((n) => n != null);
  return xs.length ? Math.round(xs.reduce((a, b) => a + Math.round(b * 100), 0)) / 100 : null;
}
// จำนวนเงินเป็นตัวหนังสือ เช่น 1,021.50 → หนึ่งพันยี่สิบเอ็ดบาทห้าสิบสตางค์
function bahtText(n) {
  const d = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'], u = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
  const read = (t, higher = false) => {
    if (t.length > 6) return read(t.slice(0, -6)) + 'ล้าน' + read(t.slice(-6), true);
    let out = '';
    for (let i = 0; i < t.length; i++) {
      const k = +t[i], pos = t.length - i - 1;
      if (!k) continue;
      if (pos === 0 && k === 1 && (higher || +t.slice(0, -1) > 0)) out += 'เอ็ด';
      else if (pos === 1 && k === 2) out += 'ยี่';
      else if (!(pos === 1 && k === 1)) out += d[k];
      out += u[pos];
    }
    return out;
  };
  const [b, st] = Math.abs(n).toFixed(2).split('.');
  const bi = b.replace(/^0+/, '');
  return (bi ? read(bi) + 'บาท' : '') + (+st ? read(String(+st)) + 'สตางค์' : bi ? 'ถ้วน' : 'ศูนย์บาทถ้วน');
}

let S = { user: null, orgName: '', carriers: [], statuses: {} };
const isAdmin = () => S.user?.role === 'admin';

async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.user) { S.user = null; boot(); }
  if (!res.ok) throw new Error(data.error || `เกิดข้อผิดพลาด (${res.status})`);
  return data;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), bad ? 5000 : 2500);
}

// ส่งฟอร์ม: แสดงข้อผิดพลาดใน .err และกันกดซ้ำ
function onSubmit(form, fn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form), err = $('.err', form);
    if (btn) btn.disabled = true;
    if (err) err.textContent = '';
    try { await fn(Object.fromEntries(new FormData(form))); }
    catch (ex) { if (err) err.textContent = ex.message; else toast(ex.message, true); }
    finally { if (btn) btn.disabled = false; }
  });
}

function dialog(html, wide = false) {
  const d = $('#dlg');
  d.className = wide ? 'wide' : '';
  d.innerHTML = html;
  $$('[data-close]', d).forEach((b) => (b.onclick = () => d.close()));
  d.showModal();
  return d;
}

// ลิงก์ตรวจสถานะพัสดุ: ไปรษณีย์ไทยเปิดเว็บติดตามได้ตรง ๆ, เจ้าอื่นคัดลอกเลขไปค้นเอง
function trackHtml(r) {
  if (!r.tracking_no) return '<span class="mute">-</span>';
  const thaiPost = r.carrier.startsWith('ไปรษณีย์ไทย') || /^[A-Z]{2}\d{9}TH$/.test(r.tracking_no);
  const no = esc(r.tracking_no);
  return thaiPost
    ? `<a href="https://track.thailandpost.co.th/?trackNumber=${encodeURIComponent(r.tracking_no)}" target="_blank" rel="noopener" title="ตรวจสถานะที่ไปรษณีย์ไทย">${no} ↗</a>`
    : `${no} <button class="btn ghost sm noprint" data-copy="${no}" title="คัดลอกเลขพัสดุ">คัดลอก</button>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  e.stopPropagation();
  navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('คัดลอกเลขพัสดุแล้ว'), () => toast('คัดลอกไม่ได้', true));
});
const tag = (status) => `<span class="tag ${status}">${esc(S.statuses[status])}</span>`;

// ---------- boot / login ----------
async function boot() {
  let st;
  try { st = await api('/api/state'); }
  catch (e) { $('#main').innerHTML = `<div class="card login"><h2>เปิดระบบไม่ได้</h2><p class="err">${esc(e.message)}</p></div>`; return; }
  Object.assign(S, st);
  document.title = `บันทึกการส่งใบเสร็จ – ${S.orgName}`;
  $('#top').hidden = !S.user;
  if (st.needSetup) return setupPage();
  if (!S.user) return loginPage();
  $('#whoName').textContent = `${S.user.name}${isAdmin() ? ' (ผู้ดูแล)' : ''}`;
  renderNav();
  go(location.hash.slice(1) || 'list');
}

function setupPage() {
  $('#main').innerHTML = `<div class="card login"><h2>ตั้งค่าครั้งแรก</h2>
    <p class="mute">สร้างบัญชีผู้ดูแลระบบ (เพิ่มผู้ใช้อื่นได้ภายหลัง)</p>
    <form><label>ชื่อ-สกุล<input name="name" required></label>
      <label>ชื่อผู้ใช้ (ใช้เข้าสู่ระบบ)<input name="username" required autocomplete="username"></label>
      <label>รหัสผ่าน (อย่างน้อย 6 ตัว)<input name="password" type="password" required minlength="6" autocomplete="new-password"></label>
      <div class="err"></div><button class="btn" type="submit">เริ่มใช้งาน</button></form></div>`;
  onSubmit($('#main form'), async (v) => { await api('/api/setup', { body: v }); boot(); });
}

function loginPage() {
  $('#main').innerHTML = `<div class="card login"><h2>✉️ บันทึกการส่งใบเสร็จ</h2><p class="mute">${esc(S.orgName)}</p>
    <form><label>ชื่อผู้ใช้<input name="username" required autofocus autocomplete="username"></label>
      <label>รหัสผ่าน<input name="password" type="password" required autocomplete="current-password"></label>
      <div class="err"></div><button class="btn" type="submit">เข้าสู่ระบบ</button></form></div>`;
  onSubmit($('#main form'), async (v) => { await api('/api/login', { body: v }); boot(); });
}

$('#btnLogout').onclick = async () => { await api('/api/logout', { body: {} }).catch(() => {}); S.user = null; location.hash = ''; boot(); };
$('#btnPassword').onclick = () => {
  const d = dialog(`<h3>เปลี่ยนรหัสผ่าน</h3><form>
    <label>รหัสผ่านเดิม<input name="current" type="password" required autocomplete="current-password"></label>
    <label>รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)<input name="password" type="password" required minlength="6" autocomplete="new-password"></label>
    <div class="err"></div><div class="actions"><button type="button" class="btn ghost" data-close>ยกเลิก</button><button class="btn" type="submit">บันทึก</button></div></form>`);
  onSubmit($('form', d), async (v) => { await api('/api/password', { body: v }); d.close(); toast('เปลี่ยนรหัสผ่านแล้ว'); });
};

// ---------- nav ----------
const PAGES = { list: 'รายการซองที่ส่ง', new: '+ บันทึกซองใหม่', admin: 'ผู้ใช้และตั้งค่า' };
function renderNav() {
  $('#nav').innerHTML = Object.entries(PAGES).filter(([k]) => k !== 'admin' || isAdmin())
    .map(([k, t]) => `<button data-page="${k}">${t}</button>`).join('');
  $$('#nav button').forEach((b) => (b.onclick = () => go(b.dataset.page)));
}
function go(page) {
  if (!PAGES[page] || (page === 'admin' && !isAdmin())) page = 'list';
  if (location.hash.slice(1) !== page) history.replaceState(null, '', '#' + page);
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  ({ list: listPage, new: newPage, admin: adminPage })[page]();
}
window.addEventListener('hashchange', () => S.user && go(location.hash.slice(1)));

// ---------- ฟอร์มซอง (ใช้ทั้งบันทึกใหม่และแก้ไข) ----------
let customers = null;
async function loadCustomers(force) {
  if (!customers || force) customers = await api('/api/customers').catch(() => []);
  return customers;
}

const receiptRow = (r = {}) => `<tr class="rrow">
  <td class="rnum"></td>
  <td><input class="r-no" value="${esc(r.receipt_no)}" autocomplete="off" aria-label="เลขที่ใบเสร็จ" placeholder="เลขที่ใบเสร็จ"></td>
  <td><input class="r-cust" value="${esc(r.customer)}" list="custList" autocomplete="off" aria-label="ชื่อลูกค้าของใบเสร็จ" placeholder="(เหมือนผู้รับซอง)"></td>
  <td><input class="r-detail" value="${esc(r.detail)}" autocomplete="off" aria-label="รายละเอียดสินค้า" placeholder="เช่น หนังสือ ป.1 x 50 เล่ม"></td>
  <td><input class="r-date" type="date" value="${esc(r.bill_date)}" aria-label="วันที่ตัดบิล"></td>
  <td><input class="r-amt" inputmode="decimal" value="${r.amount == null || r.amount === '' ? '' : typeof r.amount === 'number' ? money(r.amount) : esc(r.amount)}" autocomplete="off" aria-label="ยอดเงิน (บาท)" placeholder="0.00"></td>
  <td><button type="button" class="btn ghost sm r-del" title="เอาใบนี้ออก" aria-label="เอาใบนี้ออก">✕</button></td></tr>`;

function parcelFields(p = {}) {
  const statusOpts = Object.entries(S.statuses).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('');
  return `<fieldset class="box"><legend>ใบเสร็จในซอง <span class="mute" data-count></span></legend>
      <div class="tablewrap"><table class="rtable"><thead><tr><th>#</th><th>เลขที่ใบเสร็จ <b class="req">*</b></th><th>ชื่อลูกค้า</th><th>รายละเอียดสินค้า</th><th>วันที่ตัดบิล <b class="req">*</b></th><th class="num">ยอดเงิน (บาท)</th><th></th></tr></thead>
        <tbody>${(p.receipts?.length ? p.receipts : [{}]).map(receiptRow).join('')}</tbody></table></div>
      <div class="bar" style="margin:8px 0 0">
        <button type="button" class="btn ghost sm" data-add>+ เพิ่มใบเสร็จ</button>
        <span class="mute">กด Enter ที่ช่องเลขที่เพื่อเพิ่มแถวถัดไป · วางเลขหลายใบพร้อมกันได้ (บรรทัดละเลข) · ชื่อลูกค้าและวันที่ตัดบิลจะใช้ตามแถวก่อนหน้า · เว้นชื่อลูกค้าว่าง = ใช้ชื่อผู้รับซอง</span>
      </div>
      <div class="dup" hidden></div>
    </fieldset>
    <fieldset class="box"><legend>การส่ง</legend>
      <div class="grid">
        <label class="span2"><span>ส่งถึง (ชื่อลูกค้าผู้รับ) <b class="req">*</b></span><input name="customer" required list="custList" value="${esc(p.customer)}" autocomplete="off"></label>
        <label><span>วันที่ส่ง <span class="mute">(ว่าง = ยังไม่ส่ง)</span></span><input name="sent_date" type="date" value="${esc(p.sent_date)}"></label>
        <label>สถานะ<select name="status"><option value="">อัตโนมัติ (ตามวันที่ส่ง)</option>${statusOpts}</select></label>
        <label>ส่งทาง<input name="carrier" list="carrierList" value="${esc(p.carrier)}" autocomplete="off"></label>
        <label>เลขพัสดุ<input name="tracking_no" value="${esc(p.tracking_no)}" autocomplete="off" placeholder="เช่น EF123456789TH"></label>
      </div>
      <label>ส่งไปที่ (ชื่อผู้รับ / ที่อยู่)<textarea name="destination" rows="3">${esc(p.destination)}</textarea></label>
      <label>หมายเหตุ<input name="note" value="${esc(p.note)}"></label>
    </fieldset>
    <datalist id="carrierList">${S.carriers.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="custList"></datalist>`;
}

// อ่านรายการใบเสร็จจากฟอร์ม
const formReceipts = (form) => $$('.rrow', form).map((tr) => ({ receipt_no: $('.r-no', tr).value.trim(), customer: $('.r-cust', tr).value.trim(),
  detail: $('.r-detail', tr).value.trim(), bill_date: $('.r-date', tr).value, amount: $('.r-amt', tr).value.trim() }))
  .filter((r) => r.receipt_no || r.customer || r.detail || r.amount);

// ผูกพฤติกรรมช่วยกรอก: แถวใบเสร็จ, เติมที่อยู่จากลูกค้าเดิม, เตือนเลขซ้ำ, ใส่วันที่ส่งเมื่อกรอกเลขพัสดุ
async function wireParcelForm(form, excludeId = 0) {
  const tbody = $('.rtable tbody', form), f = form.elements;
  const renumber = () => {
    $$('.rrow', form).forEach((tr, i) => ($('.rnum', tr).textContent = i + 1));
    const list = formReceipts(form), n = list.filter((r) => r.receipt_no).length, total = sumAmount(list);
    $('[data-count]', form).textContent = n ? `(${n} ใบ${total != null ? ` · รวม ${money(total)} บาท` : ''})` : '';
  };
  const lastDate = () => [...$$('.r-date', form)].reverse().find((i) => i.value)?.value || today();
  const lastCust = () => [...$$('.r-cust', form)].at(-1)?.value || '';
  const addRow = (r = {}, focus = true) => {
    tbody.insertAdjacentHTML('beforeend', receiptRow({ bill_date: lastDate(), customer: lastCust(), ...r }));
    const tr = tbody.lastElementChild;
    renumber();
    if (focus) $('.r-no', tr).focus();
    return tr;
  };
  $$('.r-date', form).forEach((i) => { if (!i.value) i.value = today(); });
  renumber();
  $('[data-add]', form).onclick = () => addRow();
  tbody.addEventListener('click', (e) => {
    if (!e.target.closest('.r-del')) return;
    const tr = e.target.closest('tr');
    if ($$('.rrow', form).length > 1) tr.remove(); else { $('.r-no', tr).value = ''; }
    renumber(); check();
  });
  tbody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.classList.contains('r-no')) return;
    e.preventDefault();
    const tr = e.target.closest('tr');
    const next = tr.nextElementSibling;
    if (next) $('.r-no', next).focus(); else if (e.target.value.trim()) addRow();
  });
  // วางหลายเลขพร้อมกัน (จาก Excel หรือรายการที่คัดลอกมา) → แยกเป็นหลายแถว
  tbody.addEventListener('paste', (e) => {
    if (!e.target.classList.contains('r-no')) return;
    const text = e.clipboardData?.getData('text') || '';
    const lines = text.split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim())).filter((c) => c[0]);
    if (lines.length < 2 && (lines[0] || []).length < 2) return;
    e.preventDefault();
    const amt = (cells) => [...cells.slice(1)].reverse().find((c) => numOrNull(c) != null) ?? '';
    const tr0 = e.target.closest('tr');
    e.target.value = lines[0][0];
    if (amt(lines[0]) !== '') $('.r-amt', tr0).value = amt(lines[0]);
    for (const cells of lines.slice(1)) addRow({ receipt_no: cells[0], amount: amt(cells) }, false);
    renumber(); check();
  });
  tbody.addEventListener('input', renumber);
  tbody.addEventListener('change', () => check());

  const list = await loadCustomers();
  $('#custList', form).innerHTML = list.map((c) => `<option value="${esc(c.customer)}">`).join('');
  f.customer.addEventListener('change', () => {
    const c = list.find((x) => x.customer === f.customer.value.trim());
    if (c && !f.destination.value.trim()) f.destination.value = c.destination;
    if (c && !f.carrier.value.trim()) f.carrier.value = c.carrier;
  });
  f.tracking_no.addEventListener('change', () => {
    if (f.tracking_no.value.trim() && !f.sent_date.value) f.sent_date.value = today();
    check();
  });

  const dupBox = $('.dup', form);
  let seq = 0;
  async function check() {
    const mine = ++seq;
    const receipts = formReceipts(form).map((r) => r.receipt_no).filter(Boolean);
    const r = await api('/api/check', { body: { receipts, tracking_no: f.tracking_no.value, exclude: excludeId } }).catch(() => null);
    if (!r || mine !== seq) return;
    const msgs = [];
    const counts = {};
    for (const no of receipts) counts[no] = (counts[no] || 0) + 1;
    for (const [no, n] of Object.entries(counts)) if (n > 1) msgs.push(`❌ เลขที่ใบเสร็จ ${esc(no)} ใส่ซ้ำในซองนี้`);
    for (const x of r.receipts) msgs.push(`⚠️ ใบเสร็จ ${esc(x.receipt_no)} เคยอยู่ในซองอื่นแล้ว: ${esc(x.customer)} (${x.sent_date ? `ส่ง ${thDate(x.sent_date)}` : 'รอส่ง'})`);
    for (const x of r.tracking) msgs.push(`⚠️ เลขพัสดุนี้เคยบันทึกกับซองของ ${esc(x.customer)} (${x.sent_date ? `ส่ง ${thDate(x.sent_date)}` : 'รอส่ง'})`);
    dupBox.innerHTML = msgs.length ? `<div class="warn">${msgs.join('<br>')}</div>` : '';
    dupBox.hidden = !msgs.length;
  }
  if (excludeId) check();
  return { addRow, renumber };
}
const parcelBody = (form, v) => ({ ...v, receipts: formReceipts(form) });

// ---------- new ----------
let savedThisRound = []; // ซองที่บันทึกในรอบนี้ (ล้างเมื่อไปหน้ารายการ)
function newPage() {
  $('#main').innerHTML = `<h2>บันทึกซองใหม่</h2>
    <p class="mute">1 ซอง = พัสดุ 1 ชิ้นที่ส่งให้ลูกค้า ใส่ใบเสร็จทุกใบที่อยู่ในซองนั้น แล้วกรอกข้อมูลการส่งครั้งเดียว</p>
    <div class="card"><form>${parcelFields()}
      <div class="err"></div><div class="actions"><button class="btn" type="submit">บันทึกซอง</button></div></form></div>
    ${savedThisRound.length ? `<div class="card"><b>บันทึกแล้วในรอบนี้ ${savedThisRound.length} ซอง</b>
      <div class="tablewrap"><table><tr><th>ลูกค้า</th><th>ใบเสร็จ</th><th>วันที่ส่ง</th><th>เลขพัสดุ</th></tr>
      ${savedThisRound.map((s) => `<tr><td>${esc(s.customer)}</td><td>${s.receipts.length} ใบ <span class="mute">${esc(s.receipts.map((r) => r.receipt_no).join(', '))}</span></td>
        <td class="nowrap">${thDate(s.sent_date) || '<span class="mute">ยังไม่ส่ง</span>'}</td><td class="track">${esc(String(s.tracking_no || '').toUpperCase())}</td></tr>`).join('')}
      </table></div></div>` : ''}`;
  const form = $('#main form');
  wireParcelForm(form);
  $('.r-no', form).focus();
  onSubmit(form, async (v) => {
    const body = parcelBody(form, v);
    await api('/api/parcels', { body });
    savedThisRound.unshift(body);
    toast(`บันทึกซองของ ${body.customer} แล้ว (${body.receipts.length} ใบ)`);
    loadCustomers(true);
    newPage();
  });
}

// ---------- list ----------
const F = { q: '', status: '', by: 'bill', from: '', to: '' };
function listPage() {
  savedThisRound = [];
  $('#main').innerHTML = `<h2>รายการซองที่ส่ง</h2>
    <div class="stats" id="stats"></div>
    <div class="card">
      <div class="bar">
        <label class="grow">ค้นหา (เลขใบเสร็จ / ลูกค้า / เลขพัสดุ / ที่อยู่)<input id="fq" type="search" value="${esc(F.q)}"></label>
        <label>ช่วงวันที่ของ<select id="fby"><option value="bill">วันที่ตัดบิล</option><option value="sent">วันที่ส่ง</option></select></label>
        <label>ตั้งแต่<input id="ffrom" type="date" value="${F.from}"></label>
        <label>ถึง<input id="fto" type="date" value="${F.to}"></label>
        <button class="btn ghost" id="fclear">ล้าง</button>
        <button class="btn ghost" id="fprint">พิมพ์</button>
        <button class="btn ghost" id="fxlsx">ส่งออก Excel</button>
        <button class="btn" id="fimport">นำเข้า Excel</button>
      </div>
      <div class="selbar" id="selbar" hidden><b id="selCount"></b><button class="btn sm" id="selEnv">พิมพ์หน้าซอง</button>
        <button class="btn sm" id="selSlip">พิมพ์ใบรายการใบเสร็จ</button>
        <button class="btn ghost sm" id="selNone">ยกเลิกการเลือก</button></div>
      <div class="print-head"><b>${esc(S.orgName)}</b> — รายการซองที่ส่ง <span id="printNote"></span></div>
      <div class="tablewrap" id="tbl"><p class="mute">กำลังโหลด…</p></div>
    </div>`;
  $('#fby').value = F.by;
  let t;
  $('#fq').oninput = () => { clearTimeout(t); t = setTimeout(() => { F.q = $('#fq').value; load(); }, 250); };
  for (const [id, k] of [['#fby', 'by'], ['#ffrom', 'from'], ['#fto', 'to']]) $(id).onchange = () => { F[k] = $(id).value; load(); };
  $('#fclear').onclick = () => { Object.assign(F, { q: '', status: '', by: 'bill', from: '', to: '' }); listPage(); };
  $('#fprint').onclick = () => window.print();
  $('#fxlsx').onclick = () => (location.href = '/api/export.xlsx?' + new URLSearchParams(F));
  $('#fimport').onclick = importDialog;
  $('#selNone').onclick = () => { $$('.pick').forEach((c) => (c.checked = false)); selChanged(); };
  $('#selEnv').onclick = () => envelopeDialog(rows.filter((p) => picked().includes(p.id)));
  $('#selSlip').onclick = () => slipDialog(rows.filter((p) => picked().includes(p.id)));
  load();
}

// แสดงเลขใบเสร็จในซอง: ถ้าค้นหาเลขใบเสร็จ ไฮไลต์ใบที่ตรง
function receiptChips(p) {
  const q = F.q.trim().toLowerCase();
  const max = 6;
  const hit = (r) => q && [r.receipt_no, r.customer, r.detail].some((x) => (x || '').toLowerCase().includes(q));
  const list = [...p.receipts].sort((a, b) => hit(b) - hit(a));
  return `<div class="chips">${list.slice(0, max).map((r) => `<span class="chip ${hit(r) ? 'hit' : ''}" title="${esc(r.customer || p.customer)} · ตัดบิล ${thDate(r.bill_date)}${r.amount != null ? ` · ${money(r.amount)} บาท` : ''}${r.detail ? ` · ${esc(r.detail)}` : ''}">${esc(r.receipt_no)}${r.customer ? ` <span class="chip-c">${esc(r.customer)}</span>` : ''}</span>`).join('')}
    ${list.length > max ? `<span class="mute">+อีก ${list.length - max} ใบ</span>` : ''}</div>`;
}
const billRange = (p) => {
  const ds = p.receipts.map((r) => r.bill_date).sort();
  return ds[0] === ds.at(-1) ? thDate(ds[0]) : `${thDate(ds[0])} – ${thDate(ds.at(-1))}`;
};

let rows = [];
async function load() {
  let data;
  try { data = await api('/api/parcels?' + new URLSearchParams(F)); }
  catch (e) { $('#tbl').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  rows = data.rows;
  const sum = (k) => Object.values(data.totals).reduce((a, t) => a + t[k], 0);
  const stat = (k, label, t) => `<button class="stat ${k} ${F.status === k ? 'on' : ''}" data-st="${k}">${label}<b>${(t?.parcels || 0).toLocaleString()} <small>ซอง</small></b>
    <span class="mute">${(t?.receipts || 0).toLocaleString()} ใบเสร็จ</span></button>`;
  $('#stats').innerHTML = stat('', 'ทั้งหมด', F.status ? data.totals[F.status] : { parcels: sum('parcels'), receipts: sum('receipts') })
    + Object.entries(S.statuses).map(([k, l]) => stat(k, l, data.totals[k])).join('');
  $$('#stats .stat').forEach((b) => (b.onclick = () => { F.status = F.status === b.dataset.st ? '' : b.dataset.st; load(); }));
  const by = F.by === 'sent' ? 'วันที่ส่ง' : 'วันที่ตัดบิล';
  $('#printNote').textContent = [F.from || F.to ? `${by} ${thDate(F.from) || '…'} – ${thDate(F.to) || '…'}` : '',
    F.status ? `สถานะ: ${S.statuses[F.status]}` : '', F.q ? `ค้นหา: ${F.q}` : '', `(${rows.length} ซอง)`].filter(Boolean).join(' · ');
  if (!rows.length) { $('#tbl').innerHTML = '<p class="mute">ไม่พบรายการ</p>'; selChanged(); return; }
  $('#tbl').innerHTML = `<table class="ships"><thead><tr>
      <th class="noprint pickcell"><input type="checkbox" id="pickAll" title="เลือกทั้งหมด" aria-label="เลือกทั้งหมด"></th><th>ลูกค้า / ใบเสร็จในซอง</th><th>ตัดบิล</th><th>วันที่ส่ง</th><th>ส่งไปที่</th><th>ส่งทาง</th><th>เลขพัสดุ</th><th>สถานะ</th></tr></thead>
    <tbody>${rows.map((p) => `<tr class="click ${p.status}" data-id="${p.id}">
      <td class="noprint pickcell"><input type="checkbox" class="pick" value="${p.id}" aria-label="เลือกซอง ${esc(p.customer)}"></td>
      <td class="cust"><b>${esc(p.customer)}</b> <span class="count">${p.receipts.length} ใบ${sumAmount(p.receipts) != null ? ` · ${money(sumAmount(p.receipts))} บาท` : ''}</span>${receiptChips(p)}${p.note ? `<div class="mute">${esc(p.note)}</div>` : ''}</td>
      <td class="nowrap" data-l="ตัดบิล">${billRange(p)}</td>
      <td class="nowrap" data-l="วันที่ส่ง">${thDate(p.sent_date) || '<span class="mute">-</span>'}</td>
      <td class="addr" data-l="ส่งไปที่">${esc(p.destination).replace(/\n/g, '<br>') || '<span class="mute">-</span>'}</td>
      <td data-l="ส่งทาง">${esc(p.carrier) || '<span class="mute">-</span>'}</td>
      <td class="track nowrap" data-l="เลขพัสดุ">${trackHtml(p)}</td><td class="st">${tag(p.status)}</td></tr>`).join('')}</tbody></table>
    ${rows.length >= 300 ? '<p class="mute">แสดง 300 ซองล่าสุด — ใช้ตัวกรองหรือส่งออก Excel เพื่อดูทั้งหมด</p>' : ''}`;
  $$('#tbl tbody tr').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input, .pickcell')) return;
    editDialog(Number(tr.dataset.id));
  }));
  $('#pickAll').onchange = (e) => { $$('.pick').forEach((c) => (c.checked = e.target.checked)); selChanged(); };
  $$('.pick').forEach((c) => (c.onchange = selChanged));
  selChanged();
}
const picked = () => $$('.pick').filter((c) => c.checked).map((c) => Number(c.value));
function selChanged() {
  const n = picked().length;
  $('#selbar').hidden = !n;
  $('#selCount').textContent = `เลือก ${n} ซอง`;
}

const FIELD_TH = { customer: 'ลูกค้า', sent_date: 'วันที่ส่ง', destination: 'ส่งไปที่', carrier: 'ส่งทาง', tracking_no: 'เลขพัสดุ',
  status: 'สถานะ', note: 'หมายเหตุ', receipts: 'ใบเสร็จในซอง' };
function histHtml(edits) {
  const fmt = (k, v) => (k.endsWith('_date') ? thDate(v) : k === 'status' ? S.statuses[v] : k === 'receipts'
    ? v.replace(/(\d{4}-\d{2}-\d{2})/g, (d) => thDate(d)) : v) || '(ว่าง)';
  return edits.map((e) => `<div>${thTime(e.edited_at)} · ${esc(e.name)} แก้: ${Object.entries(JSON.parse(e.before))
    .map(([k, v]) => (k === 'via' ? `(${esc(v)})` : `${FIELD_TH[k] || k} เดิม "${esc(fmt(k, v))}"`)).join(', ')}</div>`).join('');
}

async function editDialog(id) {
  let p;
  try { p = await api(`/api/parcels/${id}`); } catch (e) { return toast(e.message, true); }
  const hist = histHtml(p.edits);
  const d = dialog(`<h3>ซองของ ${esc(p.customer)} ${tag(p.status)}</h3><form>${parcelFields(p)}
    <p class="mute">บันทึกโดย ${esc(p.created_name)} ${thTime(p.created_at)}${p.updated_at ? ` · แก้ล่าสุด ${esc(p.updated_name)} ${thTime(p.updated_at)}` : ''}</p>
    ${hist ? `<div class="hist"><b>ประวัติการแก้ไข</b>${hist}</div>` : ''}
    <div class="err"></div><div class="actions">
      ${isAdmin() ? '<button type="button" class="btn danger left" id="del">ลบซองนี้</button>' : ''}
      <button type="button" class="btn ghost" id="envBtn">พิมพ์หน้าซอง</button>
      <button type="button" class="btn ghost" id="slipBtn">พิมพ์ใบรายการใบเสร็จ</button>
      <button type="button" class="btn ghost" data-close>ปิด</button><button class="btn" type="submit">บันทึกการแก้ไข</button></div></form>`, true);
  const form = $('form', d);
  form.elements.status.value = p.status;
  wireParcelForm(form, id);
  $('#slipBtn', d).onclick = () => slipDialog([p]);
  $('#envBtn', d).onclick = () => envelopeDialog([p]);
  onSubmit(form, async (v) => {
    const res = await api(`/api/parcels/${id}`, { method: 'PUT', body: parcelBody(form, v) });
    d.close(); toast(res.unchanged ? 'ไม่มีการเปลี่ยนแปลง' : 'บันทึกการแก้ไขแล้ว'); loadCustomers(true); load();
  });
  if (isAdmin()) $('#del', d).onclick = () => {
    const box = document.createElement('div');
    box.className = 'warn';
    box.innerHTML = `<label>เหตุผลที่ลบ (ซองจะถูกซ่อน ไม่ได้ลบจริง)<input id="delReason"></label>
      <div class="actions"><button type="button" class="btn ghost sm" id="delNo">ไม่ลบ</button><button type="button" class="btn danger sm" id="delYes">ยืนยันลบ</button></div>`;
    $('.actions', form).before(box);
    $('#del', d).disabled = true;
    $('#delReason', box).focus();
    $('#delNo', box).onclick = () => { box.remove(); $('#del', d).disabled = false; };
    $('#delYes', box).onclick = async () => {
      const reason = $('#delReason', box).value.trim();
      if (!reason) return toast('ระบุเหตุผลที่ลบ', true);
      try { await api(`/api/parcels/${id}/delete`, { body: { reason } }); d.close(); toast('ลบซองแล้ว'); load(); }
      catch (e) { toast(e.message, true); }
    };
  };
}

// ---------- หน้าซอง ----------
// แยกรหัสไปรษณีย์ 5 หลักท้ายที่อยู่ออกมาพิมพ์เป็นช่อง
function splitPostcode(text) {
  const m = /^([\s\S]*?)[\s,]*(\d{5})\s*$/.exec(text || '');
  return m ? { address: m[1].trim(), postcode: m[2] } : { address: (text || '').trim(), postcode: '' };
}
function envelopeHtml(p, opt) {
  const e = S.envelope;
  const { address, postcode } = splitPostcode(p.destination);
  // ถ้าที่อยู่มีชื่อลูกค้าอยู่แล้ว ไม่พิมพ์ชื่อซ้ำ
  const showName = !address.includes(p.customer);
  const nl = (t) => esc(t).replace(/\n/g, '<br>');
  const refs = p.receipts.map((r) => r.receipt_no);
  return `<div class="env-page" style="width:${e.env_w}in;height:${e.env_h}in">
    <div class="env-inner" style="transform:translate(${e.env_dx}mm,${e.env_dy}mm)">
      <div class="env-from"><div class="env-label">ผู้ส่ง</div><b>${esc(e.env_sender_name || S.orgName)}</b><br>${nl(e.env_sender_address)}</div>
      <div class="env-to"><div class="env-label">กรุณาส่ง</div>
        ${showName ? `<div class="env-name">${esc(p.customer)}</div>` : ''}
        <div class="env-addr">${nl(address) || (showName ? '' : esc(p.customer))}</div>
        ${postcode ? `<div class="env-zip">${[...postcode].map((c) => `<span>${c}</span>`).join('')}</div>` : ''}
      </div>
      ${opt.refs ? `<div class="env-ref">ใบเสร็จ ${refs.length} ใบ: ${esc(refs.slice(0, 15).join(', '))}${refs.length > 15 ? ` และอีก ${refs.length - 15} ใบ` : ''}</div>` : ''}
    </div></div>`;
}

function envelopeDialog(parcels) {
  const e = S.envelope;
  const noAddr = parcels.filter((p) => !p.destination.trim());
  const d = dialog(`<h3>พิมพ์หน้าซอง ${parcels.length} ซอง</h3>
    <p class="mute">ขนาดซอง ${e.env_w} × ${e.env_h} นิ้ว${isAdmin() ? ' (เปลี่ยนขนาด ผู้ส่ง และตำแหน่งได้ที่ ผู้ใช้และตั้งค่า)' : ''} ·
      ตอนสั่งพิมพ์ ให้เลือกขนาดกระดาษในเครื่องพิมพ์ให้ตรงกับซอง และตั้งขอบกระดาษ (Margins) เป็น "ไม่มี"</p>
    ${!e.env_sender_address ? `<div class="warn">ยังไม่ได้ตั้งที่อยู่ผู้ส่ง${isAdmin() ? ' — ตั้งได้ที่เมนู ผู้ใช้และตั้งค่า' : ' — แจ้งผู้ดูแลให้ตั้งค่า'}</div>` : ''}
    ${noAddr.length ? `<div class="warn">ซองที่ยังไม่มีที่อยู่ผู้รับ: ${noAddr.map((p) => esc(p.customer)).join(', ')}</div>` : ''}
    <label class="checkrow"><input type="checkbox" id="envRefs" checked> พิมพ์เลขที่ใบเสร็จตัวเล็กที่มุมซ้ายล่าง (ไว้ตรวจว่าใส่ใบเสร็จครบ)</label>
    <div class="env-preview" id="envPrev"></div>
    <div class="actions"><button type="button" class="btn ghost" data-close>ปิด</button><button type="button" class="btn" id="envGo">พิมพ์</button></div>`, true);
  const render = () => {
    const opt = { refs: $('#envRefs', d).checked };
    const box = $('#envPrev', d);
    box.innerHTML = parcels.map((p) => `<div class="env-scale">${envelopeHtml(p, opt)}</div>`).join('');
    // ย่อให้พอดีกว้างของหน้าต่าง
    const scale = Math.min(1, (box.clientWidth - 4) / (e.env_w * 96));
    $$('.env-scale', box).forEach((w) => { w.style.height = `${e.env_h * 96 * scale}px`; w.firstElementChild.style.transform = `scale(${scale})`; });
    return opt;
  };
  render();
  $('#envRefs', d).onchange = render;
  $('#envGo', d).onclick = () => printEnvelopes(parcels, render());
}

// พิมพ์เฉพาะหน้าที่สร้างขึ้น (ซ่อนส่วนอื่นของหน้าเว็บ) พร้อมกำหนดขนาดกระดาษ
function printPages(html, pageCss) {
  const area = document.createElement('div');
  area.id = 'printArea';
  area.innerHTML = html;
  const page = document.createElement('style');
  page.textContent = `@page { ${pageCss} }`;
  document.head.append(page);
  document.body.append(area);
  document.body.classList.add('printing-env');
  const done = () => {
    area.remove(); page.remove();
    document.body.classList.remove('printing-env');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1000);
}
function printEnvelopes(parcels, opt) {
  printPages(parcels.map((p) => envelopeHtml(p, opt)).join(''), `size: ${S.envelope.env_w}in ${S.envelope.env_h}in; margin: 0;`);
}

// ---------- ใบรายการใบเสร็จ (A4 ใส่ไปในซองให้ลูกค้า) ----------
function slipHtml(p, opt) {
  const e = S.envelope;
  const nl = (t) => esc(t).replace(/\n/g, '<br>');
  const sorted = opt.sort
    ? [...p.receipts].sort((a, b) => a.bill_date.localeCompare(b.bill_date) || a.receipt_no.localeCompare(b.receipt_no, 'th', { numeric: true }))
    : p.receipts;
  const total = sumAmount(p.receipts), showAmt = opt.amount && total != null;
  const showCust = p.receipts.some((r) => r.customer && r.customer !== p.customer); // ลูกค้าคนละรายกับผู้รับ
  const longDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  return `<div class="slip-page">
    <div class="slip-head"><div><div class="slip-org">${esc(e.env_sender_name || S.orgName)}</div><div class="slip-small">${nl(e.env_sender_address)}</div></div>
      <div class="slip-date">วันที่ ${longDate(p.sent_date || today())}</div></div>
    <h1 class="slip-title">รายการใบเสร็จรับเงินที่จัดส่ง</h1>
    <table class="slip-info"><tr><th>เรียน</th><td><b>${esc(p.customer)}</b>${p.destination ? `<br>${nl(p.destination)}` : ''}</td></tr>
      ${p.carrier || p.tracking_no ? `<tr><th>จัดส่งทาง</th><td>${esc(p.carrier) || '-'}${p.tracking_no ? ` &nbsp; เลขพัสดุ <b>${esc(p.tracking_no)}</b>` : ''}</td></tr>` : ''}</table>
    <p>ขอนำส่งใบเสร็จรับเงิน จำนวน <b>${p.receipts.length}</b> ฉบับ${showAmt ? ` รวมเป็นเงิน <b>${money(total)}</b> บาท` : ''} ตามรายการดังต่อไปนี้</p>
    <table class="slip-list"><thead><tr><th class="c">ลำดับ</th><th>เลขที่ใบเสร็จ</th><th>วันที่</th>${showCust ? '<th>ชื่อลูกค้า</th>' : ''}${opt.detail ? '<th>รายละเอียดสินค้า</th>' : ''}${showAmt ? '<th class="num">จำนวนเงิน (บาท)</th>' : ''}<th class="c">ตรวจรับ</th></tr></thead>
      <tbody>${sorted.map((r, i) => `<tr><td class="c">${i + 1}</td><td class="nowrap">${esc(r.receipt_no)}</td><td class="nowrap">${thDate(r.bill_date)}</td>
        ${showCust ? `<td>${esc(r.customer || p.customer)}</td>` : ''}${opt.detail ? `<td>${esc(r.detail)}</td>` : ''}${showAmt ? `<td class="num">${r.amount != null ? money(r.amount) : '-'}</td>` : ''}<td class="c">☐</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="${3 + (showCust ? 1 : 0) + (opt.detail ? 1 : 0)}">รวมทั้งสิ้น <b>${p.receipts.length}</b> ฉบับ${showAmt ? `<div class="slip-words">(${bahtText(total)})</div>` : ''}</td>
        ${showAmt ? `<td class="num"><b>${money(total)}</b></td>` : ''}<td></td></tr></tfoot></table>
    ${p.note && opt.note ? `<p class="slip-small">หมายเหตุ: ${esc(p.note)}</p>` : ''}
    <p>กรุณาตรวจสอบเอกสาร หากไม่ครบถ้วนหรือมีข้อสงสัย กรุณาติดต่อกลับ${opt.contact ? ` ${esc(opt.contact)}` : ''}</p>
    ${opt.sign ? `<div class="slip-sign"><div>ลงชื่อ ..................................................<br>ผู้จัดส่ง<br>วันที่ ........./........./.........</div>
      <div>ลงชื่อ ..................................................<br>ผู้รับเอกสาร<br>วันที่ ........./........./.........</div></div>` : ''}
  </div>`;
}

function slipDialog(parcels) {
  let lastContact = '';
  try { lastContact = localStorage.getItem('slip-contact') || ''; } catch {}
  const d = dialog(`<h3>พิมพ์ใบรายการใบเสร็จ ${parcels.length} ซอง</h3>
    <p class="mute">กระดาษ A4 · 1 ซองได้ 1 ชุด ถ้าใบเสร็จเยอะจะต่อขึ้นหน้าถัดไปเอง</p>
    <div class="grid">
      <label class="checkrow"><input type="checkbox" id="slAmt" checked> แสดงยอดเงินและยอดรวม</label>
      <label class="checkrow"><input type="checkbox" id="slDetail" checked> แสดงรายละเอียดสินค้า</label>
      <label class="checkrow"><input type="checkbox" id="slSign" checked> ช่องลงชื่อผู้จัดส่ง / ผู้รับ</label>
      <label class="checkrow"><input type="checkbox" id="slSort" checked> เรียงตามวันที่และเลขที่ใบเสร็จ</label>
      <label class="checkrow"><input type="checkbox" id="slNote"> พิมพ์หมายเหตุของซอง</label>
    </div>
    <label>เบอร์ติดต่อกลับ (แสดงท้ายเอกสาร)<input id="slContact" value="${esc(lastContact)}" placeholder="เช่น ฝ่ายบัญชี โทร 02-123-4567"></label>
    <div class="env-preview" id="slPrev"></div>
    <div class="actions"><button type="button" class="btn ghost" data-close>ปิด</button><button type="button" class="btn" id="slGo">พิมพ์</button></div>`, true);
  const opt = () => ({ amount: $('#slAmt', d).checked, detail: $('#slDetail', d).checked, sign: $('#slSign', d).checked, sort: $('#slSort', d).checked, note: $('#slNote', d).checked, contact: $('#slContact', d).value.trim() });
  const render = () => {
    const box = $('#slPrev', d), o = opt();
    box.innerHTML = parcels.map((p) => `<div class="env-scale">${slipHtml(p, o)}</div>`).join('');
    const pageW = (210 / 25.4) * 96, scale = Math.min(1, (box.clientWidth - 4) / pageW);
    $$('.env-scale', box).forEach((w) => {
      const pg = w.firstElementChild;
      pg.style.transform = `scale(${scale})`;
      w.style.height = `${pg.offsetHeight * scale}px`;
    });
    return o;
  };
  render();
  $$('input', d).forEach((i) => (i.oninput = i.onchange = render));
  $('#slGo', d).onclick = () => {
    const o = render();
    try { localStorage.setItem('slip-contact', o.contact); } catch {}
    printSlips(parcels, o);
  };
}
function printSlips(parcels, o) {
  printPages(parcels.map((p) => slipHtml(p, o)).join(''), 'size: A4 portrait; margin: 15mm 15mm 15mm 18mm;');
}

async function envelopeSettingsCard() {
  const e = S.envelope;
  return `<div class="card"><h3 style="margin-top:0">หน้าซอง</h3><form id="envForm">
    <div class="grid">
      <label>ชื่อผู้ส่ง <span class="mute">(ว่าง = ใช้ชื่อหน่วยงาน)</span><input name="env_sender_name" value="${esc(e.env_sender_name)}"></label>
      <label class="span2">ที่อยู่ผู้ส่ง (พิมพ์หลายบรรทัดได้ ใส่เบอร์โทรด้วยก็ได้)<textarea name="env_sender_address" rows="3">${esc(e.env_sender_address)}</textarea></label>
    </div>
    <div class="grid">
      <label>ขนาดซองสำเร็จรูป<select id="envPreset">
        <option value="12.5x9">9 × 12½ นิ้ว</option><option value="12.75x9">9 × 12¾ นิ้ว (A4)</option><option value="10x7">7 × 10 นิ้ว</option>
        <option value="9.5x4.125">4⅛ × 9½ นิ้ว (#10)</option><option value="8.66x4.33">DL 110 × 220 มม.</option><option value="">กำหนดเอง</option></select></label>
      <label>ด้านยาว (นิ้ว)<input name="env_w" type="number" step="0.01" min="3" max="20" value="${e.env_w}" required></label>
      <label>ด้านสั้น (นิ้ว)<input name="env_h" type="number" step="0.01" min="3" max="20" value="${e.env_h}" required></label>
      <label>เลื่อนขวา (มม.) <span class="mute">ติดลบ = ซ้าย</span><input name="env_dx" type="number" step="0.5" min="-50" max="50" value="${e.env_dx}"></label>
      <label>เลื่อนลง (มม.) <span class="mute">ติดลบ = ขึ้น</span><input name="env_dy" type="number" step="0.5" min="-50" max="50" value="${e.env_dy}"></label>
    </div>
    <p class="mute">ถ้าพิมพ์ออกมาแล้วตัวหนังสือเยื้อง ให้ปรับ "เลื่อนขวา/เลื่อนลง" แล้วลองพิมพ์ใหม่</p>
    <div class="err"></div><div class="actions"><button type="button" class="btn ghost" id="envTest">ดูตัวอย่างหน้าซอง</button><button class="btn" type="submit">บันทึก</button></div>
  </form></div>`;
}
function wireEnvelopeSettings() {
  const f = $('#envForm').elements, preset = $('#envPreset');
  const sync = () => { const k = `${Number(f.env_w.value)}x${Number(f.env_h.value)}`; preset.value = [...preset.options].some((o) => o.value === k) ? k : ''; };
  sync();
  preset.onchange = () => { if (preset.value) [f.env_w.value, f.env_h.value] = preset.value.split('x'); };
  f.env_w.oninput = f.env_h.oninput = sync;
  onSubmit($('#envForm'), async (v) => { const r = await api('/api/settings', { method: 'PUT', body: v }); S.envelope = r.envelope; toast('บันทึกค่าหน้าซองแล้ว'); });
  $('#envTest').onclick = () => {
    const saved = S.envelope;
    S.envelope = { ...saved, ...Object.fromEntries(new FormData($('#envForm'))) };
    envelopeDialog([{ customer: 'บริษัท ตัวอย่างผู้รับ จำกัด', destination: 'ฝ่ายบัญชี\n99/1 ถ.สุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพฯ 10110',
      receipts: [{ receipt_no: 'RC0001', amount: 12500 }, { receipt_no: 'RC0002', amount: 3480.5 }] }]);
    $('#dlg').addEventListener('close', () => (S.envelope = saved), { once: true });
  };
}

// ---------- import ----------
function importDialog() {
  const d = dialog(`<h3>นำเข้าจาก Excel</h3>
    <p class="mute">1 แถว = ใบเสร็จ 1 ใบ · ใบเสร็จที่มี<b>เลขพัสดุเดียวกัน</b>จะรวมเป็นซองเดียว
      (ถ้ายังไม่มีเลขพัสดุ จะรวมตามลูกค้า + วันที่ส่ง + ที่อยู่) · คอลัมน์: เลขที่ใบเสร็จ, วันที่ตัดบิล, ชื่อลูกค้า, วันที่ส่ง, ส่งไปที่, ส่งทาง, เลขพัสดุ, หมายเหตุ
      (ลำดับไม่สำคัญ วันที่ใช้ วว/ดด/ปปปป ได้ทั้ง พ.ศ. และ ค.ศ.) · <a href="/api/import-template.xlsx">ดาวน์โหลดไฟล์แม่แบบ</a></p>
    <form>
      <label>ไฟล์ Excel (.xlsx, .xls, .csv)<input type="file" name="file" accept=".xlsx,.xls,.csv" required></label>
      <label>ถ้าเลขที่ใบเสร็จมีอยู่แล้วในระบบ<select name="mode">
        <option value="skip">ข้าม (เพิ่มเฉพาะใบเสร็จใหม่)</option>
        <option value="update">อัปเดตซองเดิม ด้วยข้อมูลการส่งในไฟล์ (เช่น เติมวันที่ส่ง/เลขพัสดุ)</option></select></label>
      <div id="impResult"></div>
      <div class="err"></div>
      <div class="actions"><button type="button" class="btn ghost" data-close>ยกเลิก</button>
        <button class="btn" type="submit" id="impGo" disabled>นำเข้า</button></div>
    </form>`, true);
  const form = $('form', d), out = $('#impResult', d), go = $('#impGo', d);
  let b64 = '';
  const check = async () => {
    go.disabled = true; $('.err', form).textContent = ''; out.innerHTML = b64 ? '<p class="mute">กำลังตรวจไฟล์…</p>' : '';
    if (!b64) return;
    try {
      const r = await api('/api/import', { body: { file: b64, mode: form.elements.mode.value } });
      const n = r.createParcels + r.updateParcels;
      out.innerHTML = `<div class="card" style="margin:0">
        <b>ตรวจแล้ว (แผ่นงาน "${esc(r.sheet)}")</b>: ซองใหม่ <b>${r.createParcels}</b> (${r.createReceipts} ใบเสร็จ) · อัปเดตซองเดิม <b>${r.updateParcels}</b> · ข้าม ${r.skipped}
        ${r.errorCount ? ` · <span style="color:var(--bad)">มีปัญหา ${r.errorCount} แถว (จะไม่ถูกนำเข้า)</span>` : ''}
        ${r.errors.length ? `<div class="warn" style="margin-top:8px;max-height:140px;overflow:auto">${r.errors.map((e) =>
          `แถว ${e.line}${e.receipt_no ? ` (${esc(e.receipt_no)})` : ''}: ${esc(e.msg)}`).join('<br>')}</div>` : ''}
        ${r.preview.length ? `<div class="tablewrap" style="max-height:280px;overflow:auto;margin-top:8px"><table>
          <tr><th></th><th>ลูกค้า</th><th>ใบเสร็จ</th><th class="num">ยอดรวม</th><th>วันที่ส่ง</th><th>เลขพัสดุ</th></tr>
          ${r.preview.map((p) => `<tr><td>${p.action === 'create' ? '<span class="tag received">ซองใหม่</span>' : '<span class="tag sent">อัปเดต</span>'}</td>
            <td>${esc(p.customer)}</td><td>${p.receipts.length} ใบ <span class="mute">${esc(p.receipts.map((x) => x.receipt_no).join(', '))}</span></td>
            <td class="num">${sumAmount(p.receipts) != null ? money(sumAmount(p.receipts)) : '-'}</td>
            <td class="nowrap">${thDate(p.sent_date) || '-'}</td><td class="track">${esc(p.tracking_no)}</td></tr>`).join('')}
        </table></div>${n > r.preview.length ? `<p class="mute">แสดง ${r.preview.length} จาก ${n} ซอง</p>` : ''}` : ''}</div>`;
      go.textContent = n ? `ยืนยันนำเข้า ${n} ซอง` : 'นำเข้า';
      go.disabled = !n;
    } catch (e) { out.innerHTML = ''; $('.err', form).textContent = e.message; }
  };
  form.elements.file.onchange = () => {
    const f = form.elements.file.files[0];
    b64 = '';
    if (!f) return check();
    if (f.size > 5 * 1024 * 1024) { $('.err', form).textContent = 'ไฟล์ใหญ่เกิน 5 MB'; return; }
    const rd = new FileReader();
    rd.onload = () => { b64 = String(rd.result).split(',')[1] || ''; check(); };
    rd.readAsDataURL(f);
  };
  form.elements.mode.onchange = check;
  onSubmit(form, async (v) => {
    const r = await api('/api/import', { body: { file: b64, mode: v.mode, commit: true } });
    d.close(); toast(`นำเข้าแล้ว: ซองใหม่ ${r.createParcels} · อัปเดต ${r.updateParcels}`); loadCustomers(true); load();
  });
}

// ---------- admin ----------
async function adminPage() {
  $('#main').innerHTML = `<h2>ผู้ใช้และตั้งค่า</h2>
    <div class="card"><form id="orgForm" class="bar"><label class="grow">ชื่อหน่วยงาน (แสดงหน้าเข้าสู่ระบบและหัวรายงาน)
      <input name="orgName" required value="${esc(S.orgName)}"></label><button class="btn" type="submit">บันทึก</button><div class="err"></div></form></div>
    ${await envelopeSettingsCard()}
    <div class="card"><div class="bar"><b class="grow">ผู้ใช้งาน</b><button class="btn" id="addUser">+ เพิ่มผู้ใช้</button></div>
      <div class="tablewrap" id="users"></div>
      <p class="mute">พนักงาน: บันทึกและแก้ไขรายการได้ · ผู้ดูแล: ทำได้ทุกอย่าง รวมถึงลบรายการและจัดการผู้ใช้</p></div>`;
  onSubmit($('#orgForm'), async (v) => { await api('/api/settings', { method: 'PUT', body: v }); S.orgName = v.orgName; toast('บันทึกแล้ว'); });
  wireEnvelopeSettings();
  $('#addUser').onclick = () => userDialog();
  const users = await api('/api/users');
  $('#users').innerHTML = `<table><tr><th>ชื่อผู้ใช้</th><th>ชื่อ-สกุล</th><th>สิทธิ์</th><th>สถานะ</th><th></th></tr>
    ${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.name)}</td><td>${u.role === 'admin' ? 'ผู้ดูแล' : 'พนักงาน'}</td>
      <td>${u.active ? 'ใช้งาน' : '<span class="mute">ปิดใช้งาน</span>'}</td><td><button class="btn ghost sm" data-u="${u.id}">แก้ไข</button></td></tr>`).join('')}</table>`;
  $$('[data-u]').forEach((b) => (b.onclick = () => userDialog(users.find((u) => u.id === Number(b.dataset.u)))));
}

function userDialog(u) {
  const d = dialog(`<h3>${u ? 'แก้ไขผู้ใช้' : 'เพิ่มผู้ใช้'}</h3><form>
    ${u ? `<p class="mute">ชื่อผู้ใช้: ${esc(u.username)}</p>` : '<label>ชื่อผู้ใช้<input name="username" required autocomplete="off"></label>'}
    <label>ชื่อ-สกุล<input name="name" required value="${esc(u?.name)}"></label>
    <label>สิทธิ์<select name="role"><option value="staff">พนักงาน</option><option value="admin">ผู้ดูแล</option></select></label>
    ${u ? '<label>สถานะ<select name="active"><option value="1">ใช้งาน</option><option value="">ปิดใช้งาน</option></select></label>' : ''}
    <label>${u ? 'ตั้งรหัสผ่านใหม่ (เว้นว่าง = ไม่เปลี่ยน)' : 'รหัสผ่าน (อย่างน้อย 6 ตัว)'}<input name="password" type="password" ${u ? '' : 'required'} minlength="6" autocomplete="new-password"></label>
    <div class="err"></div><div class="actions"><button type="button" class="btn ghost" data-close>ยกเลิก</button><button class="btn" type="submit">บันทึก</button></div></form>`);
  const f = $('form', d).elements;
  if (u) { f.role.value = u.role; f.active.value = u.active ? '1' : ''; }
  onSubmit($('form', d), async (v) => {
    if (u) await api(`/api/users/${u.id}`, { method: 'PUT', body: { ...v, active: !!v.active } });
    else await api('/api/users', { body: v });
    d.close(); toast('บันทึกแล้ว'); adminPage();
  });
}

boot();
