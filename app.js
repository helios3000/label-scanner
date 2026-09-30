'use strict';

const APP_VERSION = '0.5.0';

// ---------- Storage ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast('저장 실패 (저장공간 확인)'); }
  },
};

const LOG_LIMIT = 5000;

let items = store.get('ls.items', {});        // code -> { name, memo, loc, status, updated }
let session = store.get('ls.session', []);    // [{ code, time, loc, action }]
session.forEach((s) => { s.action ??= 'scan'; s.loc ??= ''; }); // entries from v0.4 and earlier
let records = store.get('ls.history', []);    // [{ id, name, time, entries: [...session entries] }]
let log = store.get('ls.log', []);            // [{ code, action, time, loc }] status changes, oldest first
let ui = Object.assign({ mode: 'scan', loc: '', find: '' }, store.get('ls.ui', {}));
let settings = Object.assign(
  { formats: 'qr', res: '720', sound: true, multi: true, fps: '10', autostop: '30', zoom: '1', locPrefix: 'LOC-' },
  store.get('ls.settings', {}),
);
// v0.2 stored zoom as a slider number; snap to the select options
if (!['1', '1.5', '2', '3'].includes(String(settings.zoom))) settings.zoom = '1';
settings.zoom = String(settings.zoom);

const saveItems = () => store.set('ls.items', items);
const saveSession = () => store.set('ls.session', session);
const saveHistory = () => store.set('ls.history', records);
const saveLog = () => store.set('ls.log', log);
const saveUi = () => store.set('ls.ui', ui);

// Scan modes; `status` is what the item becomes after a scan in that mode
const MODES = {
  scan: { label: '일반 스캔' },
  in: { label: '입고', status: '보관' },
  out: { label: '출고', status: '출고' },
  lend: { label: '대여', status: '대여중' },
  ret: { label: '반납', status: '보관' },
  find: { label: '찾기' },
};

const $ = (sel) => document.querySelector(sel);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1800);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// In-page dialogs: native confirm()/prompt() freeze the iOS camera preview
function openDialog(message, withInput, initial = '') {
  return new Promise((resolve) => {
    const dlg = $('#dialog');
    const input = $('#dialog-input');
    $('#dialog-msg').textContent = message;
    input.hidden = !withInput;
    input.value = initial;
    dlg.hidden = false;
    if (withInput) input.focus();
    const done = (ok) => {
      dlg.hidden = true;
      $('#dialog-ok').onclick = $('#dialog-cancel').onclick = input.onkeydown = null;
      resolve(ok ? (withInput ? input.value : true) : (withInput ? null : false));
    };
    $('#dialog-ok').onclick = () => done(true);
    $('#dialog-cancel').onclick = () => done(false);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(true); };
  });
}
const askConfirm = (message) => openDialog(message, false);
const askText = (message, initial) => openDialog(message, true, initial);

const pad2 = (n) => String(n).padStart(2, '0');
function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

// Natural order so A2 < A10
const cmpCode = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const byCode = (a, b) => cmpCode(a.code, b.code);

const isLocation = (code) => !!settings.locPrefix && code.startsWith(settings.locPrefix);
const locLabel = (loc) => (loc ? (items[loc]?.name ? `${items[loc].name} (${loc})` : loc) : '');

// Split "A0012" -> { prefix: "A", num: 12, width: 4 }
function splitCode(code) {
  const m = /^(.*?)(\d+)$/.exec(code);
  return m ? { prefix: m[1], num: +m[2], width: m[2].length } : null;
}

// ---------- Tabs & segmented controls ----------
function showTab(name) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'items') { renderItems(); refreshLabelMaker(); }
  if (name === 'history') renderHistoryTab();
}
document.querySelectorAll('nav button').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

function setupSeg(segId, onChange) {
  const seg = $(segId);
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    onChange(btn.dataset.view);
  });
}

// ---------- Scanner ----------
const FORMAT_SETS = {
  qr: ['qr_code', 'micro_qr_code'],
  qr_linear: ['qr_code', 'micro_qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8'],
  all: undefined,
};

// Serve the wasm from this origin so the app works offline
BarcodeDetectionAPI.prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith('.wasm') ? new URL('vendor/' + path, location.href).href : prefix + path,
  },
});

const video = $('#video');
const overlay = $('#overlay');
const viewer = $('#viewer');
const frame = document.createElement('canvas');
const frameCtx = frame.getContext('2d', { willReadFrequently: true });
let maxFrameSide = 1280; // downscale large frames to keep detection fast

let running = false;
let stream = null;
let detector = null;
let audioCtx = null;
let msAvg = 0;
let lastActivity = 0;  // last time any code was in view, for auto-stop
let rateStart = 0, rateCount = 0;

function beep(freq = 1800, dur = 0.08, delay = 0) {
  if (!settings.sound || !audioCtx) return;
  const t = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.2, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + dur);
}

function ensureAudio() {
  // Create audio in a user gesture so iOS allows playback
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume();
}

async function startScan() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('이 브라우저는 카메라를 지원하지 않습니다 (HTTPS 필요)');
    return;
  }
  ensureAudio();

  const h = settings.res === '1080' ? 1080 : 720;
  const w = settings.res === '1080' ? 1920 : 1280;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: w }, height: { ideal: h } },
    });
  } catch (e) {
    toast('카메라를 열 수 없습니다: ' + e.name);
    return;
  }
  video.srcObject = stream;
  await video.play();
  maxFrameSide = w;
  applyZoom(stream.getVideoTracks()[0]);

  const formats = FORMAT_SETS[settings.formats];
  detector = new BarcodeDetectionAPI.BarcodeDetector(formats ? { formats } : undefined);

  running = true;
  lastActivity = performance.now();
  rateStart = rateCount = 0;
  $('#viewer-msg').style.display = 'none';
  const btn = $('#btn-start');
  btn.textContent = '스캔 중지';
  btn.classList.add('stop');
  loop();
}

// Zoom lets small labels fill more pixels without moving closer than the focus distance
function applyZoom(track) {
  const caps = track?.getCapabilities?.();
  if (!caps?.zoom || caps.zoom.max <= caps.zoom.min) {
    $('#stat-zoom').textContent = '미지원';
    return;
  }
  $('#stat-zoom').textContent = `지원 (최대 ${caps.zoom.max}x)`;
  const z = Math.min(Math.max(+settings.zoom, caps.zoom.min), caps.zoom.max);
  track.applyConstraints({ advanced: [{ zoom: z }] }).catch((e) => console.warn('zoom failed', e));
}

function stopScan() {
  running = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  $('#viewer-msg').style.display = '';
  const btn = $('#btn-start');
  btn.textContent = '스캔 시작';
  btn.classList.remove('stop');
}

async function loop() {
  while (running) {
    // Recover if iOS interrupted the camera (alerts, calls, Control Center)
    const track = stream?.getVideoTracks()[0];
    if (track?.readyState === 'ended') {
      stopScan();
      await startScan();
      return;
    }
    if (video.paused) video.play().catch(() => {});

    const autostop = +settings.autostop * 1000;
    if (autostop && performance.now() - lastActivity > autostop) {
      stopScan();
      toast(`${settings.autostop}초 동안 인식이 없어 자동 정지했습니다`);
      return;
    }

    const frameStart = performance.now();
    if (video.readyState >= 2 && video.videoWidth) {
      const scale = Math.min(1, maxFrameSide / Math.max(video.videoWidth, video.videoHeight));
      $('#stat-res').textContent = `${video.videoWidth}×${video.videoHeight}`;
      if (!rateStart) rateStart = frameStart;
      frame.width = Math.round(video.videoWidth * scale);
      frame.height = Math.round(video.videoHeight * scale);
      frameCtx.drawImage(video, 0, 0, frame.width, frame.height);

      const t0 = performance.now();
      let results = [];
      try {
        results = await detector.detect(frame);
      } catch (e) {
        console.warn('detect failed', e);
      }
      const ms = performance.now() - t0;
      msAvg = msAvg ? msAvg * 0.9 + ms * 0.1 : ms;
      $('#stat-ms').textContent = Math.round(msAvg) + ' ms/프레임';

      if (!settings.multi && results.length > 1) results = results.slice(0, 1);
      if (results.length) lastActivity = performance.now();
      handleResults(results);

      rateCount++;
      if (frameStart - rateStart >= 1000) {
        $('#stat-fps').textContent = (rateCount * 1000 / (frameStart - rateStart)).toFixed(1) + '회/초';
        rateStart = frameStart;
        rateCount = 0;
      }
    }
    // Cap detections per second to save battery, then yield so the UI stays responsive
    const fps = +settings.fps;
    const wait = fps ? 1000 / fps - (performance.now() - frameStart) : 0;
    await new Promise((r) => setTimeout(r, Math.max(0, wait)));
  }
}

$('#btn-start').addEventListener('click', () => (running ? stopScan() : startScan()));

document.addEventListener('visibilitychange', () => {
  if (document.hidden && running) stopScan();
});

// ---------- Code handling (shared by camera and manual input) ----------
// Returns what happened: 'new' | 'moved' | 'seen' | 'loc' | 'target' | 'ignored'
function processCode(code) {
  if (isLocation(code)) {
    if (ui.loc === code) return 'seen';
    setLocation(code);
    return 'loc';
  }

  if (ui.mode === 'find') {
    return findTargets().includes(code) ? 'target' : 'ignored';
  }

  const now = Date.now();
  const existing = session.find((s) => s.code === code && s.action === ui.mode);
  if (existing) {
    // Same item seen again under a different location label: treat as moved
    if (ui.loc && existing.loc !== ui.loc) {
      existing.loc = ui.loc;
      existing.time = now;
      if (items[code]) { items[code].loc = ui.loc; items[code].updated = now; }
      return 'moved';
    }
    return 'seen';
  }

  session.unshift({ code, time: now, loc: ui.loc, action: ui.mode });
  const it = items[code];
  const status = MODES[ui.mode].status;
  if (it) {
    if (ui.loc) it.loc = ui.loc;
    if (status) it.status = status;
    it.updated = now;
  }
  if (status) {
    log.push({ code, action: ui.mode, time: now, loc: ui.loc });
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  }
  return 'new';
}

function handleResults(results) {
  const changed = [];
  let gotLoc = false, found = [];
  for (const r of results) {
    const code = r.rawValue.trim();
    if (!code) continue;
    r._kind = processCode(code);
    if (r._kind === 'new' || r._kind === 'moved') changed.push(code);
    if (r._kind === 'loc') gotLoc = true;
    if (r._kind === 'target') found.push(code);
  }
  drawOverlay(results);
  if (found.length) showFound(found);
  if (gotLoc) beep(1200, 0.12);
  if (!changed.length) return;

  commitScan(changed);
}

function commitScan(changed) {
  saveSession();
  saveItems();
  saveLog();
  beep();
  viewer.classList.remove('flash');
  void viewer.offsetWidth; // restart animation
  viewer.classList.add('flash');
  $('#stat-last').textContent = changed.join(', ');
  renderSession(changed);
}

let foundTimer = null;
function showFound(codes) {
  const banner = $('#found-banner');
  const text = codes.map((c) => (items[c] ? `${items[c].name} (${c})` : c)).join(', ');
  const fresh = banner.hidden || banner.textContent !== '찾음: ' + text;
  banner.textContent = '찾음: ' + text;
  banner.hidden = false;
  if (fresh) { beep(2000, 0.1); beep(2000, 0.1, 0.15); beep(2000, 0.1, 0.3); }
  clearTimeout(foundTimer);
  foundTimer = setTimeout(() => { banner.hidden = true; }, 2000);
}

const KIND_COLORS = { new: '#3fb950', moved: '#3fb950', seen: '#8b949e', loc: '#2f81f7', target: '#f2cc60', ignored: '#6e7681' };

function drawOverlay(results) {
  const rect = overlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  overlay.width = rect.width * dpr;
  overlay.height = rect.height * dpr;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!results.length) return;

  // Map frame coords -> displayed coords (video uses object-fit: cover)
  const fw = frame.width, fh = frame.height;
  const s = Math.max(overlay.width / fw, overlay.height / fh);
  const ox = (overlay.width - fw * s) / 2;
  const oy = (overlay.height - fh * s) / 2;

  ctx.font = `${13 * dpr}px sans-serif`;
  for (const r of results) {
    const pts = r.cornerPoints;
    if (!pts?.length) continue;
    ctx.strokeStyle = KIND_COLORS[r._kind] || '#8b949e';
    ctx.lineWidth = (r._kind === 'target' ? 6 : 3) * dpr;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = ox + p.x * s, y = oy + p.y * s;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(r.rawValue, ox + pts[0].x * s, oy + pts[0].y * s - 6 * dpr);
  }
}

// ---------- Mode, location, find ----------
function setLocation(code) {
  ui.loc = code;
  saveUi();
  renderModeBar();
  toast('위치: ' + locLabel(code));
  if (!$('#missing-view').hidden) renderMissing();
}

function findTargets() {
  return ui.find.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

function renderModeBar() {
  $('#mode').value = ui.mode;
  $('#find-row').hidden = ui.mode !== 'find';
  $('#find-target').value = ui.find;
  $('#loc-text').textContent = ui.loc ? '📍 ' + (items[ui.loc]?.name || ui.loc) : '위치 없음';
  $('#loc-chip').classList.toggle('on', !!ui.loc);
  $('#loc-clear').hidden = !ui.loc;
}

$('#mode').addEventListener('change', (e) => {
  ui.mode = e.target.value;
  saveUi();
  renderModeBar();
  if (ui.mode === 'find' && !ui.find) $('#find-target').focus();
});
$('#find-target').addEventListener('input', (e) => { ui.find = e.target.value; saveUi(); });
$('#loc-clear').addEventListener('click', () => { ui.loc = ''; saveUi(); renderModeBar(); });

$('#btn-manual').addEventListener('click', async () => {
  ensureAudio();
  const code = (await askText('코드를 입력하세요'))?.trim();
  if (!code) return;
  const kind = processCode(code);
  if (kind === 'new' || kind === 'moved') commitScan([code]);
  else if (kind === 'target') showFound([code]);
  else if (kind === 'seen') toast('이미 목록에 있습니다');
  else if (kind === 'ignored') toast('찾는 코드가 아닙니다');
});

// ---------- Session list ----------
function modeBadge(action) {
  return action && action !== 'scan' ? `<span class="badge m-${action}">${MODES[action]?.label ?? action}</span>` : '';
}

function renderSession(highlight = []) {
  $('#stat-count').textContent = session.length;
  const ul = $('#session-list');
  if (!session.length) {
    ul.innerHTML = '<li class="empty">스캔한 코드가 여기에 표시됩니다</li>';
  } else {
    ul.innerHTML = [...session].sort(byCode).map((s) => {
      const it = items[s.code];
      const cls = highlight.includes(s.code) ? ' class="new"' : '';
      const sub = [escapeHtml(s.code), it?.memo && escapeHtml(it.memo), s.loc && '📍' + escapeHtml(locLabel(s.loc))].filter(Boolean).join(' · ');
      return `<li${cls}>
        <div class="main">
          <div class="name${it ? '' : ' unknown'}">${modeBadge(s.action)}${it ? escapeHtml(it.name) : '미등록'}</div>
          <div class="code">${sub}</div>
        </div>
        <span class="time">${fmtTime(s.time)}</span>
        ${it ? '' : `<button data-register="${escapeHtml(s.code)}">등록</button>`}
        <button data-remove="${escapeHtml(s.code)}" data-action="${escapeHtml(s.action)}">✕</button>
      </li>`;
    }).join('');
  }
  updateMissingCount();
  if (!$('#missing-view').hidden) renderMissing();
}

$('#session-list').addEventListener('click', async (e) => {
  const reg = e.target.dataset.register;
  const rem = e.target.dataset.remove;
  if (reg) {
    const name = await askText(`${reg} 이름을 입력하세요`);
    if (name?.trim()) {
      const entry = session.find((s) => s.code === reg);
      items[reg] = { name: name.trim(), memo: '', loc: entry?.loc || '', status: MODES[entry?.action]?.status || '', updated: Date.now() };
      saveItems();
      renderSession();
    }
  } else if (rem) {
    session = session.filter((s) => !(s.code === rem && s.action === e.target.dataset.action));
    saveSession();
    renderSession();
  }
});

$('#btn-clear').addEventListener('click', async () => {
  if (!session.length || !(await askConfirm('스캔 목록을 비울까요? (품목·기록은 유지됩니다)'))) return;
  session = [];
  saveSession();
  $('#stat-last').textContent = '';
  renderSession();
});

setupSeg('#scan-seg', (view) => {
  $('#session-list').hidden = view !== 'list';
  $('#missing-view').hidden = view !== 'missing';
  if (view === 'missing') renderMissing();
});
$('#missing-loc-only').addEventListener('change', renderMissing);

// ---------- Missing check ----------
function computeMissing() {
  const scanned = new Set(session.map((s) => s.code));
  const locOnly = $('#missing-loc-only').checked && ui.loc;
  const missingItems = Object.entries(items)
    .filter(([code, it]) => !isLocation(code) && !scanned.has(code) && (!locOnly || it.loc === ui.loc))
    .map(([code, it]) => ({ code, ...it }))
    .sort(byCode);

  // Gaps between the lowest and highest scanned number, per prefix
  const groups = new Map();
  for (const code of scanned) {
    if (isLocation(code)) continue;
    const p = splitCode(code);
    if (!p) continue;
    const g = groups.get(p.prefix) || { nums: new Set(), width: p.width };
    g.nums.add(p.num);
    g.width = Math.max(g.width, p.width);
    groups.set(p.prefix, g);
  }
  const gaps = [];
  for (const [prefix, g] of groups) {
    const nums = [...g.nums];
    const min = Math.min(...nums), max = Math.max(...nums);
    if (max - min > 5000) continue; // ignore unrelated numbers far apart
    for (let n = min + 1; n < max; n++) {
      if (!g.nums.has(n)) gaps.push(prefix + String(n).padStart(g.width, '0'));
    }
  }
  return { missingItems, gaps };
}

function updateMissingCount() {
  const { missingItems, gaps } = computeMissing();
  const n = missingItems.length + gaps.filter((c) => !items[c]).length;
  $('#missing-count').textContent = session.length && n ? `(${n})` : '';
}

function renderMissing() {
  const { missingItems, gaps } = computeMissing();
  $('#missing-loc-only').disabled = !ui.loc;
  $('#missing-items').innerHTML = missingItems.length
    ? missingItems.map((it) => `<li>
        <div class="main">
          <div class="name">${it.status ? `<span class="badge">${escapeHtml(it.status)}</span>` : ''}${escapeHtml(it.name)}</div>
          <div class="code">${escapeHtml(it.code)}${it.loc ? ' · 📍' + escapeHtml(locLabel(it.loc)) : ''}</div>
        </div>
        <button data-find="${escapeHtml(it.code)}">찾기</button>
      </li>`).join('')
    : `<li class="empty">${Object.keys(items).length ? '없음' : '등록된 품목이 없습니다'}</li>`;
  const shown = gaps.slice(0, 200);
  $('#missing-numbers').innerHTML = shown.length
    ? shown.map((c) => `<li><div class="main"><div class="name">${escapeHtml(items[c]?.name ?? c)}</div>${items[c] ? `<div class="code">${escapeHtml(c)}</div>` : ''}</div></li>`).join('')
      + (gaps.length > shown.length ? `<li class="empty">외 ${gaps.length - shown.length}개</li>` : '')
    : '<li class="empty">없음</li>';
}

$('#missing-items').addEventListener('click', (e) => {
  const code = e.target.dataset.find;
  if (code) startFind(code);
});

function startFind(code) {
  ui.mode = 'find';
  ui.find = code;
  saveUi();
  renderModeBar();
  showTab('scan');
  window.scrollTo(0, 0);
  toast(`${code} 찾기 모드`);
}

// ---------- Save to history ----------
$('#btn-save-history').addEventListener('click', async () => {
  if (!session.length) return toast('저장할 스캔 목록이 없습니다');
  const d = new Date();
  const modes = [...new Set(session.map((s) => MODES[s.action]?.label))].join('/');
  const def = `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())} ${modes}`;
  const name = (await askText('기록 이름', def))?.trim();
  if (name == null || name === '') return;
  records.unshift({ id: Date.now().toString(36), name, time: Date.now(), entries: session.map((s) => ({ ...s })) });
  saveHistory();
  toast('기록에 저장했습니다');
});

// ---------- CSV ----------
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadCsv(filename, rows) {
  // BOM so Excel opens Korean text correctly
  const text = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function entriesCsv(entries) {
  const rows = [['시간', '코드', '이름', '메모', '위치', '모드']];
  for (const s of [...entries].sort(byCode)) {
    const it = items[s.code];
    rows.push([fmtDateTime(s.time), s.code, it?.name ?? '', it?.memo ?? '', s.loc ? locLabel(s.loc) : '', MODES[s.action]?.label ?? '']);
  }
  return rows;
}

$('#btn-export-session').addEventListener('click', () => {
  if (!session.length) return toast('내보낼 항목이 없습니다');
  downloadCsv(`scan_${stamp()}.csv`, entriesCsv(session));
});

// ---------- Items ----------
function renderLocOptions() {
  const locs = new Set([...Object.keys(items).filter(isLocation), ...Object.values(items).map((it) => it.loc).filter(Boolean)]);
  $('#loc-options').innerHTML = [...locs].sort(cmpCode)
    .map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(items[l]?.name ?? '')}</option>`).join('');
}

function renderItems() {
  const q = $('#item-search').value.trim().toLowerCase();
  const list = Object.entries(items)
    .filter(([code, it]) => !q || [code, it.name, it.memo, it.loc, locLabel(it.loc), it.status].some((v) => (v || '').toLowerCase().includes(q)))
    .sort(([a], [b]) => cmpCode(a, b));
  const ul = $('#item-list');
  renderLocOptions();
  if (!list.length) {
    ul.innerHTML = `<li class="empty">${q ? '검색 결과 없음' : '등록된 품목이 없습니다'}</li>`;
    return;
  }
  ul.innerHTML = list.map(([code, it]) => {
    const badge = isLocation(code) ? '<span class="badge loc">위치</span>' : it.status ? `<span class="badge">${escapeHtml(it.status)}</span>` : '';
    const sub = [escapeHtml(code), it.memo && escapeHtml(it.memo), it.loc && '📍' + escapeHtml(locLabel(it.loc))].filter(Boolean).join(' · ');
    return `<li>
      <div class="main">
        <div class="name">${badge}${escapeHtml(it.name)}</div>
        <div class="code">${sub}</div>
      </div>
      ${isLocation(code) ? '' : `<button data-find="${escapeHtml(code)}">찾기</button>`}
      <button data-edit="${escapeHtml(code)}">수정</button>
      <button data-del="${escapeHtml(code)}">삭제</button>
    </li>`;
  }).join('');
}

$('#item-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#item-code').value.trim();
  const name = $('#item-name').value.trim();
  if (!code || !name) return;
  items[code] = {
    name,
    memo: $('#item-memo').value.trim(),
    loc: $('#item-loc').value.trim(),
    status: items[code]?.status || '',
    updated: Date.now(),
  };
  saveItems();
  e.target.reset();
  toast(`${code} 저장됨`);
  renderItems();
  renderSession();
  renderModeBar();
});

$('#item-list').addEventListener('click', async (e) => {
  const { edit, del, find } = e.target.dataset;
  if (find) startFind(find);
  else if (edit) {
    const it = items[edit];
    $('#item-code').value = edit;
    $('#item-name').value = it.name;
    $('#item-memo').value = it.memo || '';
    $('#item-loc').value = it.loc || '';
    $('#item-form').scrollIntoView({ behavior: 'smooth' });
    $('#item-name').focus();
  } else if (del && (await askConfirm(`${del} (${items[del].name}) 삭제할까요?`))) {
    delete items[del];
    saveItems();
    renderItems();
    renderSession();
  }
});

$('#item-search').addEventListener('input', renderItems);

$('#btn-export-items').addEventListener('click', () => {
  const rows = [['코드', '이름', '메모', '위치', '상태']];
  for (const [code, it] of Object.entries(items).sort(([a], [b]) => cmpCode(a, b))) {
    rows.push([code, it.name, it.memo || '', it.loc || '', it.status || '']);
  }
  if (rows.length === 1) return toast('내보낼 품목이 없습니다');
  downloadCsv(`items_${stamp()}.csv`, rows);
});

$('#file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const rows = parseCsv(await file.text());
  // Skip header row if present
  if (rows.length && /코드|code/i.test(rows[0][0])) rows.shift();
  let n = 0;
  for (const [code, name, memo, loc, status] of rows) {
    if (!code?.trim() || !name?.trim()) continue;
    const prev = items[code.trim()];
    items[code.trim()] = {
      name: name.trim(),
      memo: (memo || '').trim(),
      loc: (loc ?? prev?.loc ?? '').trim(),
      status: (status ?? prev?.status ?? '').trim(),
      updated: Date.now(),
    };
    n++;
  }
  saveItems();
  toast(`${n}개 가져옴`);
  renderItems();
  renderSession();
});

// ---------- Label maker ----------
function allKnownCodes() {
  const codes = new Set(Object.keys(items));
  session.forEach((s) => codes.add(s.code));
  records.forEach((h) => h.entries.forEach((s) => codes.add(s.code)));
  return codes;
}

function nextNumber(prefix) {
  let max = 0;
  for (const code of allKnownCodes()) {
    const p = splitCode(code);
    if (p && p.prefix === prefix) max = Math.max(max, p.num);
  }
  return max + 1;
}

function labelParams() {
  return {
    prefix: $('#lm-prefix').value.trim(),
    digits: Math.min(8, Math.max(1, +$('#lm-digits').value || 4)),
    start: Math.max(0, +$('#lm-start').value || 0),
    count: Math.min(200, Math.max(1, +$('#lm-count').value || 1)),
  };
}

function labelCodes() {
  const { prefix, digits, start, count } = labelParams();
  return Array.from({ length: count }, (_, i) => prefix + String(start + i).padStart(digits, '0'));
}

function refreshLabelMaker(resetStart = true) {
  if (!$('#lm-prefix').value) $('#lm-prefix').value = settings.labelPrefix ?? 'A';
  if (!$('#lm-digits').value) $('#lm-digits').value = settings.labelDigits ?? 4;
  if (resetStart) $('#lm-start').value = nextNumber($('#lm-prefix').value.trim());
  const codes = labelCodes();
  $('#lm-preview').textContent = codes.length > 1 ? `${codes[0]} ~ ${codes[codes.length - 1]} (${codes.length}개)` : codes[0];
}

$('#lm-prefix').addEventListener('input', () => refreshLabelMaker(true));
['#lm-digits', '#lm-start', '#lm-count'].forEach((id) => $(id).addEventListener('input', () => refreshLabelMaker(false)));
['#lm-prefix', '#lm-digits'].forEach((id) => $(id).addEventListener('change', () => {
  settings.labelPrefix = $('#lm-prefix').value.trim();
  settings.labelDigits = +$('#lm-digits').value || 4;
  store.set('ls.settings', settings);
}));

$('#lm-print').addEventListener('click', () => {
  const { prefix, digits, start, count } = labelParams();
  const q = new URLSearchParams({ prefix, digits, start, count, size: 20, print: 1 });
  window.open('test-labels.html?' + q, '_blank');
});

$('#lm-csv').addEventListener('click', () => {
  downloadCsv(`labels_${stamp()}.csv`, [['코드'], ...labelCodes().map((c) => [c])]);
});

// ---------- History tab ----------
let histView = 'sessions';
let openRecordId = null;

setupSeg('#hist-seg', (view) => {
  histView = view;
  openRecordId = null;
  renderHistoryTab();
});

function renderHistoryTab() {
  $('#hist-sessions').hidden = histView !== 'sessions' || !!openRecordId;
  $('#hist-detail').hidden = histView !== 'sessions' || !openRecordId;
  $('#hist-log').hidden = histView !== 'log';
  if (histView === 'log') return renderLog();
  if (openRecordId) return renderRecord();
  const ul = $('#history-list');
  ul.innerHTML = records.length
    ? records.map((h) => `<li data-open="${h.id}">
        <div class="main">
          <div class="name">${escapeHtml(h.name)}</div>
          <div class="code">${fmtDateTime(h.time)} · ${h.entries.length}건</div>
        </div>
        <span class="chev">›</span>
      </li>`).join('')
    : '<li class="empty">스캔 화면에서 "기록 저장"을 누르면 여기에 쌓입니다</li>';
}

$('#history-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-open]');
  if (!li) return;
  openRecordId = li.dataset.open;
  $('#hd-compare').value = '';
  renderHistoryTab();
});

$('#hd-back').addEventListener('click', () => { openRecordId = null; renderHistoryTab(); });

function currentRecord() {
  return records.find((h) => h.id === openRecordId);
}

function renderRecord() {
  const rec = currentRecord();
  if (!rec) { openRecordId = null; return renderHistoryTab(); }
  $('#hd-title').textContent = `${rec.name} · ${fmtDateTime(rec.time)} · ${rec.entries.length}건`;

  const sel = $('#hd-compare');
  const prev = sel.value;
  sel.innerHTML = '<option value="">비교할 대상 선택…</option><option value="__current">현재 스캔 목록</option>'
    + records.filter((h) => h.id !== rec.id).map((h) => `<option value="${h.id}">${escapeHtml(h.name)} (${fmtDateTime(h.time)})</option>`).join('');
  sel.value = prev;
  renderCompare(rec);

  $('#hd-entries').innerHTML = [...rec.entries].sort(byCode).map((s) => {
    const it = items[s.code];
    const sub = [escapeHtml(s.code), s.loc && '📍' + escapeHtml(locLabel(s.loc))].filter(Boolean).join(' · ');
    return `<li><div class="main">
        <div class="name${it ? '' : ' unknown'}">${modeBadge(s.action)}${it ? escapeHtml(it.name) : '미등록'}</div>
        <div class="code">${sub}</div>
      </div><span class="time">${fmtTime(s.time)}</span></li>`;
  }).join('') || '<li class="empty">비어 있음</li>';
}

function renderCompare(rec) {
  const target = $('#hd-compare').value;
  const box = $('#hd-compare-result');
  if (!target) { box.innerHTML = ''; return; }
  const other = target === '__current' ? { name: '현재 스캔 목록', entries: session } : records.find((h) => h.id === target);
  if (!other) { box.innerHTML = ''; return; }

  const mapOf = (entries) => new Map(entries.map((s) => [s.code, s]));
  const a = mapOf(rec.entries), b = mapOf(other.entries);
  const onlyA = [...a.keys()].filter((c) => !b.has(c)).sort(cmpCode);
  const onlyB = [...b.keys()].filter((c) => !a.has(c)).sort(cmpCode);
  const moved = [...a.keys()].filter((c) => b.has(c) && (a.get(c).loc || '') !== (b.get(c).loc || '')).sort(cmpCode);
  const nameOf = (c) => (items[c] ? `${escapeHtml(items[c].name)} <span class="code">${escapeHtml(c)}</span>` : `<span class="code">${escapeHtml(c)}</span>`);
  const section = (title, codes, fmt = nameOf) => `<div class="cmp"><h3>${title} (${codes.length})</h3>${codes.length ? `<ul class="list compact">${codes.map((c) => `<li>${fmt(c)}</li>`).join('')}</ul>` : '<p class="hint">없음</p>'}</div>`;

  box.innerHTML = section('이 기록에만 있음', onlyA)
    + section(`${escapeHtml(other.name)}에만 있음`, onlyB)
    + section('위치가 다름', moved, (c) => `${nameOf(c)} <span class="hint">${escapeHtml(locLabel(a.get(c).loc) || '없음')} → ${escapeHtml(locLabel(b.get(c).loc) || '없음')}</span>`);
}

$('#hd-compare').addEventListener('change', () => renderCompare(currentRecord()));

$('#hd-csv').addEventListener('click', () => {
  const rec = currentRecord();
  if (rec) downloadCsv(`record_${rec.name.replace(/[\\/:*?"<>| ]+/g, '_')}.csv`, entriesCsv(rec.entries));
});

$('#hd-delete').addEventListener('click', async () => {
  const rec = currentRecord();
  if (!rec || !(await askConfirm(`"${rec.name}" 기록을 삭제할까요?`))) return;
  records = records.filter((h) => h.id !== rec.id);
  saveHistory();
  openRecordId = null;
  renderHistoryTab();
});

function filteredLog() {
  const q = $('#log-search').value.trim().toLowerCase();
  return log.filter((l) => !q || l.code.toLowerCase().includes(q) || (items[l.code]?.name || '').toLowerCase().includes(q));
}

function renderLog() {
  const list = filteredLog().slice(-300).reverse();
  $('#log-list').innerHTML = list.length
    ? list.map((l) => {
      const it = items[l.code];
      const sub = [escapeHtml(l.code), l.loc && '📍' + escapeHtml(locLabel(l.loc))].filter(Boolean).join(' · ');
      return `<li><div class="main">
          <div class="name${it ? '' : ' unknown'}">${modeBadge(l.action)}${it ? escapeHtml(it.name) : '미등록'}</div>
          <div class="code">${sub}</div>
        </div><span class="time">${fmtDateTime(l.time)}</span></li>`;
    }).join('')
    : '<li class="empty">입고·출고·대여·반납 모드로 스캔하면 이력이 쌓입니다</li>';
}

$('#log-search').addEventListener('input', renderLog);

$('#btn-export-log').addEventListener('click', () => {
  const list = filteredLog();
  if (!list.length) return toast('내보낼 이력이 없습니다');
  const rows = [['시간', '코드', '이름', '모드', '위치']];
  for (const l of list) rows.push([fmtDateTime(l.time), l.code, items[l.code]?.name ?? '', MODES[l.action]?.label ?? l.action, l.loc ? locLabel(l.loc) : '']);
  downloadCsv(`log_${stamp()}.csv`, rows);
});

// ---------- Settings ----------
$('#set-formats').value = settings.formats;
$('#set-res').value = settings.res;
$('#set-sound').checked = settings.sound;
$('#set-multi').checked = settings.multi;
$('#set-fps').value = settings.fps;
$('#set-autostop').value = settings.autostop;
$('#set-zoom').value = settings.zoom;
$('#set-locprefix').value = settings.locPrefix;
for (const [id, key, prop] of [
  ['#set-formats', 'formats', 'value'], ['#set-res', 'res', 'value'], ['#set-sound', 'sound', 'checked'],
  ['#set-multi', 'multi', 'checked'], ['#set-fps', 'fps', 'value'], ['#set-autostop', 'autostop', 'value'],
  ['#set-zoom', 'zoom', 'value'], ['#set-locprefix', 'locPrefix', 'value'],
]) {
  $(id).addEventListener('change', (e) => {
    settings[key] = typeof e.target[prop] === 'string' ? e.target[prop].trim() : e.target[prop];
    store.set('ls.settings', settings);
    if (key === 'locPrefix') renderSession();
  });
}
$('#version').textContent = 'v' + APP_VERSION;

// ---------- Init ----------
renderModeBar();
renderSession();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // Reload once when a new version takes over, so the update shows without a second restart
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded || running) return;
    reloaded = true;
    location.reload();
  });
  const swReady = navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
  swReady.then((reg) => reg.update()).catch((e) => console.warn('SW register failed', e));

  // iOS keeps home-screen apps alive in the background, so also check when brought back to front
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) swReady.then((reg) => reg.update()).catch(() => {});
  });

  $('#btn-update').addEventListener('click', async () => {
    if (running) stopScan();
    toast('업데이트 확인 중…');
    try { await (await swReady).update(); } catch {}
    location.reload();
  });
} else {
  $('#btn-update').addEventListener('click', () => location.reload());
}
