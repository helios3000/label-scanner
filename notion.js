'use strict';
// Notion checklist sync. Talks to the Cloudflare Worker in worker/ (never to Notion directly).
// A scanned label checks the to-do whose name matches the label's item name (or the QR text itself).
// Uses globals from app.js: store, items, settings, $, toast, askConfirm, beep, saveItems,
// renderSession, nextNumber, scanListeners, isLocation, escapeHtml, fmtTime.

const NT_GAP_MS = 350; // keep under Notion's request rate limit

const nt = Object.assign(
  { pageId: '', pages: [], todos: {}, loadedAt: {}, round: {} },
  store.get('ls.notion', {}),
);
let ntOutbox = store.get('ls.notionOutbox', []); // [{ page, key, checked }]
let ntFlushing = false;
let ntLastError = '';

const saveNt = () => store.set('ls.notion', nt);
const saveOutbox = () => store.set('ls.notionOutbox', ntOutbox);

// Match key: "IBP센서 (4ea)" and "ibp 센서" both -> "ibp센서"
const ntKey = (s) => String(s || '').normalize('NFC').toLowerCase()
  .replace(/\(?\s*\d+\s*ea\s*\)?/gi, '').replace(/\s+/g, '');
// "파워케이블 4ea", "IBP센서 (4ea)" -> 4
function ntNeed(text) {
  const m = /(\d+)\s*ea\b/i.exec(text || '');
  return m ? Math.min(50, Math.max(1, +m[1])) : 1;
}

const ntConfigured = () => !!(settings.notionUrl && settings.notionKey);
const ntTodos = () => nt.todos[nt.pageId] || [];
const ntTodo = (key) => ntTodos().find((t) => ntKey(t.text) === key);
const ntRound = () => (nt.round[nt.pageId] ||= {});

// Item codes that will check this entry. A code whose QR text is itself another entry's name
// belongs to that entry, whatever its registered name says (same rule as ntMatch).
function ntLabelsFor(key) {
  return Object.keys(items).filter((c) => {
    if (isLocation(c)) return false;
    const direct = ntTodo(ntKey(c));
    return direct ? ntKey(direct.text) === key : ntKey(items[c].name) === key;
  });
}

// QR text names an entry: make the item's registered name agree with it
function ntSyncNames() {
  let fixed = 0;
  for (const code of Object.keys(items)) {
    const direct = ntTodo(ntKey(code));
    if (direct && items[code].name !== direct.text) {
      ntEvent(`${code}: 품목 이름 "${items[code].name}" → "${direct.text}"로 맞춤`);
      items[code].name = direct.text;
      fixed++;
    }
  }
  if (fixed) { saveItems(); renderSession(); }
}

// Which to-do does a scanned code belong to? QR text itself first, then the item name.
function ntMatch(code) {
  const byText = ntTodo(ntKey(code));
  if (byText) return { todo: byText, direct: true };
  const name = items[code]?.name;
  const byName = name && ntTodo(ntKey(name));
  return byName ? { todo: byName, direct: false } : null;
}

// v0.6.0-0.6.2 linked labels per item; names already carry that link, so drop the old tables
if (store.get('ls.notionLinks', null)) {
  for (const link of Object.values(store.get('ls.notionLinks', {}))) {
    for (const code of link.codes || []) items[code] ||= { name: link.text, memo: '', loc: '', status: '', updated: Date.now() };
  }
  saveItems();
  localStorage.removeItem('ls.notionLinks');
  ntOutbox = ntOutbox.map((o) => ({ ...o, key: ntKey(o.key) }));
  saveOutbox();
  nt.round = {};
  saveNt();
}
settings.notionOn ??= true;

// ---------- Worker API ----------
async function ntApi(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(settings.notionUrl.replace(/\/+$/, '') + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-App-Key': settings.notionKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    const msg = e.name === 'AbortError' ? '응답 없음'
      : e instanceof TypeError ? '인터넷 연결 없음 (연결되면 자동 전송)'
      : e.message === 'unauthorized' ? '앱 키가 맞지 않습니다'
      : e.message;
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

async function ntLoadPages() {
  nt.pages = await ntApi('/pages?q=');
  saveNt();
  renderNtPages();
}

async function ntLoadTodos(page = nt.pageId) {
  if (!page) return;
  const list = await ntApi('/todos?page=' + encodeURIComponent(page));
  // Keep local changes that have not reached Notion yet
  for (const o of ntOutbox) {
    if (o.page !== page) continue;
    const t = list.find((x) => ntKey(x.text) === o.key);
    if (t) t.checked = o.checked;
  }
  nt.todos[page] = list;
  nt.loadedAt[page] = Date.now();
  saveNt();
  if (page === nt.pageId) ntSyncNames();
}

// ---------- Outbox (offline-safe check/uncheck) ----------
function ntQueue(key, checked) {
  ntOutbox = ntOutbox.filter((o) => !(o.page === nt.pageId && o.key === key));
  ntOutbox.push({ page: nt.pageId, key, checked });
  saveOutbox();
  const t = ntTodo(key);
  if (t) { t.checked = checked; saveNt(); }
  ntFlush();
}

async function ntFlush() {
  if (ntFlushing || !ntOutbox.length || !ntConfigured()) return renderNtSync();
  ntFlushing = true;
  renderNtSync();
  try {
    while (ntOutbox.length) {
      const o = ntOutbox[0];
      const find = () => (nt.todos[o.page] || []).find((t) => ntKey(t.text) === o.key);
      let todo = find();
      if (!todo) {
        await ntLoadTodos(o.page);
        todo = find();
      }
      if (todo) {
        await ntApi('/check', { blockId: todo.id, checked: o.checked });
        ntEvent(`✓ Notion 반영: ${todo.text} ${o.checked ? '체크' : '해제'}`);
      } else {
        // A missing item (renamed or deleted in Notion) is dropped so it cannot block the queue
        ntEvent(`⚠ Notion에서 "${o.key}" 항목을 찾지 못했습니다 (이름이 바뀌었나요?)`, true);
      }
      ntOutbox.shift();
      saveOutbox();
      ntLastError = '';
      renderNtSync();
      await new Promise((r) => setTimeout(r, NT_GAP_MS));
    }
  } catch (e) {
    ntLastError = e.message;
    ntEvent(`⚠ Notion 전송 실패: ${e.message}`, true);
  } finally {
    ntFlushing = false;
    renderNtSync();
    if ($('#tab-notion').classList.contains('active')) renderNtList();
  }
}

// Recent sync activity, shown in the Notion tab so failures are visible on the phone
let ntEvents = store.get('ls.notionEvents', []);
function ntEvent(msg, warn = false) {
  ntEvents.unshift({ time: Date.now(), msg, warn });
  ntEvents = ntEvents.slice(0, 20);
  store.set('ls.notionEvents', ntEvents);
  if (warn) toast(msg);
  renderNtEvents();
}
function renderNtEvents() {
  $('#nt-log').innerHTML = ntEvents.length
    ? ntEvents.slice(0, 5).map((e) => `<li class="${e.warn ? 'warn' : ''}"><span class="time">${fmtTime(e.time)}</span> ${escapeHtml(e.msg)}</li>`).join('')
    : '<li class="hint">아직 기록이 없습니다</li>';
}

window.addEventListener('online', ntFlush);
setInterval(() => { if (ntOutbox.length && !ntFlushing) ntFlush(); }, 20000);

// ---------- Scan hook ----------
// An item is checked once all of its labels were scanned in this round ("4ea" -> 4 labels)
const ntNoted = new Set(); // explain each code once, not on every camera frame
function ntNoteOnce(id, msg, warn) {
  if (ntNoted.has(id)) return;
  ntNoted.add(id);
  ntEvent(msg, warn);
}

scanListeners.push((code) => {
  if (!ntConfigured() || isLocation(code)) return;
  if (!settings.notionOn) return ntNoteOnce('off', '⚠ 설정에서 "스캔하면 Notion 체크리스트에 체크"가 꺼져 있습니다', true);
  if (!nt.pageId) return ntNoteOnce('nopage', '⚠ Notion 탭에서 체크리스트 페이지를 먼저 선택하세요', true);
  if (!ntTodos().length) return ntNoteOnce('notodos', '⚠ Notion 탭에서 "Notion에서 불러오기"를 먼저 눌러 주세요', true);

  const match = ntMatch(code);
  if (!match) {
    const name = items[code]?.name;
    return ntNoteOnce('nomatch:' + code, `${code}${name ? ` (${name})` : ''}: 체크리스트에 같은 이름의 항목이 없습니다`);
  }
  const { todo, direct } = match;
  const key = ntKey(todo.text);
  // Remember name-labels so the Notion tab lists them and "QR 만들기" does not duplicate them
  if (direct && !items[code]) {
    items[code] = { name: todo.text, memo: '', loc: '', status: '', updated: Date.now() };
    saveItems();
  }
  const seenCodes = (ntRound()[key] ||= []);
  if (seenCodes.includes(code)) return;
  seenCodes.push(code);
  saveNt();

  // Identical QR texts cannot be told apart, so a label holding the item name counts as complete
  const need = direct ? 1 : ntNeed(todo.text);
  if (seenCodes.length >= need) {
    // Always send: the cached state may be stale if someone unchecked it in Notion meanwhile
    ntQueue(key, true);
    beep(2200, 0.12, 0.1);
    toast(`✅ ${todo.text} 체크`);
    ntEvent(`${code}: "${todo.text}" 체크 → 전송 중`);
  } else {
    toast(`${todo.text} ${seenCodes.length}/${need}`);
    ntEvent(`${code}: "${todo.text}" ${seenCodes.length}/${need}`);
  }
  if ($('#tab-notion').classList.contains('active')) renderNtList();
});

// ---------- UI ----------
function renderNtPages() {
  const sel = $('#nt-page');
  const pages = [...nt.pages];
  if (nt.pageId && !pages.some((p) => p.id === nt.pageId)) pages.unshift({ id: nt.pageId, title: nt.pageTitle || nt.pageId });
  sel.innerHTML = '<option value="">체크리스트 페이지 선택…</option>'
    + pages.map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('');
  sel.value = nt.pageId;
}

function renderNtSync() {
  const el = $('#nt-sync');
  if (ntLastError) el.textContent = `⚠ ${ntLastError}` + (ntOutbox.length ? ` (대기 ${ntOutbox.length})` : '');
  else if (ntOutbox.length) el.textContent = ntFlushing ? `동기화 중… ${ntOutbox.length}` : `동기화 대기 ${ntOutbox.length}`;
  else el.textContent = nt.pageId && ntTodos().length ? '✓ 동기화됨' : '';
  el.classList.toggle('warn', !!ntLastError);
}

function renderNtList() {
  const todos = ntTodos();
  const done = todos.filter((t) => t.checked).length;
  $('#nt-progress').innerHTML = todos.length ? `체크 <b>${done}</b>/${todos.length}` : '';
  renderNtSync();

  const ul = $('#nt-list');
  if (!nt.pageId) { ul.innerHTML = '<li class="empty">체크리스트 페이지를 선택하세요</li>'; return; }
  if (!todos.length) { ul.innerHTML = '<li class="empty">체크박스 항목이 없습니다 ("Notion에서 불러오기"를 눌러 보세요)</li>'; return; }

  const round = ntRound();
  let section = null;
  ul.innerHTML = todos.map((t, i) => {
    const key = ntKey(t.text);
    const need = ntNeed(t.text);
    const labels = ntLabelsFor(key);
    const scanned = round[key]?.length || 0;
    const head = t.section !== section ? `<li class="section">${escapeHtml((section = t.section) || '기타')}</li>` : '';
    const sub = [
      need > 1 ? `이번 스캔 ${Math.min(scanned, need)}/${need}` : '',
      labels.length ? `라벨 ${escapeHtml(labels.join(', '))}` : '<span class="warn">등록된 라벨 없음</span>',
    ].filter(Boolean).join(' · ');
    return `${head}<li class="todo${t.checked ? ' done' : ''}">
      <button class="cb" data-toggle="${i}" aria-label="체크">${t.checked ? '✓' : ''}</button>
      <div class="main">
        <div class="name">${escapeHtml(t.text)}</div>
        <div class="code">${sub}</div>
      </div>
    </li>`;
  }).join('');
}

async function renderNotionTab() {
  const ok = ntConfigured();
  $('#nt-setup').hidden = ok;
  $('#nt-main').hidden = !ok;
  if (!ok) return;
  renderNtPages();
  renderNtList();
  try {
    if (!nt.pages.length) await ntLoadPages();
    // Refresh from Notion when the cached copy is older than a minute
    if (nt.pageId && Date.now() - (nt.loadedAt[nt.pageId] || 0) > 60000 && !ntOutbox.length) {
      await ntLoadTodos();
      renderNtList();
    }
  } catch (e) {
    ntLastError = e.message;
    renderNtSync();
  }
}

$('#nt-page').addEventListener('change', async (e) => {
  nt.pageId = e.target.value;
  nt.pageTitle = e.target.selectedOptions[0]?.textContent || '';
  saveNt();
  ntNoted.clear();
  renderNtList();
  if (!nt.pageId) return;
  try { await ntLoadTodos(); ntLastError = ''; } catch (err) { ntLastError = err.message; }
  renderNtList();
});

$('#nt-pages-refresh').addEventListener('click', async () => {
  try { await ntLoadPages(); toast(`페이지 ${nt.pages.length}개`); } catch (e) { toast('불러오기 실패: ' + e.message); }
});

$('#nt-reload').addEventListener('click', async () => {
  if (!nt.pageId) return toast('페이지를 먼저 선택하세요');
  try {
    await ntLoadTodos();
    ntLastError = '';
    toast(`${ntTodos().length}개 항목을 불러왔습니다`);
  } catch (e) {
    ntLastError = e.message;
  }
  renderNtList();
});

$('#nt-uncheck-all').addEventListener('click', async () => {
  const checked = ntTodos().filter((t) => t.checked);
  if (!(await askConfirm(`체크된 ${checked.length}개 항목을 모두 해제하고 새로 시작할까요?`))) return;
  nt.round[nt.pageId] = {};
  saveNt();
  ntNoted.clear();
  checked.forEach((t) => ntQueue(ntKey(t.text), false));
  renderNtList();
});

$('#nt-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-toggle]');
  const todo = btn && ntTodos()[+btn.dataset.toggle];
  if (!todo) return;
  ntQueue(ntKey(todo.text), !todo.checked);
  renderNtList();
});

// Make QR labels for checklist entries that have fewer labels than they need
$('#nt-make-labels').addEventListener('click', async () => {
  const missing = ntTodos()
    .map((t) => ({ t, key: ntKey(t.text), need: ntNeed(t.text) }))
    .map((x) => ({ ...x, have: ntLabelsFor(x.key).length }))
    .filter((x) => x.have < x.need);
  const total = missing.reduce((n, x) => n + x.need - x.have, 0);
  if (!total) return toast('모든 항목에 라벨이 있습니다');
  if (!(await askConfirm(`${missing.length}개 항목에 쓸 라벨 ${total}개를 새로 만들까요?`))) return;

  const prefix = settings.labelPrefix ?? 'A';
  const digits = settings.labelDigits ?? 4;
  let n = nextNumber(prefix);
  const print = [];
  for (const { t, need, have } of missing) {
    for (let i = have; i < need; i++) {
      const code = prefix + String(n++).padStart(digits, '0');
      items[code] = { name: t.text, memo: '', loc: '', status: '', updated: Date.now() };
      print.push({ code, caption: need > 1 ? `${t.text} (${i + 1}/${need})` : t.text });
    }
  }
  saveItems();
  store.set('ls.print', print);
  renderNtList();
  renderSession();
  window.open('test-labels.html?from=app&size=20', '_blank');
});

// ---------- Settings ----------
$('#set-nt-url').value = settings.notionUrl || '';
$('#set-nt-key').value = settings.notionKey || '';
$('#set-nt-on').checked = !!settings.notionOn;
// Read the fields directly: on iOS the button tap can arrive before the input's change event
function ntSaveSettings() {
  let url = $('#set-nt-url').value.trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  settings.notionUrl = url;
  settings.notionKey = $('#set-nt-key').value.trim();
  settings.notionOn = $('#set-nt-on').checked;
  store.set('ls.settings', settings);
  ntNoted.delete('off');
}
for (const id of ['#set-nt-url', '#set-nt-key', '#set-nt-on']) {
  $(id).addEventListener('input', ntSaveSettings);
  $(id).addEventListener('change', ntSaveSettings);
}
$('#nt-test').addEventListener('click', async () => {
  ntSaveSettings();
  if (!settings.notionUrl) return toast('Worker 주소를 입력하세요');
  if (!settings.notionKey) return toast('앱 키를 입력하세요 (APP_KEY로 등록한 비밀번호)');
  try {
    await ntApi('/ping');
    const pages = await ntApi('/pages?q=');
    nt.pages = pages;
    saveNt();
    toast(`연결 성공 — 공유된 페이지 ${pages.length}개`);
  } catch (e) {
    toast('연결 실패: ' + e.message);
  }
});

renderNtEvents();
ntSyncNames();
ntFlush();
