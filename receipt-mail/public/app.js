// ระบบบันทึกการส่งใบเสร็จ : หน้าเว็บ
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const thDate = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${Number(d.slice(0, 4)) + 543}` : '');
const thTime = (iso) => (iso ? new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '');

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
  <td><input class="r-date" type="date" value="${esc(r.bill_date)}" aria-label="วันที่ตัดบิล"></td>
  <td><button type="button" class="btn ghost sm r-del" title="เอาใบนี้ออก" aria-label="เอาใบนี้ออก">✕</button></td></tr>`;

function parcelFields(p = {}) {
  const statusOpts = Object.entries(S.statuses).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('');
  return `<fieldset class="box"><legend>ใบเสร็จในซอง <span class="mute" data-count></span></legend>
      <div class="tablewrap"><table class="rtable"><thead><tr><th>#</th><th>เลขที่ใบเสร็จ <b class="req">*</b></th><th>วันที่ตัดบิล <b class="req">*</b></th><th></th></tr></thead>
        <tbody>${(p.receipts?.length ? p.receipts : [{}]).map(receiptRow).join('')}</tbody></table></div>
      <div class="bar" style="margin:8px 0 0">
        <button type="button" class="btn ghost sm" data-add>+ เพิ่มใบเสร็จ</button>
        <span class="mute">กด Enter ที่ช่องเลขที่เพื่อเพิ่มแถวถัดไป · วางเลขหลายใบพร้อมกันได้ (บรรทัดละเลข) · วันที่ตัดบิลจะใช้ตามแถวก่อนหน้า</span>
      </div>
      <div class="dup" hidden></div>
    </fieldset>
    <fieldset class="box"><legend>การส่ง</legend>
      <div class="grid">
        <label class="span2"><span>ชื่อลูกค้า <b class="req">*</b></span><input name="customer" required list="custList" value="${esc(p.customer)}" autocomplete="off"></label>
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
const formReceipts = (form) => $$('.rrow', form).map((tr) => ({ receipt_no: $('.r-no', tr).value.trim(), bill_date: $('.r-date', tr).value }))
  .filter((r) => r.receipt_no || r.bill_date);

// ผูกพฤติกรรมช่วยกรอก: แถวใบเสร็จ, เติมที่อยู่จากลูกค้าเดิม, เตือนเลขซ้ำ, ใส่วันที่ส่งเมื่อกรอกเลขพัสดุ
async function wireParcelForm(form, excludeId = 0) {
  const tbody = $('.rtable tbody', form), f = form.elements;
  const renumber = () => {
    $$('.rrow', form).forEach((tr, i) => ($('.rnum', tr).textContent = i + 1));
    const n = formReceipts(form).filter((r) => r.receipt_no).length;
    $('[data-count]', form).textContent = n ? `(${n} ใบ)` : '';
  };
  const lastDate = () => [...$$('.r-date', form)].reverse().find((i) => i.value)?.value || today();
  const addRow = (r = {}, focus = true) => {
    tbody.insertAdjacentHTML('beforeend', receiptRow({ bill_date: lastDate(), ...r }));
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
    const lines = text.split(/\r?\n/).map((l) => l.split('\t')[0].trim()).filter(Boolean);
    if (lines.length < 2) return;
    e.preventDefault();
    e.target.value = lines[0];
    for (const no of lines.slice(1)) addRow({ receipt_no: no }, false);
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
  load();
}

// แสดงเลขใบเสร็จในซอง: ถ้าค้นหาเลขใบเสร็จ ไฮไลต์ใบที่ตรง
function receiptChips(p) {
  const q = F.q.trim().toLowerCase();
  const max = 6;
  const hit = (r) => q && r.receipt_no.toLowerCase().includes(q);
  const list = [...p.receipts].sort((a, b) => hit(b) - hit(a));
  return `<div class="chips">${list.slice(0, max).map((r) => `<span class="chip ${hit(r) ? 'hit' : ''}" title="ตัดบิล ${thDate(r.bill_date)}">${esc(r.receipt_no)}</span>`).join('')}
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
  if (!rows.length) { $('#tbl').innerHTML = '<p class="mute">ไม่พบรายการ</p>'; return; }
  $('#tbl').innerHTML = `<table class="ships"><thead><tr>
      <th>ลูกค้า / ใบเสร็จในซอง</th><th>ตัดบิล</th><th>วันที่ส่ง</th><th>ส่งไปที่</th><th>ส่งทาง</th><th>เลขพัสดุ</th><th>สถานะ</th></tr></thead>
    <tbody>${rows.map((p) => `<tr class="click ${p.status}" data-id="${p.id}">
      <td class="cust"><b>${esc(p.customer)}</b> <span class="count">${p.receipts.length} ใบ</span>${receiptChips(p)}${p.note ? `<div class="mute">${esc(p.note)}</div>` : ''}</td>
      <td class="nowrap" data-l="ตัดบิล">${billRange(p)}</td>
      <td class="nowrap" data-l="วันที่ส่ง">${thDate(p.sent_date) || '<span class="mute">-</span>'}</td>
      <td class="addr" data-l="ส่งไปที่">${esc(p.destination).replace(/\n/g, '<br>') || '<span class="mute">-</span>'}</td>
      <td data-l="ส่งทาง">${esc(p.carrier) || '<span class="mute">-</span>'}</td>
      <td class="track nowrap" data-l="เลขพัสดุ">${trackHtml(p)}</td><td class="st">${tag(p.status)}</td></tr>`).join('')}</tbody></table>
    ${rows.length >= 300 ? '<p class="mute">แสดง 300 ซองล่าสุด — ใช้ตัวกรองหรือส่งออก Excel เพื่อดูทั้งหมด</p>' : ''}`;
  $$('#tbl tbody tr').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    editDialog(Number(tr.dataset.id));
  }));
}

const FIELD_TH = { customer: 'ลูกค้า', sent_date: 'วันที่ส่ง', destination: 'ส่งไปที่', carrier: 'ส่งทาง', tracking_no: 'เลขพัสดุ',
  status: 'สถานะ', note: 'หมายเหตุ', receipts: 'ใบเสร็จในซอง' };
function histHtml(edits) {
  const fmt = (k, v) => (k.endsWith('_date') ? thDate(v) : k === 'status' ? S.statuses[v] : k === 'receipts'
    ? v.replace(/(\d{4}-\d{2}-\d{2})/g, (d) => thDate(d)) : v) || '(ว่าง)';
  return edits.map((e) => `<div>${thTime(e.edited_at)} · ${esc(e.name)} แก้: ${Object.entries(JSON.parse(e.before))
    .map(([k, v]) => (k === 'via' ? `(${esc(v)})` : `${FIELD_TH[k] || k} เดิม "${esc(fmt(k, v))}"`)).join(', ')}</div>`).join('');
}

// ใบแนบซอง: รายการใบเสร็จที่อยู่ในซอง พิมพ์ใส่ไปกับซอง/เก็บเป็นหลักฐาน
function printSlip(p) {
  const el = document.createElement('div');
  el.id = 'slip';
  el.innerHTML = `<h3>${esc(S.orgName)}</h3><h2>รายการใบเสร็จในซอง</h2>
    <p><b>ถึง:</b> ${esc(p.customer)}<br>${esc(p.destination).replace(/\n/g, '<br>')}</p>
    <p>วันที่ส่ง: ${thDate(p.sent_date) || '-'} · ส่งทาง: ${esc(p.carrier) || '-'} · เลขพัสดุ: ${esc(p.tracking_no) || '-'}</p>
    <table><tr><th>#</th><th>เลขที่ใบเสร็จ</th><th>วันที่ตัดบิล</th></tr>
      ${p.receipts.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.receipt_no)}</td><td>${thDate(r.bill_date)}</td></tr>`).join('')}</table>
    <p>รวม ${p.receipts.length} ใบ</p>`;
  document.body.append(el);
  document.body.classList.add('printing-slip');
  const done = () => { el.remove(); document.body.classList.remove('printing-slip'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1000);
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
      <button type="button" class="btn ghost" id="slipBtn">พิมพ์ใบแนบซอง</button>
      <button type="button" class="btn ghost" data-close>ปิด</button><button class="btn" type="submit">บันทึกการแก้ไข</button></div></form>`, true);
  const form = $('form', d);
  form.elements.status.value = p.status;
  wireParcelForm(form, id);
  $('#slipBtn', d).onclick = () => printSlip(p);
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
          <tr><th></th><th>ลูกค้า</th><th>ใบเสร็จ</th><th>วันที่ส่ง</th><th>เลขพัสดุ</th></tr>
          ${r.preview.map((p) => `<tr><td>${p.action === 'create' ? '<span class="tag received">ซองใหม่</span>' : '<span class="tag sent">อัปเดต</span>'}</td>
            <td>${esc(p.customer)}</td><td>${p.receipts.length} ใบ <span class="mute">${esc(p.receipts.map((x) => x.receipt_no).join(', '))}</span></td>
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
    <div class="card"><div class="bar"><b class="grow">ผู้ใช้งาน</b><button class="btn" id="addUser">+ เพิ่มผู้ใช้</button></div>
      <div class="tablewrap" id="users"></div>
      <p class="mute">พนักงาน: บันทึกและแก้ไขรายการได้ · ผู้ดูแล: ทำได้ทุกอย่าง รวมถึงลบรายการและจัดการผู้ใช้</p></div>`;
  onSubmit($('#orgForm'), async (v) => { await api('/api/settings', { method: 'PUT', body: v }); S.orgName = v.orgName; toast('บันทึกแล้ว'); });
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
