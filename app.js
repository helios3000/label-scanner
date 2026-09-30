'use strict';

const APP_VERSION = '0.3.2';

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

let items = store.get('ls.items', {});        // code -> { name, memo, updated }
let session = store.get('ls.session', []);    // [{ code, time }]
let settings = Object.assign(
  { formats: 'qr', res: '720', sound: true, multi: true },
  store.get('ls.settings', {}),
);

const $ = (sel) => document.querySelector(sel);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1800);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- Tabs ----------
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + btn.dataset.tab));
    if (btn.dataset.tab === 'items') renderItems();
  });
});

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
let seen = new Set(session.map((s) => s.code));

function beep() {
  if (!settings.sound || !audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = 1800;
  gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.08);
}

async function startScan() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('이 브라우저는 카메라를 지원하지 않습니다 (HTTPS 필요)');
    return;
  }
  // Create audio in the user gesture so iOS allows playback
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume();

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
  setupZoom(stream.getVideoTracks()[0]);

  const formats = FORMAT_SETS[settings.formats];
  detector = new BarcodeDetectionAPI.BarcodeDetector(formats ? { formats } : undefined);

  running = true;
  $('#viewer-msg').style.display = 'none';
  const btn = $('#btn-start');
  btn.textContent = '스캔 중지';
  btn.classList.add('stop');
  loop();
}

// Zoom lets small labels fill more pixels without moving closer than the focus distance
function setupZoom(track) {
  const row = $('#zoom-row');
  const caps = track?.getCapabilities?.();
  if (!caps?.zoom || caps.zoom.max <= caps.zoom.min) {
    row.hidden = true;
    return;
  }
  const slider = $('#zoom');
  slider.min = caps.zoom.min;
  slider.max = Math.min(caps.zoom.max, 5);
  slider.step = caps.zoom.step || 0.1;
  const initial = Math.min(Math.max(settings.zoom ?? caps.zoom.min, caps.zoom.min), +slider.max);
  slider.value = initial;
  row.hidden = false;
  const apply = () => {
    const z = +slider.value;
    $('#zoom-val').textContent = z.toFixed(1) + 'x';
    track.applyConstraints({ advanced: [{ zoom: z }] }).catch((e) => console.warn('zoom failed', e));
    settings.zoom = z;
    store.set('ls.settings', settings);
  };
  slider.oninput = apply;
  apply();
}

function stopScan() {
  running = false;
  $('#zoom-row').hidden = true;
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
    if (video.readyState >= 2 && video.videoWidth) {
      const scale = Math.min(1, maxFrameSide / Math.max(video.videoWidth, video.videoHeight));
      $('#stat-res').textContent = `${video.videoWidth}×${video.videoHeight}`;
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
      $('#stat-ms').textContent = Math.round(msAvg);

      if (!settings.multi && results.length > 1) results = results.slice(0, 1);
      handleResults(results, scale);
    }
    // Yield so the UI stays responsive
    await new Promise((r) => requestAnimationFrame(r));
  }
}

function handleResults(results, scale) {
  const newCodes = [];
  for (const r of results) {
    const code = r.rawValue.trim();
    if (!code) continue;
    r._new = !seen.has(code);
    if (r._new) {
      seen.add(code);
      newCodes.push(code);
    }
  }
  drawOverlay(results, scale);
  if (!newCodes.length) return;

  const now = Date.now();
  for (const code of newCodes) session.unshift({ code, time: now });
  store.set('ls.session', session);
  beep();
  viewer.classList.remove('flash');
  void viewer.offsetWidth; // restart animation
  viewer.classList.add('flash');
  $('#stat-last').textContent = newCodes.join(', ');
  renderSession(newCodes);
}

function drawOverlay(results, scale) {
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

  ctx.lineWidth = 3 * dpr;
  ctx.font = `${13 * dpr}px sans-serif`;
  for (const r of results) {
    const pts = r.cornerPoints;
    if (!pts?.length) continue;
    ctx.strokeStyle = r._new ? '#3fb950' : '#8b949e';
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

$('#btn-start').addEventListener('click', () => (running ? stopScan() : startScan()));

document.addEventListener('visibilitychange', () => {
  if (document.hidden && running) stopScan();
});

// ---------- Session list ----------
// Natural order so A2 < A10
const byCode = (a, b) => a.code.localeCompare(b.code, undefined, { numeric: true });

function renderSession(highlight = []) {
  $('#stat-count').textContent = session.length;
  const ul = $('#session-list');
  if (!session.length) {
    ul.innerHTML = '<li class="empty">스캔한 코드가 여기에 표시됩니다</li>';
    return;
  }
  ul.innerHTML = [...session].sort(byCode).map((s) => {
    const it = items[s.code];
    const cls = highlight.includes(s.code) ? ' class="new"' : '';
    return `<li${cls}>
      <div class="main">
        <div class="name${it ? '' : ' unknown'}">${it ? escapeHtml(it.name) : '미등록'}</div>
        <div class="code">${escapeHtml(s.code)}${it?.memo ? ' · ' + escapeHtml(it.memo) : ''}</div>
      </div>
      <span class="time">${fmtTime(s.time)}</span>
      ${it ? '' : `<button data-register="${escapeHtml(s.code)}">등록</button>`}
      <button data-remove="${escapeHtml(s.code)}">✕</button>
    </li>`;
  }).join('');
}

$('#session-list').addEventListener('click', (e) => {
  const reg = e.target.dataset.register;
  const rem = e.target.dataset.remove;
  if (reg) {
    const name = prompt(`${reg} 이름을 입력하세요`);
    if (name?.trim()) {
      items[reg] = { name: name.trim(), memo: '', updated: Date.now() };
      store.set('ls.items', items);
      renderSession();
    }
  } else if (rem) {
    session = session.filter((s) => s.code !== rem);
    seen.delete(rem);
    store.set('ls.session', session);
    renderSession();
  }
});

$('#btn-clear').addEventListener('click', () => {
  if (!session.length || !confirm('스캔 목록을 비울까요? (품목 목록은 유지됩니다)')) return;
  session = [];
  seen = new Set();
  store.set('ls.session', session);
  $('#stat-last').textContent = '';
  renderSession();
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

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

$('#btn-export-session').addEventListener('click', () => {
  if (!session.length) return toast('내보낼 항목이 없습니다');
  const rows = [['시간', '코드', '이름', '메모']];
  for (const s of [...session].sort(byCode)) {
    const it = items[s.code];
    rows.push([new Date(s.time).toLocaleString('ko-KR', { hour12: false }), s.code, it?.name ?? '', it?.memo ?? '']);
  }
  downloadCsv(`scan_${stamp()}.csv`, rows);
});

// ---------- Items ----------
function renderItems() {
  const q = $('#item-search').value.trim().toLowerCase();
  const list = Object.entries(items)
    .filter(([code, it]) => !q || code.toLowerCase().includes(q) || it.name.toLowerCase().includes(q) || (it.memo || '').toLowerCase().includes(q))
    .sort(([a], [b]) => a.localeCompare(b));
  const ul = $('#item-list');
  if (!list.length) {
    ul.innerHTML = `<li class="empty">${q ? '검색 결과 없음' : '등록된 품목이 없습니다'}</li>`;
    return;
  }
  ul.innerHTML = list.map(([code, it]) => `<li>
      <div class="main">
        <div class="name">${escapeHtml(it.name)}</div>
        <div class="code">${escapeHtml(code)}${it.memo ? ' · ' + escapeHtml(it.memo) : ''}</div>
      </div>
      <button data-edit="${escapeHtml(code)}">수정</button>
      <button data-del="${escapeHtml(code)}">삭제</button>
    </li>`).join('');
}

$('#item-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#item-code').value.trim();
  const name = $('#item-name').value.trim();
  if (!code || !name) return;
  items[code] = { name, memo: $('#item-memo').value.trim(), updated: Date.now() };
  store.set('ls.items', items);
  e.target.reset();
  toast(`${code} 저장됨`);
  renderItems();
  renderSession();
});

$('#item-list').addEventListener('click', (e) => {
  const edit = e.target.dataset.edit;
  const del = e.target.dataset.del;
  if (edit) {
    const it = items[edit];
    $('#item-code').value = edit;
    $('#item-name').value = it.name;
    $('#item-memo').value = it.memo || '';
    $('#item-name').focus();
  } else if (del && confirm(`${del} (${items[del].name}) 삭제할까요?`)) {
    delete items[del];
    store.set('ls.items', items);
    renderItems();
    renderSession();
  }
});

$('#item-search').addEventListener('input', renderItems);

$('#btn-export-items').addEventListener('click', () => {
  const rows = [['코드', '이름', '메모']];
  for (const [code, it] of Object.entries(items).sort(([a], [b]) => a.localeCompare(b))) rows.push([code, it.name, it.memo || '']);
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
  for (const [code, name, memo] of rows) {
    if (!code?.trim() || !name?.trim()) continue;
    items[code.trim()] = { name: name.trim(), memo: (memo || '').trim(), updated: Date.now() };
    n++;
  }
  store.set('ls.items', items);
  toast(`${n}개 가져옴`);
  renderItems();
  renderSession();
});

// ---------- Settings ----------
$('#set-formats').value = settings.formats;
$('#set-res').value = settings.res;
$('#set-sound').checked = settings.sound;
$('#set-multi').checked = settings.multi;
for (const [id, key, prop] of [['#set-formats', 'formats', 'value'], ['#set-res', 'res', 'value'], ['#set-sound', 'sound', 'checked'], ['#set-multi', 'multi', 'checked']]) {
  $(id).addEventListener('change', (e) => {
    settings[key] = e.target[prop];
    store.set('ls.settings', settings);
  });
}
$('#version').textContent = 'v' + APP_VERSION;

// ---------- Init ----------
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
