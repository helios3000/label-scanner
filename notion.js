'use strict';
// Notion checklist sync. Talks to the Cloudflare Worker in worker/ (never to Notion directly).
// Uses globals from app.js: store, items, settings, $, toast, askConfirm, beep, showTab,
// saveItems, renderSession, nextNumber, scanInterceptors, scanListeners, isLocation, escapeHtml.

const NT_GAP_MS = 350; // keep under Notion's request rate limit

const nt = Object.assign(
  { pageId: '', pages: [], todos: {}, loadedAt: {}, round: {} },
  store.get('ls.notion', {}),
);
// norm(text) -> { text, codes: [] }  (links survive page duplication because they key on text)
let ntLinks = store.get('ls.notionLinks', {});
let ntOutbox = store.get('ls.notionOutbox', []); // [{ page, key, checked }]
let ntLink = null;      // { key, text } while linking labels to an item
let ntFlushing = false;
let ntLastError = '';

const saveNt = () => store.set('ls.notion', nt);
const saveLinks = () => store.set('ls.notionLinks', ntLinks);
const saveOutbox = () => store.set('ls.notionOutbox', ntOutbox);

const ntNorm = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
// "파워케이블 4ea", "IBP센서 (4ea)" -> 4
function ntNeed(text) {
  const m = /(\d+)\s*ea\b/i.exec(text || '');
  return m ? Math.min(50, Math.max(1, +m[1])) : 1;
}

function ntCodeKey(code) {
  for (const [key, link] of Object.entries(ntLinks)) if (link.codes.includes(code)) return key;
  return null;
}

const ntConfigured = () => !!(settings.notionUrl && settings.notionKey);
const ntTodos = () => nt.todos[nt.pageId] || [];
const ntTodo = (key) => ntTodos().find((t) => ntNorm(t.text) === key);
const ntRound = () => (nt.round[nt.pageId] ||= {});

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
    const t = list.find((x) => ntNorm(x.text) === o.key);
    if (t) t.checked = o.checked;
  }
  nt.todos[page] = list;
  nt.loadedAt[page] = Date.now();
  saveNt();
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
      let todo = (nt.todos[o.page] || []).find((t) => ntNorm(t.text) === o.key);
      if (!todo) {
        await ntLoadTodos(o.page);
        todo = (nt.todos[o.page] || []).find((t) => ntNorm(t.text) === o.key);
      }
      const label = todo?.text || ntLinks[o.key]?.text || o.key;
      if (todo) {
        await ntApi('/check', { blockId: todo.id, checked: o.checked });
        ntEvent(`✓ Notion 반영: ${label} ${o.checked ? '체크' : '해제'}`);
      } else {
        // A missing item (renamed or deleted in Notion) is dropped so it cannot block the queue
        ntEvent(`⚠ Notion에서 "${label}" 항목을 찾지 못했습니다 (이름이 바뀌었나요?)`, true);
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

// ---------- Scan hooks ----------
// Link mode: the next scanned labels get attached to the chosen checklist item
scanInterceptors.push((code) => {
  if (!ntLink) return null;
  if (isLocation(code)) return 'ignored';
  const { key, text } = ntLink;
  const link = (ntLinks[key] ||= { text, codes: [] });
  if (link.codes.includes(code)) return 'link';

  const prevKey = ntCodeKey(code);
  if (prevKey) ntLinks[prevKey].codes = ntLinks[prevKey].codes.filter((c) => c !== code);
  link.codes.push(code);
  saveLinks();
  if (!items[code]) {
    items[code] = { name: text, memo: '', loc: '', status: '', updated: Date.now() };
    saveItems();
  }

  const need = ntNeed(text);
  beep(1500, 0.1);
  if (link.codes.length >= need) {
    toast(`"${text}" 라벨 연결 완료 (${link.codes.length}/${need})`);
    ntLink = null;
  } else {
    toast(`"${text}" ${link.codes.length}/${need} 연결됨 — 다음 라벨을 찍으세요`);
  }
  renderLinkBanner();
  renderSession();
  return 'link';
});

// Counting: an item is checked once all of its labels were scanned in this round
const ntWarned = new Set(); // explain each blocked code once, not on every frame
scanListeners.push((code) => {
  const key = ntCodeKey(code);
  if (!key) return;
  const blocked = !settings.notionOn ? '설정에서 "스캔하면 Notion 체크리스트에 체크"가 꺼져 있습니다'
    : !nt.pageId ? 'Notion 탭에서 체크리스트 페이지를 먼저 선택하세요'
    : '';
  if (blocked) {
    if (!ntWarned.has(code + blocked)) { ntWarned.add(code + blocked); ntEvent(`⚠ ${code}: ${blocked}`, true); }
    return;
  }
  const round = ntRound();
  const seenCodes = (round[key] ||= []);
  if (seenCodes.includes(code)) return;
  seenCodes.push(code);
  saveNt();

  const todo = ntTodo(key);
  const text = todo?.text || ntLinks[key].text;
  const need = ntNeed(text);
  if (seenCodes.length >= need) {
    // Always send: the cached state may be stale if someone unchecked it in Notion meanwhile
    ntQueue(key, true);
    beep(2200, 0.12, 0.1);
    toast(`✅ ${text} 체크`);
    ntEvent(`${code}: "${text}" 체크 → 전송 중`);
  } else {
    toast(`${text} ${seenCodes.length}/${need}`);
    ntEvent(`${code}: "${text}" ${seenCodes.length}/${need}`);
  }
  if ($('#tab-notion').classList.contains('active')) renderNtList();
});

// ---------- UI ----------
function renderLinkBanner() {
  const banner = $('#link-banner');
  banner.hidden = !ntLink;
  if (!ntLink) return;
  const have = ntLinks[ntLink.key]?.codes.length || 0;
  $('#link-text').textContent = `🔗 "${ntLink.text}"에 연결할 라벨을 찍으세요 (${have}/${ntNeed(ntLink.text)})`;
}
$('#link-cancel').addEventListener('click', () => { ntLink = null; renderLinkBanner(); });

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
    const key = ntNorm(t.text);
    const need = ntNeed(t.text);
    const linked = ntLinks[key]?.codes || [];
    const scanned = round[key]?.length || 0;
    const head = t.section !== section ? `<li class="section">${escapeHtml((section = t.section) || '기타')}</li>` : '';
    const sub = [
      `<span class="${linked.length >= need ? '' : 'warn'}">라벨 ${linked.length}/${need}</span>`,
      scanned ? `이번 스캔 ${Math.min(scanned, need)}/${need}` : '',
      linked.length ? escapeHtml(linked.join(', ')) : '',
    ].filter(Boolean).join(' · ');
    return `${head}<li class="todo${t.checked ? ' done' : ''}">
      <button class="cb" data-toggle="${i}" aria-label="체크">${t.checked ? '✓' : ''}</button>
      <div class="main">
        <div class="name">${escapeHtml(t.text)}</div>
        <div class="code">${sub}</div>
      </div>
      <button data-link="${i}">연결</button>
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
  checked.forEach((t) => ntQueue(ntNorm(t.text), false));
  renderNtList();
});

$('#nt-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const todo = ntTodos()[+(btn.dataset.toggle ?? btn.dataset.link)];
  if (!todo) return;
  const key = ntNorm(todo.text);

  if (btn.dataset.toggle != null) {
    ntQueue(key, !todo.checked);
    renderNtList();
    return;
  }

  const link = ntLinks[key];
  if (link?.codes.length >= ntNeed(todo.text)) {
    if (!(await askConfirm(`"${todo.text}"에 연결된 라벨(${link.codes.join(', ')})을 지우고 다시 연결할까요?`))) return;
    link.codes = [];
    saveLinks();
  }
  ntLink = { key, text: todo.text };
  ensureAudio();
  renderLinkBanner();
  showTab('scan');
  window.scrollTo(0, 0);
});

$('#nt-make-labels').addEventListener('click', async () => {
  const todos = ntTodos();
  const missing = todos
    .map((t) => ({ t, key: ntNorm(t.text), need: ntNeed(t.text) }))
    .map((x) => ({ ...x, have: ntLinks[x.key]?.codes.length || 0 }))
    .filter((x) => x.have < x.need);
  const total = missing.reduce((n, x) => n + x.need - x.have, 0);
  if (!total) return toast('모든 항목에 라벨이 연결되어 있습니다');
  if (!(await askConfirm(`${missing.length}개 항목에 쓸 라벨 ${total}개를 새로 만들까요?`))) return;

  const prefix = settings.labelPrefix ?? 'A';
  const digits = settings.labelDigits ?? 4;
  let n = nextNumber(prefix);
  const print = [];
  for (const { t, key, need, have } of missing) {
    const link = (ntLinks[key] ||= { text: t.text, codes: [] });
    for (let i = have; i < need; i++) {
      const code = prefix + String(n++).padStart(digits, '0');
      link.codes.push(code);
      items[code] = { name: t.text, memo: '', loc: '', status: '', updated: Date.now() };
      print.push({ code, caption: need > 1 ? `${t.text} (${i + 1}/${need})` : t.text });
    }
  }
  saveLinks();
  saveItems();
  store.set('ls.print', print);
  renderNtList();
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

renderLinkBanner();
renderNtEvents();
ntFlush();
