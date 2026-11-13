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
const PAGES = { list: 'รายการส่งใบเสร็จ', new: '+ บันทึกใหม่', admin: 'ผู้ใช้และตั้งค่า' };
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

// ---------- form (ใช้ทั้งบันทึกใหม่และแก้ไข) ----------
let customers = null;
async function loadCustomers(force) {
  if (!customers || force) customers = await api('/api/customers').catch(() => []);
  return customers;
}

function shipmentFields(r = {}) {
  const statusOpts = Object.entries(S.statuses).map(([k, t]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${esc(t)}</option>`).join('');
  return `<div class="grid">
      <label><span>เลขที่ใบเสร็จ <b class="req">*</b></span><input name="receipt_no" required value="${esc(r.receipt_no)}" autocomplete="off"></label>
      <label><span>วันที่ตัดบิล <b class="req">*</b></span><input name="bill_date" type="date" required value="${esc(r.bill_date ?? today())}"></label>
      <label class="span2"><span>ชื่อลูกค้า <b class="req">*</b></span><input name="customer" required list="custList" value="${esc(r.customer)}" autocomplete="off"></label>
    </div>
    <div class="dup" hidden></div>
    <div class="grid">
      <label><span>วันที่ส่ง <span class="mute">(ว่าง = ยังไม่ส่ง)</span></span><input name="sent_date" type="date" value="${esc(r.sent_date)}"></label>
      <label>ส่งทาง<input name="carrier" list="carrierList" value="${esc(r.carrier)}" autocomplete="off"></label>
      <label>เลขพัสดุ<input name="tracking_no" value="${esc(r.tracking_no)}" autocomplete="off" placeholder="เช่น EF123456789TH"></label>
      <label>สถานะ<select name="status"><option value="">อัตโนมัติ (ตามวันที่ส่ง)</option>${statusOpts}</select></label>
    </div>
    <label>ส่งไปที่ (ชื่อผู้รับ / ที่อยู่)<textarea name="destination" rows="3">${esc(r.destination)}</textarea></label>
    <label>หมายเหตุ<input name="note" value="${esc(r.note)}"></label>
    <datalist id="carrierList">${S.carriers.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="custList"></datalist>`;
}

// ผูกพฤติกรรมช่วยกรอก: เติมที่อยู่จากลูกค้าเดิม, เตือนเลขซ้ำ, ใส่วันที่ส่งเมื่อกรอกเลขพัสดุ
async function wireShipmentForm(form, excludeId = 0) {
  const list = await loadCustomers();
  $('#custList', form).innerHTML = list.map((c) => `<option value="${esc(c.customer)}">`).join('');
  const f = form.elements;
  f.customer.addEventListener('change', () => {
    const c = list.find((x) => x.customer === f.customer.value.trim());
    if (c && !f.destination.value.trim()) f.destination.value = c.destination;
    if (c && !f.carrier.value.trim()) f.carrier.value = c.carrier;
  });
  f.tracking_no.addEventListener('change', () => {
    if (f.tracking_no.value.trim() && !f.sent_date.value) f.sent_date.value = today();
  });
  const dupBox = $('.dup', form);
  const checks = {};
  const check = async (field) => {
    const value = f[field].value.trim();
    checks[field] = value ? await api(`/api/check?field=${field}&value=${encodeURIComponent(value)}&exclude=${excludeId}`).catch(() => []) : [];
    const msgs = [];
    for (const [k, label] of [['receipt_no', 'เลขที่ใบเสร็จนี้'], ['tracking_no', 'เลขพัสดุนี้']])
      for (const r of checks[k] || [])
        msgs.push(`⚠️ ${label}เคยบันทึกแล้ว: ใบเสร็จ ${esc(r.receipt_no)} – ${esc(r.customer)} (ตัดบิล ${thDate(r.bill_date)}${r.sent_date ? `, ส่ง ${thDate(r.sent_date)}` : ''})`);
    dupBox.innerHTML = msgs.length ? `<div class="warn">${msgs.join('<br>')}</div>` : '';
    dupBox.hidden = !msgs.length;
  };
  f.receipt_no.addEventListener('change', () => check('receipt_no'));
  f.tracking_no.addEventListener('change', () => check('tracking_no'));
}

// ---------- new ----------
function newPage() {
  $('#main').innerHTML = `<h2>บันทึกการส่งใบเสร็จ</h2><div class="card"><form>${shipmentFields()}
    <label style="flex-direction:row;align-items:center;gap:6px;color:var(--text)"><input type="checkbox" name="keep" checked>
      บันทึกต่อเนื่อง: เก็บชื่อลูกค้า วันที่ และที่อยู่ไว้สำหรับใบถัดไป (ลูกค้าเดียวกันหลายใบ)</label>
    <div class="err"></div><div class="actions"><button class="btn" type="submit">บันทึก</button></div></form></div>
    <div id="recent"></div>`;
  const form = $('#main form');
  wireShipmentForm(form);
  form.elements.receipt_no.focus();
  const saved = [];
  onSubmit(form, async (v) => {
    await api('/api/shipments', { body: v });
    saved.unshift(v);
    toast(`บันทึกใบเสร็จ ${v.receipt_no} แล้ว`);
    loadCustomers(true);
    if (v.keep) { form.elements.receipt_no.value = ''; form.elements.tracking_no.value = ''; form.elements.note.value = ''; }
    else form.reset();
    $('.dup', form).hidden = true;
    form.elements.receipt_no.focus();
    $('#recent').innerHTML = `<div class="card"><b>บันทึกแล้วในรอบนี้ ${saved.length} รายการ</b>
      <div class="tablewrap"><table><tr><th>เลขที่ใบเสร็จ</th><th>ลูกค้า</th><th>ตัดบิล</th><th>วันที่ส่ง</th><th>เลขพัสดุ</th></tr>
      ${saved.map((s) => `<tr><td>${esc(s.receipt_no)}</td><td>${esc(s.customer)}</td><td>${thDate(s.bill_date)}</td><td>${thDate(s.sent_date) || '<span class="mute">ยังไม่ส่ง</span>'}</td><td class="track">${esc(s.tracking_no.toUpperCase())}</td></tr>`).join('')}
      </table></div></div>`;
  });
}

// ---------- list ----------
const F = { q: '', status: '', by: 'bill', from: '', to: '' };
function listPage() {
  $('#main').innerHTML = `<h2>รายการส่งใบเสร็จ</h2>
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
      <div class="selbar" id="selbar" hidden><b id="selCount"></b><button class="btn sm" id="markSent">บันทึกว่าส่งแล้ว…</button>
        <button class="btn ghost sm" id="selNone">ยกเลิกการเลือก</button></div>
      <div class="print-head"><b>${esc(S.orgName)}</b> — รายการส่งใบเสร็จ <span id="printNote"></span></div>
      <div class="tablewrap" id="tbl"><p class="mute">กำลังโหลด…</p></div>
    </div>`;
  $('#fby').value = F.by;
  let t;
  $('#fq').oninput = () => { clearTimeout(t); t = setTimeout(() => { F.q = $('#fq').value; load(); }, 250); };
  for (const [id, k] of [['#fby', 'by'], ['#ffrom', 'from'], ['#fto', 'to']]) $(id).onchange = () => { F[k] = $(id).value; load(); };
  $('#fclear').onclick = () => { Object.assign(F, { q: '', status: '', by: 'bill', from: '', to: '' }); listPage(); };
  $('#fprint').onclick = () => window.print();
  $('#fxlsx').onclick = () => (location.href = '/api/export.xlsx?' + new URLSearchParams(F));
  $('#selNone').onclick = () => { $$('.pick').forEach((c) => (c.checked = false)); selChanged(); };
  $('#markSent').onclick = markSentDialog;
  $('#fimport').onclick = importDialog;
  load();
}

let rows = [];
async function load() {
  let data;
  try { data = await api('/api/shipments?' + new URLSearchParams(F)); }
  catch (e) { $('#tbl').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  rows = data.rows;
  const total = Object.values(data.totals).reduce((a, b) => a + b, 0);
  const stat = (k, label, n) => `<button class="stat ${k} ${F.status === k ? 'on' : ''}" data-st="${k}">${label}<b>${n.toLocaleString()}</b></button>`;
  $('#stats').innerHTML = stat('', 'ทั้งหมด', F.status ? (data.totals[F.status] || 0) : total)
    + Object.entries(S.statuses).map(([k, l]) => stat(k, l, data.totals[k] || 0)).join('');
  $$('#stats .stat').forEach((b) => (b.onclick = () => { F.status = F.status === b.dataset.st ? '' : b.dataset.st; load(); }));
  const by = F.by === 'sent' ? 'วันที่ส่ง' : 'วันที่ตัดบิล';
  $('#printNote').textContent = [F.from || F.to ? `${by} ${thDate(F.from) || '…'} – ${thDate(F.to) || '…'}` : '',
    F.status ? `สถานะ: ${S.statuses[F.status]}` : '', F.q ? `ค้นหา: ${F.q}` : '', `(${rows.length} รายการ)`].filter(Boolean).join(' · ');
  if (!rows.length) { $('#tbl').innerHTML = '<p class="mute">ไม่พบรายการ</p>'; selChanged(); return; }
  $('#tbl').innerHTML = `<table class="ships"><thead><tr><th class="noprint"><input type="checkbox" id="pickAll" title="เลือกทั้งหมด"></th>
      <th>เลขที่ใบเสร็จ</th><th>วันที่ตัดบิล</th><th>ชื่อลูกค้า</th><th>วันที่ส่ง</th><th>ส่งไปที่</th><th>ส่งทาง</th><th>เลขพัสดุ</th><th>สถานะ</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="click ${r.status}" data-id="${r.id}">
      <td class="noprint pickcell"><input type="checkbox" class="pick" value="${r.id}" aria-label="เลือก ${esc(r.receipt_no)}"></td>
      <td class="nowrap rno"><b>${esc(r.receipt_no)}</b></td><td class="nowrap" data-l="ตัดบิล">${thDate(r.bill_date)}</td>
      <td class="cust">${esc(r.customer)}${r.note ? `<div class="mute">${esc(r.note)}</div>` : ''}</td>
      <td class="nowrap" data-l="วันที่ส่ง">${thDate(r.sent_date) || '<span class="mute">-</span>'}</td>
      <td class="addr" data-l="ส่งไปที่">${esc(r.destination).replace(/\n/g, '<br>') || '<span class="mute">-</span>'}</td><td data-l="ส่งทาง">${esc(r.carrier) || '<span class="mute">-</span>'}</td>
      <td class="track nowrap" data-l="เลขพัสดุ">${trackHtml(r)}</td><td class="st">${tag(r.status)}</td></tr>`).join('')}</tbody></table>
    ${rows.length >= 300 ? '<p class="mute">แสดง 300 รายการล่าสุด — ใช้ตัวกรองหรือส่งออก Excel เพื่อดูทั้งหมด</p>' : ''}`;
  $('#pickAll').onchange = (e) => { $$('.pick').forEach((c) => (c.checked = e.target.checked)); selChanged(); };
  $$('#tbl tbody tr').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('input, a, button')) return;
    editDialog(Number(tr.dataset.id));
  }));
  $$('.pick').forEach((c) => (c.onchange = selChanged));
  selChanged();
}
const picked = () => $$('.pick').filter((c) => c.checked).map((c) => Number(c.value));
function selChanged() {
  const n = picked().length;
  $('#selbar').hidden = !n;
  $('#selCount').textContent = `เลือก ${n} รายการ`;
}

function markSentDialog() {
  const ids = picked();
  const sel = rows.filter((r) => ids.includes(r.id));
  const d = dialog(`<h3>บันทึกว่าส่งแล้ว ${ids.length} รายการ</h3>
    <p class="mute">${sel.map((r) => `${esc(r.receipt_no)} – ${esc(r.customer)}`).join('<br>')}</p>
    <form><div class="grid">
      <label><span>วันที่ส่ง <b class="req">*</b></span><input name="sent_date" type="date" required value="${today()}"></label>
      <label>ส่งทาง<input name="carrier" list="carrierList2" autocomplete="off"></label>
      <label>เลขพัสดุ (ซองเดียวกัน)<input name="tracking_no" autocomplete="off"></label></div>
      <label>ส่งไปที่<textarea name="destination" rows="2" placeholder="เว้นว่าง = ใช้ที่อยู่เดิมของแต่ละรายการ"></textarea></label>
      <datalist id="carrierList2">${S.carriers.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <p class="mute">ช่องที่เว้นว่างจะคงค่าเดิมของแต่ละรายการ</p>
      <div class="err"></div><div class="actions"><button type="button" class="btn ghost" data-close>ยกเลิก</button><button class="btn" type="submit">บันทึก</button></div></form>`);
  onSubmit($('form', d), async (v) => {
    const r = await api('/api/shipments/mark-sent', { body: { ...v, ids } });
    d.close(); toast(`บันทึกแล้ว ${r.count} รายการ`); load();
  });
}

const FIELD_TH = { receipt_no: 'เลขที่ใบเสร็จ', bill_date: 'วันที่ตัดบิล', customer: 'ลูกค้า', sent_date: 'วันที่ส่ง', destination: 'ส่งไปที่',
  carrier: 'ส่งทาง', tracking_no: 'เลขพัสดุ', status: 'สถานะ', note: 'หมายเหตุ' };
async function editDialog(id) {
  let r;
  try { r = await api(`/api/shipments/${id}`); } catch (e) { return toast(e.message, true); }
  const fmt = (k, v) => (k.endsWith('_date') ? thDate(v) : k === 'status' ? S.statuses[v] : v) || '(ว่าง)';
  const hist = r.edits.map((e) => `<div>${thTime(e.edited_at)} · ${esc(e.name)} แก้: ${Object.entries(JSON.parse(e.before))
    .map(([k, v]) => (k === 'via' ? `(${esc(v)})` : `${FIELD_TH[k] || k} เดิม "${esc(fmt(k, v))}"`)).join(', ')}</div>`).join('');
  const d = dialog(`<h3>ใบเสร็จ ${esc(r.receipt_no)} ${tag(r.status)}</h3><form>${shipmentFields(r)}
    <p class="mute">บันทึกโดย ${esc(r.created_name)} ${thTime(r.created_at)}${r.updated_at ? ` · แก้ล่าสุด ${esc(r.updated_name)} ${thTime(r.updated_at)}` : ''}</p>
    ${hist ? `<div class="hist"><b>ประวัติการแก้ไข</b>${hist}</div>` : ''}
    <div class="err"></div><div class="actions">
      ${isAdmin() ? '<button type="button" class="btn danger left" id="del">ลบรายการ</button>' : ''}
      <button type="button" class="btn ghost" data-close>ปิด</button><button class="btn" type="submit">บันทึกการแก้ไข</button></div></form>`, true);
  const form = $('form', d);
  form.elements.status.value = r.status;
  wireShipmentForm(form, id);
  onSubmit(form, async (v) => {
    const res = await api(`/api/shipments/${id}`, { method: 'PUT', body: v });
    d.close(); toast(res.unchanged ? 'ไม่มีการเปลี่ยนแปลง' : 'บันทึกการแก้ไขแล้ว'); loadCustomers(true); load();
  });
  if (isAdmin()) $('#del', d).onclick = async () => {
    const reason = prompt(`ลบใบเสร็จ ${r.receipt_no} – ${r.customer}\nระบุเหตุผล (รายการจะถูกซ่อน ไม่ได้ลบจริง):`);
    if (reason === null) return;
    try { await api(`/api/shipments/${id}/delete`, { body: { reason } }); d.close(); toast('ลบรายการแล้ว'); load(); }
    catch (e) { toast(e.message, true); }
  };
}

// ---------- import ----------
function importDialog() {
  const d = dialog(`<h3>นำเข้าจาก Excel</h3>
    <p class="mute">ไฟล์ต้องมีแถวหัวคอลัมน์ เช่น เลขที่ใบเสร็จ, วันที่ตัดบิล, ชื่อลูกค้า, วันที่ส่ง, ส่งไปที่, ส่งทาง, เลขพัสดุ, หมายเหตุ
      (ลำดับคอลัมน์ไม่สำคัญ วันที่ใช้ วว/ดด/ปปปป ได้ทั้ง พ.ศ. และ ค.ศ.) · <a href="/api/import-template.xlsx">ดาวน์โหลดไฟล์แม่แบบ</a></p>
    <form>
      <label>ไฟล์ Excel (.xlsx, .xls, .csv)<input type="file" name="file" accept=".xlsx,.xls,.csv" required></label>
      <label>ถ้าเลขที่ใบเสร็จมีอยู่แล้วในระบบ<select name="mode">
        <option value="skip">ข้าม (เพิ่มเฉพาะใบเสร็จใหม่)</option>
        <option value="update">อัปเดตรายการเดิม ด้วยช่องที่กรอกในไฟล์ (เช่น เติมวันที่ส่ง/เลขพัสดุ)</option></select></label>
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
      const n = r.create + r.update;
      out.innerHTML = `<div class="card" style="margin:0">
        <b>ตรวจแล้ว (แผ่นงาน "${esc(r.sheet)}")</b>: เพิ่มใหม่ <b>${r.create}</b> · อัปเดต <b>${r.update}</b> · ข้าม ${r.skipped}
        ${r.errorCount ? ` · <span style="color:var(--bad)">มีปัญหา ${r.errorCount} แถว (จะไม่ถูกนำเข้า)</span>` : ''}
        ${r.errors.length ? `<div class="warn" style="margin-top:8px;max-height:140px;overflow:auto">${r.errors.map((e) =>
          `แถว ${e.line}${e.receipt_no ? ` (${esc(e.receipt_no)})` : ''}: ${esc(e.msg)}`).join('<br>')}</div>` : ''}
        ${r.preview.length ? `<div class="tablewrap" style="max-height:260px;overflow:auto;margin-top:8px"><table>
          <tr><th>แถว</th><th></th><th>เลขที่ใบเสร็จ</th><th>ตัดบิล</th><th>ลูกค้า</th><th>วันที่ส่ง</th><th>เลขพัสดุ</th></tr>
          ${r.preview.map((p) => `<tr><td>${p.line}</td><td>${p.action === 'create' ? '<span class="tag received">ใหม่</span>' : '<span class="tag sent">อัปเดต</span>'}</td>
            <td>${esc(p.receipt_no)}</td><td class="nowrap">${thDate(p.bill_date)}</td><td>${esc(p.customer)}</td>
            <td class="nowrap">${thDate(p.sent_date) || '-'}</td><td class="track">${esc(p.tracking_no)}</td></tr>`).join('')}
        </table></div>${n > r.preview.length ? `<p class="mute">แสดง ${r.preview.length} จาก ${n} รายการ</p>` : ''}` : ''}</div>`;
      go.textContent = n ? `ยืนยันนำเข้า ${n} รายการ` : 'นำเข้า';
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
    d.close(); toast(`นำเข้าแล้ว: เพิ่มใหม่ ${r.create} · อัปเดต ${r.update}`); loadCustomers(true); load();
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
