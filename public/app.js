// ระบบรับ-เบิกสต็อกหนังสือ : หน้าจอ
const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main'), dlg = $('#dlg');
const state = { user: null, books: [], view: 'stock' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('th-TH');
const fmtDate = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${Number(d.slice(0, 4)) + 543}` : '');
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const isLow = (b) => b.min_qty > 0 && b.stock < b.min_qty;
// ราคาปก — แสดงอย่างเดียว ไม่ใช้คำนวณยอดรับ-เบิก
const baht = (n) => { const v = Number(n || 0); return v.toLocaleString('th-TH', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }); };
const isAdmin = () => state.user?.role === 'admin';
const isSales = () => state.user?.role === 'sales'; // ฝ่ายขาย: ดูรายการหนังสือและยอดคงเหลือได้อย่างเดียว
const ROLE_LABEL = { admin: 'ผู้ดูแล', staff: 'เจ้าหน้าที่', sales: 'ฝ่ายขาย' };
const TYPES = {
  IN: { cls: 'in', sign: '▼', title: 'รับเข้าสินค้า', tag: 'รับ', desc: 'บันทึกรับสินค้าเข้าคลัง — ยอดสต็อกจะเพิ่มขึ้น', slip: 'ใบรับเข้า', save: 'บันทึกรับเข้าสินค้า', qty: 'จำนวนรับ' },
  OUT: { cls: 'out', sign: '▲', title: 'เบิกจ่ายสินค้า', tag: 'เบิก', desc: 'บันทึกเบิกจ่ายสินค้าออกจากคลัง — ยอดสต็อกจะลดลง', slip: 'ใบเบิกจ่าย', save: 'บันทึกใบเบิกจ่าย', print: true, qty: 'จำนวนเบิก' },
  DMG: { cls: 'dmg', sign: '✖', title: 'ตัดชำรุด/เสียหาย', tag: 'ชำรุด', desc: 'ตัดสินค้าชำรุด เสียหาย หรือสูญหายออกจากคลัง — ยอดสต็อกจะลดลง', slip: 'ใบตัดชำรุด', save: 'บันทึกใบตัดชำรุด', print: true, qty: 'จำนวนที่ตัด' },
};
const DMG_REASONS = ['ชำรุด', 'เสียหาย', 'สูญหาย', 'พิมพ์ผิด', 'อื่น ๆ'];
const typeTag = (t) => `<span class="tag ${TYPES[t].cls}">${TYPES[t].tag}</span>`;

async function api(url, method = 'GET', body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user) { state.user = null; boot(); }
  if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
  return data;
}
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 3500);
}
// ---------- รูปหนังสือ ----------
const imgUrl = (b) => `/api/books/${b.id}/image?v=${encodeURIComponent(b.img)}`;
// รูปเล็ก: คลิกเพื่อดูรูปใหญ่ (data-zoom) ถ้ายังไม่มีรูปแสดงกรอบว่าง
const thumb = (b, cls = '') => b.img
  ? `<img class="thumb ${cls}" src="${imgUrl(b)}" loading="lazy" alt="" data-zoom="${b.id}" title="คลิกเพื่อดูรูปใหญ่">`
  : `<span class="thumb none ${cls}" title="ยังไม่มีรูป">📖</span>`;
function showImage(bookId) {
  const b = state.books.find((x) => x.id == bookId);
  if (!b?.img) return;
  dlg.className = 'wide';
  dlg.innerHTML = `<h3>${esc(b.code)} ${esc(b.name)}</h3><div style="text-align:center"><img src="${imgUrl(b)}" alt="" style="max-width:100%;max-height:70vh"></div>
    <div class="actions"><button class="btn ghost" data-close>ปิด</button></div>`;
  $('[data-close]', dlg).onclick = () => dlg.close();
  dlg.showModal();
}
// ย่อรูปที่เบราว์เซอร์ (ด้านยาวสุด 600px, JPEG) ก่อนอัปโหลด — รูปจากมือถือหลาย MB จะเหลือราว 50-100KB
async function shrinkImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error(`เปิดไฟล์ ${file.name} ไม่ได้ (ใช้ JPG หรือ PNG)`); }
  const scale = Math.min(1, 600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); // PNG พื้นใส → พื้นขาว
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}
const pickFiles = (multiple) => new Promise((resolve) => {
  const inp = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', multiple });
  inp.onchange = () => resolve([...inp.files]);
  inp.click();
});
async function loadBooks() {
  state.books = await api('/api/books');
  // ป้ายแจ้งเตือนบนเมนู: จำนวนหนังสือที่ยอดต่ำกว่าขั้นต่ำ
  const tab = $('#nav [data-view="stock"]'), n = state.books.filter((b) => b.active && isLow(b)).length;
  if (tab) tab.innerHTML = 'สต็อกคงเหลือ' + (n ? ` <span class="badge">${n}</span>` : '');
  return state.books;
}

// กล่องฟอร์มแบบป๊อปอัป: fields = [{name, label, type, value, options, required}]
function formDialog(title, fields, onSubmit, opts = {}) {
  dlg.className = '';
  dlg.innerHTML = `<form><h3>${esc(title)}</h3>${fields.map((f) =>
    f.type === 'checkbox'
      ? `<label class="check"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`
      : f.type === 'select'
        ? `<label>${esc(f.label)}<select name="${f.name}">${f.options.map(([v, t]) => `<option value="${v}" ${v === f.value ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`
        : `<label>${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.required === false ? '' : 'required'} ${f.type === 'number' ? `min="0" step="${f.step ?? 1}"` : ''} autocomplete="${f.type === 'password' ? 'new-password' : 'off'}"></label>`).join('')}
    <div class="err"></div>
    <div class="actions"><button type="button" class="btn ghost" data-close>${opts.close ?? 'ยกเลิก'}</button><button class="btn ${opts.okClass ?? ''}">${opts.ok ?? 'บันทึก'}</button></div></form>`;
  $('[data-close]', dlg).onclick = () => dlg.close();
  $('form', dlg).onsubmit = async (e) => {
    e.preventDefault();
    const v = {};
    for (const f of fields) {
      const el = e.target.elements[f.name];
      v[f.name] = f.type === 'checkbox' ? el.checked : f.type === 'number' ? Number(el.value) : el.value;
    }
    try { await onSubmit(v); dlg.close(); } catch (err) { $('.err', dlg).textContent = err.message; }
  };
  dlg.showModal();
}

// ---------- เข้าสู่ระบบ ----------
async function boot() {
  const s = await api('/api/state');
  state.user = s.user; state.orgName = s.orgName; state.requireLogin = s.requireLogin;
  document.querySelector('.who').hidden = !s.requireLogin;
  $('#top').hidden = !s.user;
  if (s.needSetup) return viewAuth(true);
  if (!s.user) return viewAuth(false);
  $('#whoName').textContent = `${s.user.name} (${ROLE_LABEL[s.user.role] ?? s.user.role})`;
  const tabs = [['stock', 'สต็อกคงเหลือ'], ['in', '▼ รับเข้าสินค้า'], ['out', '▲ เบิกจ่ายสินค้า'], ['dmg', '✖ ตัดชำรุด/เสียหาย'], ['docs', 'ประวัติเอกสาร'], ['report', 'รายงาน']];
  if (isAdmin()) tabs.push(['books', 'จัดการหนังสือ'], ['users', state.requireLogin ? 'ผู้ใช้งาน' : 'ตั้งค่า']);
  if (isSales()) tabs.splice(1); // ฝ่ายขายเห็นแค่เมนูสต็อกคงเหลือ
  $('#nav').innerHTML = tabs.map(([k, t]) => `<button data-view="${k}" class="nav-${k}">${t}</button>`).join('');
  $('#nav').onclick = (e) => { const b = e.target.closest('[data-view]'); if (b) go(b.dataset.view); };
  await loadBooks();
  go(state.view);
}

function viewAuth(setup) {
  main.innerHTML = `<div class="card login"><h2>${setup ? 'ตั้งค่าครั้งแรก: สร้างบัญชีผู้ดูแลระบบ' : 'เข้าสู่ระบบสต็อกหนังสือ'}</h2>
    <form><label>ชื่อผู้ใช้<input name="username" required autofocus autocomplete="username"></label>
    ${setup ? '<label>ชื่อ-สกุล<input name="name" required></label>' : ''}
    <label>รหัสผ่าน${setup ? ' (อย่างน้อย 6 ตัวอักษร)' : ''}<input name="password" type="password" required autocomplete="${setup ? 'new-password' : 'current-password'}"></label>
    <div class="err"></div><button class="btn">${setup ? 'สร้างบัญชีและเริ่มใช้งาน' : 'เข้าสู่ระบบ'}</button></form></div>`;
  $('form', main).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await api(setup ? '/api/setup' : '/api/login', 'POST', { username: f.username.value, name: f.name?.value, password: f.password.value });
      boot();
    } catch (err) { $('.err', main).textContent = err.message; }
  };
}
$('#btnLogout').onclick = async () => { await api('/api/logout', 'POST'); state.user = null; boot(); };
$('#btnPassword').onclick = () => formDialog('เปลี่ยนรหัสผ่าน', [
  { name: 'current', label: 'รหัสผ่านเดิม', type: 'password' },
  { name: 'password', label: 'รหัสผ่านใหม่ (อย่างน้อย 6 ตัวอักษร)', type: 'password' }],
  async (v) => { await api('/api/password', 'POST', v); toast('เปลี่ยนรหัสผ่านแล้ว'); });

const views = {};
function go(view) {
  state.view = views[view] && $(`#nav [data-view="${view}"]`) ? view : 'stock';
  for (const b of $('#nav').children) b.classList.toggle('on', b.dataset.view === state.view);
  views[state.view]().catch((e) => toast(e.message, true));
}

// ---------- สต็อกคงเหลือ ----------
views.stock = async () => {
  await loadBooks();
  const books = state.books.filter((b) => b.active);
  const low = books.filter(isLow).length;
  main.innerHTML = `<h2>สต็อกคงเหลือ</h2>
    <div class="stats"><div class="stat">จำนวนรายการ<b>${num(books.length)}</b></div>
      <div class="stat">ยอดรวมทั้งหมด<b>${num(books.reduce((s, b) => s + b.stock, 0))}</b></div>
      ${isSales() ? '' : `<div class="stat ${low ? 'warn' : ''}">ต่ำกว่าขั้นต่ำ<b>${num(low)}</b></div>`}</div>
    ${low ? `<div class="card alert">⚠ มีหนังสือ <b>${num(low)}</b> รายการ ที่ยอดคงเหลือต่ำกว่าขั้นต่ำ <button class="btn sm" id="showLow">ดูรายการ</button> <a class="btn" style="padding:4px 9px;font-size:.85em" href="/low-stock.html" target="_blank">🖨 พิมพ์ / PDF</a>${isAdmin() ? ' <a class="btn" style="padding:4px 9px;font-size:.85em" href="/api/export/stock.xlsx?low=1">ส่งออก Excel</a>' : ''}</div>` : ''}
    <div class="card"><div class="bar">
      <label class="grow">ค้นหา<input id="q" placeholder="รหัสหรือชื่อหนังสือ" autofocus></label>
      <label class="check" ${isSales() ? 'hidden' : ''}><input type="checkbox" id="onlyLow"> เฉพาะที่ต่ำกว่าขั้นต่ำ</label>
      ${isSales() ? '' : '<a class="btn" href="/low-stock.html" target="_blank">🖨 พิมพ์รายการต่ำกว่าขั้นต่ำ</a>'}
      ${isAdmin() ? '<a class="btn" href="/api/export/stock.xlsx">ส่งออก Excel</a>' : ''}</div>
    <div class="tablewrap"><table><thead><tr><th>รูป</th><th>รหัส</th><th>ชื่อหนังสือ</th><th class="num">คงเหลือ</th><th>หน่วย</th>${isSales() ? '' : '<th class="num">ขั้นต่ำ</th>'}<th class="num">ราคาปก (บาท)</th></tr></thead><tbody id="rows"></tbody></table></div>
    <p class="mute" ${isSales() ? 'hidden' : ''}>คลิกที่รายการเพื่อดูบัตรสต็อก (ประวัติรับ-เบิกของหนังสือเล่มนั้น)</p></div>`;
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase(), onlyLow = $('#onlyLow').checked;
    $('#rows').innerHTML = books
      .filter((b) => (!q || (b.code + ' ' + b.name).toLowerCase().includes(q)) && (!onlyLow || isLow(b)))
      .map((b) => `<tr class="${isSales() ? '' : 'click'} ${b.stock <= 0 ? 'zero' : isLow(b) ? 'low' : ''}" data-id="${b.id}">
        <td>${thumb(b)}</td><td>${esc(b.code)}</td><td>${esc(b.name)}</td><td class="num"><b>${num(b.stock)}</b></td><td>${esc(b.unit)}</td>${isSales() ? '' : `<td class="num">${num(b.min_qty)}</td>`}
        <td class="num">${baht(b.price)}</td></tr>`).join('')
      || `<tr><td colspan="${isSales() ? 6 : 7}" class="mute">ไม่พบรายการ</td></tr>`;
  };
  $('#q').oninput = $('#onlyLow').onchange = draw;
  $('#rows').onclick = (e) => {
    if (e.target.dataset.zoom) return showImage(e.target.dataset.zoom);
    const tr = e.target.closest('tr[data-id]'); if (tr && !isSales()) showCard(tr.dataset.id);
  };
  if (low) $('#showLow').onclick = () => { $('#onlyLow').checked = true; draw(); $('#rows').scrollIntoView({ behavior: 'smooth' }); };
  draw();
};

async function showCard(bookId) {
  const { book, rows } = await api(`/api/books/${bookId}/card`);
  dlg.className = 'wide';
  dlg.innerHTML = `<h3>บัตรสต็อก: ${esc(book.code)} ${esc(book.name)}</h3><div class="tablewrap" style="max-height:60vh">
    <table><thead><tr><th>วันที่</th><th>เลขที่เอกสาร</th><th>ผู้เบิก / ใบรับงาน / ผู้รายงาน</th><th class="num">รับ</th><th class="num">เบิก</th><th class="num">ชำรุด</th><th class="num">คงเหลือ</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${fmtDate(r.date)}</td><td>${esc(r.doc_no)}</td><td>${esc(r.party)} <span class="mute">${esc(r.dept)} ${r.po_no ? 'ใบสั่งซื้อ ' + esc(r.po_no) : ''} ${r.reason ? 'สาเหตุ: ' + esc(r.reason) : ''}</span></td>
      <td class="num">${r.type === 'IN' ? num(r.qty) : ''}</td><td class="num">${r.type === 'OUT' ? num(r.qty) : ''}</td><td class="num">${r.type === 'DMG' ? num(r.qty) : ''}</td><td class="num"><b>${num(r.balance)}</b></td></tr>`).join('')
      || '<tr><td colspan="7" class="mute">ยังไม่มีความเคลื่อนไหว</td></tr>'}
    </tbody></table></div><div class="actions"><button class="btn ghost" data-close>ปิด</button></div>`;
  $('[data-close]', dlg).onclick = () => dlg.close();
  dlg.showModal();
}

// ---------- บันทึกรับเข้า / เบิกออก ----------
// editing = เอกสารเดิม (จาก /api/docs/:id) เมื่อผู้ดูแลกดแก้ไข
function docForm(type, saved, editing) {
  const T = TYPES[type], isOut = type !== 'IN', items = [], E = editing;
  // ตอนแก้ไขใบเบิก/ใบตัดชำรุด จำนวนเดิมในใบนี้ถือเป็นของที่เบิกได้ด้วย
  const orig = new Map((E?.items ?? []).map((it) => [it.book_id, it.qty]));
  const avail = (b) => (isOut && orig.has(b.id) ? { ...b, stock: b.stock + orig.get(b.id) } : b);
  const showPrice = true; // ทุกหน้าบันทึก (รับเข้า/เบิกจ่าย/ตัดชำรุด) แสดงราคาปกให้ดูอย่างเดียว ไม่นำไปคำนวณยอดรวม // isOut = ยอดลดลง (เบิกจ่าย / ตัดชำรุด); items: {book, qty}
  // ชื่อผู้รับ / ผู้เบิก / ผู้รายงาน = ผู้ที่ login อยู่ (แก้ไม่ได้ เซิร์ฟเวอร์ใช้ชื่อจากบัญชีเสมอ)
  // ตอนแก้ไข ชื่อคงเดิมตามเอกสาร
  const who = E ? (type === 'IN' ? E.created_by_name : E.party) : state.user.name;
  const me = (label) => `<label>${label}<input class="locked" value="${esc(who)}" readonly tabindex="-1"></label>`;
  const fields = {
    IN: me('ผู้รับเข้า') + '<label>รับจากใบรับงานเลขที่<input id="party"></label>',
    OUT: me('ผู้เบิก') + '<label>ใบสั่งซื้อเลขที่<input id="po_no"></label><label>ชื่อหน่วยงาน<input id="dept"></label>',
    DMG: `<label>สาเหตุ *<select id="reason"><option value="">— เลือกสาเหตุ —</option>${DMG_REASONS.map((r) => `<option>${r}</option>`).join('')}</select></label>` + me('ผู้รายงาน'),
  }[type];
  main.innerHTML = `<div class="doc-head ${T.cls}"><span class="sign">${T.sign}</span>
      <div><h2>${E ? `แก้ไข${T.slip} ${esc(E.doc_no)}` : T.title}</h2><p>${E ? 'ผู้ดูแลแก้ไขเอกสาร — ยอดสต็อกจะปรับตามจำนวนใหม่ทันทีที่บันทึก' : T.desc}</p></div></div>
    ${saved ? `<div class="card saved">✔ บันทึกเอกสาร <b>${esc(saved.doc_no)}</b> แล้ว <a class="btn" href="/slip.html?id=${saved.id}" target="_blank">ดู/พิมพ์${T.slip}</a></div>` : ''}<div class="card doc-card ${T.cls}">
    <div class="grid">
      <label>วันที่<input type="date" id="date" value="${today()}"></label>
      ${fields}
      <label>หมายเหตุ${type === 'DMG' ? ' (รายละเอียดความเสียหาย)' : ''}<input id="note"></label>
      ${E ? '<label>เหตุผลที่แก้ไข *<input id="edit_reason" placeholder="เช่น ใส่จำนวนผิด, เลือกหนังสือผิดเล่ม"></label>' : ''}
    </div>
    <div class="picker"><label>เพิ่มหนังสือ (พิมพ์รหัสหรือชื่อ แล้วกด Enter หรือคลิกเลือก)<input id="pick" autocomplete="off" placeholder="ค้นหาหนังสือ..."></label><div class="sugg" id="sugg" hidden></div></div>
    <div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>#</th><th>รหัส</th><th>ชื่อหนังสือ</th><th class="num">คงเหลือ</th>${showPrice ? '<th class="num">ราคาปก (บาท)</th>' : ''}<th class="num">${T.qty}</th><th></th></tr></thead><tbody id="items"></tbody>
      <tfoot><tr><th colspan="${showPrice ? 5 : 4}" class="num">รวมจำนวน</th><th class="num" id="total">0</th><th></th></tr></tfoot></table></div>
    <div class="err" id="err"></div>
    <div class="actions">${E ? `<button class="btn big ghost" id="back">ยกเลิกการแก้ไข</button>
      <button class="btn big ${T.cls}" id="save">บันทึกการแก้ไข</button>` : `
      ${T.print ? `<span class="mute" id="printHint">${saved ? `พิมพ์ใบ ${esc(saved.doc_no)} ที่เพิ่งบันทึก` : 'บันทึกก่อน จึงจะพิมพ์ได้'}</span>
        <button class="btn big ghost" id="print" ${saved ? '' : 'disabled'}>🖨 พิมพ์${T.slip}</button>` : ''}
      <button class="btn big ${T.cls}" id="save">${T.save}</button>`}</div></div>`;
  const pick = $('#pick'), sugg = $('#sugg');
  let matches = [];
  const total = () => ($('#total').textContent = num(items.reduce((s, it) => s + (Number(it.qty) || 0), 0)));
  const draw = () => {
    $('#items').innerHTML = items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.book.code)}</td><td><div class="withimg">${thumb(it.book)}<span>${esc(it.book.name)}</span></div></td>
      <td class="num">${num(it.book.stock)}</td>${showPrice ? `<td class="num">${baht(it.book.price)}</td>` : ''}
      <td class="num"><input type="number" min="1" ${isOut ? `max="${it.book.stock}"` : ''} value="${it.qty}" data-i="${i}" style="width:100px;text-align:right"></td>
      <td><button class="btn danger sm" data-del="${i}">ลบ</button></td></tr>`).join('')
      || `<tr><td colspan="${showPrice ? 7 : 6}" class="mute">ยังไม่มีรายการ</td></tr>`;
    total();
  };
  const add = (book) => {
    book = avail(book);
    if (items.some((it) => it.book.id === book.id)) toast('มีหนังสือเล่มนี้ในรายการแล้ว', true);
    else if (isOut && book.stock <= 0) toast('หนังสือเล่มนี้ไม่มีของคงเหลือ', true);
    else { items.push({ book, qty: 1 }); draw(); const inputs = main.querySelectorAll('#items input'); inputs[inputs.length - 1].select(); }
    pick.value = ''; sugg.hidden = true;
  };
  pick.oninput = () => {
    const q = pick.value.trim().toLowerCase();
    matches = q ? state.books.filter((b) => b.active && (b.code + ' ' + b.name).toLowerCase().includes(q)).slice(0, 12) : [];
    sugg.innerHTML = matches.map((b, i) => `<div data-i="${i}" class="${i ? '' : 'on'}"><span class="withimg">${thumb(b, 'sm')}<span>${esc(b.code)} — ${esc(b.name)}</span></span><span class="mute">คงเหลือ ${num(b.stock)}${showPrice ? ` · ราคาปก ${baht(b.price)} บาท` : ''}</span></div>`).join('');
    sugg.hidden = !matches.length;
  };
  pick.onkeydown = (e) => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); add(matches[0]); } };
  sugg.onclick = (e) => { const d = e.target.closest('[data-i]'); if (d) add(matches[d.dataset.i]); };
  $('#items').oninput = (e) => { if (e.target.dataset.i) { items[e.target.dataset.i].qty = Number(e.target.value); total(); } };
  $('#items').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); pick.focus(); } };
  $('#items').onclick = (e) => {
    if (e.target.dataset.zoom) showImage(e.target.dataset.zoom);
    if (e.target.dataset.del) { items.splice(e.target.dataset.del, 1); draw(); }
  };
  $('#save').onclick = async () => {
    const btn = $('#save');
    $('#err').textContent = '';
    btn.disabled = true;
    try {
      const body = {
        type, date: $('#date').value, party: $('#party')?.value ?? '', po_no: $('#po_no')?.value ?? '', dept: $('#dept')?.value ?? '', reason: $('#reason')?.value ?? '', note: $('#note').value,
        items: items.map((it) => ({ book_id: it.book.id, qty: it.qty })) };
      if (E) {
        await api(`/api/docs/${E.id}`, 'PUT', { ...body, edit_reason: $('#edit_reason').value });
        toast(`แก้ไขเอกสาร ${E.doc_no} แล้ว`);
        return go('docs');
      }
      const doc = await api('/api/docs', 'POST', body);
      toast(`บันทึกเอกสาร ${doc.doc_no} แล้ว`);
      await loadBooks();
      docForm(type, doc);
    } catch (err) { $('#err').textContent = err.message; btn.disabled = false; }
  };
  if (T.print && saved) $('#print').onclick = () => window.open(`/slip.html?id=${saved.id}&print=1`);
  if (E) {
    $('#back').onclick = () => go('docs');
    $('#date').value = E.date;
    for (const k of ['party', 'po_no', 'dept', 'reason', 'note']) if ($('#' + k)) $('#' + k).value = E[k] ?? '';
    for (const it of E.items) { const b = state.books.find((x) => x.id === it.book_id); if (b) items.push({ book: avail(b), qty: it.qty }); }
  }
  draw();
  (E ? $('#edit_reason') : ({ IN: $('#party'), OUT: $('#po_no'), DMG: $('#reason') })[type]).focus();
}
views.in = async () => { await loadBooks(); docForm('IN'); };
views.out = async () => { await loadBooks(); docForm('OUT'); };
views.dmg = async () => { await loadBooks(); docForm('DMG'); };

// ---------- ประวัติเอกสาร ----------
views.docs = async () => {
  main.innerHTML = `<h2>ประวัติเอกสารรับ-เบิก</h2><div class="card"><div class="bar">
    <label>ประเภท<select id="type"><option value="">ทั้งหมด</option><option value="IN">รับเข้าสินค้า</option><option value="OUT">เบิกจ่ายสินค้า</option><option value="DMG">ตัดชำรุด/เสียหาย</option></select></label>
    <label>ตั้งแต่<input type="date" id="from"></label><label>ถึง<input type="date" id="to"></label>
    <label class="grow">ค้นหา<input id="q" placeholder="เลขที่เอกสาร / ผู้เบิก / ใบรับงาน / ใบสั่งซื้อ / หน่วยงาน / สาเหตุ"></label>
    <button class="btn" id="find">ค้นหา</button></div>
    <div class="tablewrap"><table><thead><tr><th>วันที่</th><th>เลขที่</th><th>ประเภท</th><th>ผู้เบิก / ใบรับงาน / ผู้รายงาน</th><th>ใบสั่งซื้อเลขที่</th><th>หน่วยงาน / สาเหตุ</th><th class="num">รายการ</th><th class="num">จำนวนรวม</th><th>ผู้บันทึก</th><th></th></tr></thead><tbody id="rows"></tbody></table></div></div>`;
  const load = async () => {
    const p = new URLSearchParams({ type: $('#type').value, from: $('#from').value, to: $('#to').value, q: $('#q').value });
    const docs = await api('/api/docs?' + p);
    $('#rows').innerHTML = docs.map((d) => `<tr class="${d.cancelled ? 'void' : ''}"><td>${fmtDate(d.date)}</td><td>${esc(d.doc_no)}</td>
      <td>${d.cancelled ? `<span class="tag bad">ยกเลิก</span>${d.cancel_reason ? `<br><span class="void-reason">เหตุผล: ${esc(d.cancel_reason)}</span>` : ''}` : typeTag(d.type)}
        ${d.edit_count ? `<span class="tag off" title="แก้ไขแล้ว ${d.edit_count} ครั้ง ดูรายละเอียดท้ายใบเอกสาร">แก้ไขแล้ว</span>` : ''}</td><td>${esc(d.party)}</td><td>${esc(d.po_no)}</td><td>${esc(d.dept || d.reason)}</td>
      <td class="num">${num(d.item_count)}</td><td class="num">${num(d.total_qty)}</td><td>${esc(d.created_by)}</td>
      <td style="white-space:nowrap"><a class="btn" style="padding:4px 9px;font-size:.85em" href="/slip.html?id=${d.id}" target="_blank">ดู/พิมพ์</a>
      ${isAdmin() && !d.cancelled ? `<button class="btn ghost sm" data-edit="${d.id}">แก้ไข</button>
        <button class="btn danger sm" data-cancel="${d.id}" data-no="${esc(d.doc_no)}">ยกเลิก</button>` : ''}</td></tr>`).join('')
      || '<tr><td colspan="10" class="mute">ไม่พบเอกสาร</td></tr>';
  };
  $('#find').onclick = () => load().catch((e) => toast(e.message, true));
  $('#q').onkeydown = (e) => e.key === 'Enter' && $('#find').click();
  $('#rows').onclick = async (e) => {
    const { edit: editId, cancel: id, no } = e.target.dataset;
    if (editId) {
      try {
        const [{ doc }] = await Promise.all([api(`/api/docs/${editId}`), loadBooks()]);
        docForm(doc.type, null, doc); window.scrollTo(0, 0);
      } catch (err) { toast(err.message, true); }
      return;
    }
    if (!id) return;
    formDialog(`ยกเลิกเอกสาร ${no}`, [
      { name: 'reason', label: 'เหตุผลที่ยกเลิก * (เช่น บันทึกผิด, บันทึกซ้ำ, ลูกค้ายกเลิกคำสั่งซื้อ) — ยอดสต็อกจะถูกปรับกลับ และกู้คืนเอกสารไม่ได้' }],
      async (v) => { await api(`/api/docs/${id}/cancel`, 'POST', v); toast(`ยกเลิกเอกสาร ${no} แล้ว`); await load(); },
      { ok: 'ยืนยันยกเลิกเอกสาร', okClass: 'danger', close: 'ปิด' });
  };
  await load();
};

// ---------- รายงาน ----------
views.report = async () => {
  const t = today();
  main.innerHTML = `<h2>รายงานสรุปรับ-เบิก</h2><div class="card"><div class="bar">
    <label>ตั้งแต่<input type="date" id="from" value="${t.slice(0, 8)}01"></label><label>ถึง<input type="date" id="to" value="${t}"></label>
    <label class="check"><input type="checkbox" id="moved" checked> เฉพาะที่มีความเคลื่อนไหว</label>
    <button class="btn" id="run">แสดงรายงาน</button>
    ${isAdmin() ? '<a class="btn" id="xSummary">Excel: สรุป</a><a class="btn" id="xMoves">Excel: รายการทั้งหมด</a>' : ''}
    <button class="btn ghost" onclick="window.print()">พิมพ์</button></div>
    <div class="tablewrap"><table><thead><tr><th>รหัส</th><th>ชื่อหนังสือ</th><th class="num">ราคาปก (บาท)</th><th class="num">ยกมา</th><th class="num">รับ</th><th class="num">เบิก</th><th class="num">ชำรุด/เสียหาย</th><th class="num">คงเหลือ</th></tr></thead><tbody id="rows"></tbody><tfoot id="foot"></tfoot></table></div></div>`;
  let data = [];
  const draw = () => {
    const rows = data.filter((r) => !$('#moved').checked || r.qty_in || r.qty_out || r.qty_dmg);
    const sum = (k) => num(rows.reduce((s, r) => s + r[k], 0));
    $('#rows').innerHTML = rows.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="num">${baht(r.price)}</td><td class="num">${num(r.opening)}</td>
      <td class="num">${num(r.qty_in)}</td><td class="num">${num(r.qty_out)}</td><td class="num">${num(r.qty_dmg)}</td><td class="num"><b>${num(r.closing)}</b></td></tr>`).join('')
      || '<tr><td colspan="8" class="mute">ไม่มีรายการในช่วงวันที่นี้</td></tr>';
    $('#foot').innerHTML = `<tr><th colspan="2" class="num">รวม</th><th></th><th class="num">${sum('opening')}</th><th class="num">${sum('qty_in')}</th><th class="num">${sum('qty_out')}</th><th class="num">${sum('qty_dmg')}</th><th class="num">${sum('closing')}</th></tr>`;
  };
  const load = async () => {
    const p = new URLSearchParams({ from: $('#from').value, to: $('#to').value });
    if (isAdmin()) {
      $('#xSummary').href = '/api/export/summary.xlsx?' + p;
      $('#xMoves').href = '/api/export/movements.xlsx?' + p;
    }
    data = await api('/api/report/summary?' + p);
    draw();
  };
  $('#run').onclick = () => load().catch((e) => toast(e.message, true));
  $('#moved').onchange = draw;
  await load();
};

// ---------- จัดการหนังสือ (ผู้ดูแล) ----------
views.books = async () => {
  await loadBooks();
  main.innerHTML = `<h2>จัดการรายชื่อหนังสือ</h2><div class="card"><div class="bar">
    <label class="grow">ค้นหา<input id="q" placeholder="รหัสหรือชื่อหนังสือ"></label><button class="btn ghost" id="bulkImg">📷 นำเข้ารูปหลายไฟล์</button><button class="btn" id="add">+ เพิ่มหนังสือ</button></div>
    <p class="mute">นำเข้ารูปหลายไฟล์: ตั้งชื่อไฟล์รูปเป็นรหัสหนังสือ เช่น ทข02001.jpg แล้วเลือกทุกไฟล์พร้อมกัน ระบบจะจับคู่กับหนังสือให้เอง</p>
    <p class="mute">แก้ยอดขั้นต่ำของแต่ละเล่มได้ในช่อง "ขั้นต่ำ" โดยตรง ระบบจะเตือนเมื่อคงเหลือต่ำกว่าจำนวนนี้ (0 = ไม่เตือน)</p>
    <div class="tablewrap"><table><thead><tr><th>รูป</th><th>รหัส</th><th>ชื่อหนังสือ</th><th>หน่วย</th><th class="num">ขั้นต่ำ</th><th class="num">ราคาปก (บาท)</th><th>สถานะ</th><th></th></tr></thead><tbody id="rows"></tbody></table></div></div>`;
  const edit = (b) => formDialog(b ? 'แก้ไขหนังสือ' : 'เพิ่มหนังสือ', [
    { name: 'code', label: 'รหัส', value: b?.code }, { name: 'name', label: 'ชื่อหนังสือ', value: b?.name },
    { name: 'unit', label: 'หน่วยนับ', value: b?.unit ?? 'เล่ม' },
    { name: 'min_qty', label: 'ยอดขั้นต่ำ (เตือนเมื่อคงเหลือต่ำกว่าจำนวนนี้, 0 = ไม่เตือน)', type: 'number', value: b?.min_qty ?? 500 },
    { name: 'price', label: 'ราคาปก (บาท)', type: 'number', step: '0.01', value: b?.price ?? 0 },
    { name: 'active', label: 'ใช้งานอยู่', type: 'checkbox', value: b ? b.active : 1 }],
    async (v) => { await api(b ? `/api/books/${b.id}` : '/api/books', b ? 'PUT' : 'POST', v); toast('บันทึกแล้ว'); views.books(); });
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    $('#rows').innerHTML = state.books.filter((b) => !q || (b.code + ' ' + b.name).toLowerCase().includes(q))
      .map((b) => `<tr><td><div class="withimg">${thumb(b)}<span><button class="link" data-img="${b.id}">${b.img ? 'เปลี่ยนรูป' : 'ใส่รูป'}</button>${b.img ? `<br><button class="link mute" data-delimg="${b.id}">ลบรูป</button>` : ''}</span></div></td>
        <td>${esc(b.code)}</td><td>${esc(b.name)}</td><td>${esc(b.unit)}</td><td class="num"><input type="number" min="0" step="1" value="${b.min_qty}" data-min="${b.id}" style="width:110px;text-align:right"></td>
        <td class="num">${baht(b.price)}</td>
        <td>${b.active ? '<span class="tag in">ใช้งาน</span>' : '<span class="tag off">ปิด</span>'}</td>
        <td><button class="btn ghost sm" data-id="${b.id}">แก้ไข</button></td></tr>`).join('');
  };
  // แก้ยอดขั้นต่ำในตารางได้เลย: พิมพ์ตัวเลขแล้วกด Enter หรือคลิกออกจากช่อง
  $('#rows').onchange = async (e) => {
    const b = state.books.find((x) => x.id == e.target.dataset.min);
    if (!b) return;
    const v = Number(e.target.value);
    try {
      if (e.target.value === '' || !Number.isInteger(v) || v < 0) throw new Error('ยอดขั้นต่ำต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป');
      await api(`/api/books/${b.id}`, 'PUT', { ...b, min_qty: v });
      b.min_qty = v;
      toast(`ตั้งยอดขั้นต่ำ ${b.code} = ${num(v)} แล้ว`);
      loadBooks();
    } catch (err) { e.target.value = b.min_qty; toast(err.message, true); }
  };
  $('#rows').onkeydown = (e) => { if (e.key === 'Enter' && e.target.dataset.min) e.target.blur(); };
  $('#q').oninput = draw;
  $('#add').onclick = () => edit(null);
  const book = (id) => state.books.find((b) => b.id == id);
  const refresh = async () => { await loadBooks(); draw(); };
  $('#rows').onclick = async (e) => {
    const d = e.target.dataset;
    try {
      if (d.id) edit(book(d.id));
      else if (d.zoom) showImage(d.zoom);
      else if (d.img) {
        const [file] = await pickFiles(false);
        if (!file) return;
        await api(`/api/books/${d.img}/image`, 'PUT', { image: await shrinkImage(file) });
        toast(`บันทึกรูป ${book(d.img).code} แล้ว`); await refresh();
      } else if (d.delimg) {
        const b = book(d.delimg);
        if (!confirm(`ลบรูปของ ${b.code} ${b.name} ?`)) return;
        await api(`/api/books/${b.id}/image`, 'DELETE');
        toast(`ลบรูป ${b.code} แล้ว`); await refresh();
      }
    } catch (err) { toast(err.message, true); }
  };
  // นำเข้าหลายรูป: ชื่อไฟล์ (ไม่รวมนามสกุล) = รหัสหนังสือ
  $('#bulkImg').onclick = async () => {
    const files = await pickFiles(true);
    if (!files.length) return;
    const byCode = new Map(state.books.map((b) => [b.code.trim().toLowerCase(), b]));
    const done = [], skipped = [], failed = [];
    for (const [i, f] of files.entries()) {
      const b = byCode.get(f.name.replace(/\.[^.]+$/, '').trim().toLowerCase());
      if (!b) { skipped.push(f.name); continue; }
      toast(`กำลังนำเข้ารูป ${i + 1} / ${files.length} ...`);
      try { await api(`/api/books/${b.id}/image`, 'PUT', { image: await shrinkImage(f) }); done.push(b.code); }
      catch (err) { failed.push(`${f.name}: ${err.message}`); }
    }
    await refresh();
    dlg.className = '';
    dlg.innerHTML = `<h3>นำเข้ารูปเสร็จแล้ว</h3>
      <p>✔ นำเข้าสำเร็จ <b>${num(done.length)}</b> รูป</p>
      ${skipped.length ? `<p>ไม่พบรหัสหนังสือตามชื่อไฟล์ <b>${num(skipped.length)}</b> ไฟล์ (ข้ามไป):</p><p class="mute">${skipped.map(esc).join(', ')}</p>` : ''}
      ${failed.length ? `<p class="err">นำเข้าไม่สำเร็จ ${num(failed.length)} ไฟล์:<br>${failed.map(esc).join('<br>')}</p>` : ''}
      <div class="actions"><button class="btn" data-close>ตกลง</button></div>`;
    $('[data-close]', dlg).onclick = () => dlg.close();
    dlg.showModal();
  };
  draw();
};

// ---------- ผู้ใช้งาน (ผู้ดูแล) ----------
views.users = async () => {
  const users = await api('/api/users');
  const roles = [['staff', 'เจ้าหน้าที่ (บันทึกรับ-เบิก ดูรายงาน)'], ['sales', 'ฝ่ายขาย (ดูรายการหนังสือและยอดคงเหลือเท่านั้น)'], ['admin', 'ผู้ดูแล (จัดการหนังสือ ผู้ใช้ ยกเลิกเอกสาร)']];
  main.innerHTML = `<h2>${state.requireLogin ? 'ผู้ใช้งาน' : 'ตั้งค่า'}</h2><div class="card" ${state.requireLogin ? '' : 'hidden'}><div class="bar"><button class="btn" id="add">+ เพิ่มผู้ใช้</button></div>
    <div class="tablewrap"><table><thead><tr><th>ชื่อผู้ใช้</th><th>ชื่อ-สกุล</th><th>สิทธิ์</th><th>สถานะ</th><th></th></tr></thead><tbody id="rows">
    ${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.name)}</td><td>${ROLE_LABEL[u.role] ?? u.role}</td>
      <td>${u.active ? '<span class="tag in">ใช้งาน</span>' : '<span class="tag off">ปิด</span>'}</td>
      <td><button class="btn ghost sm" data-id="${u.id}">แก้ไข</button></td></tr>`).join('')}</tbody></table></div></div>
    <div class="card"><div class="bar"><label class="grow">ชื่อหน่วยงาน (แสดงบนหัวใบเบิกและรายงาน)<input id="org" value="${esc(state.orgName)}"></label>
      <button class="btn" id="saveOrg">บันทึก</button></div></div>`;
  $('#add').onclick = () => formDialog('เพิ่มผู้ใช้', [
    { name: 'username', label: 'ชื่อผู้ใช้ (สำหรับเข้าสู่ระบบ)' }, { name: 'name', label: 'ชื่อ-สกุล' },
    { name: 'password', label: 'รหัสผ่าน (อย่างน้อย 6 ตัวอักษร)', type: 'password' },
    { name: 'role', label: 'สิทธิ์', type: 'select', options: roles, value: 'staff' }],
    async (v) => { await api('/api/users', 'POST', v); toast('เพิ่มผู้ใช้แล้ว'); views.users(); });
  $('#rows').onclick = (e) => {
    const u = users.find((x) => x.id == e.target.dataset.id);
    if (u) formDialog(`แก้ไขผู้ใช้: ${u.username}`, [
      { name: 'name', label: 'ชื่อ-สกุล', value: u.name },
      { name: 'role', label: 'สิทธิ์', type: 'select', options: roles, value: u.role },
      { name: 'password', label: 'ตั้งรหัสผ่านใหม่ (เว้นว่างถ้าไม่เปลี่ยน)', type: 'password', required: false },
      { name: 'active', label: 'ใช้งานอยู่', type: 'checkbox', value: u.active }],
      async (v) => { await api(`/api/users/${u.id}`, 'PUT', v); toast('บันทึกแล้ว'); views.users(); });
  };
  $('#saveOrg').onclick = async () => {
    try { await api('/api/settings', 'PUT', { orgName: $('#org').value }); state.orgName = $('#org').value.trim(); toast('บันทึกแล้ว'); }
    catch (err) { toast(err.message, true); }
  };
};

document.addEventListener('click', (e) => { if (!e.target.closest('.picker')) { const s = $('#sugg'); if (s) s.hidden = true; } });
boot().catch((e) => (main.innerHTML = `<div class="card">เชื่อมต่อเซิร์ฟเวอร์ไม่ได้: ${esc(e.message)}</div>`));

// ปุ่มกลับขึ้นด้านบน: แสดงเมื่อเลื่อนลงมาเกิน 300px
const toTop = $('#toTop');
window.addEventListener('scroll', () => { toTop.hidden = window.scrollY < 300; }, { passive: true });
toTop.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
