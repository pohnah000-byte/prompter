/* Суфлёр — телесуфлёр с записью, ИИ-сценариями, подсказками и пультом */
(() => {
'use strict';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtTime = s => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const fmtSize = b => b >= 1e9 ? (b / 1e9).toFixed(1).replace('.', ',') + ' ГБ'
  : b >= 1e6 ? (b / 1e6).toFixed(b < 1e7 ? 1 : 0).replace('.', ',') + ' МБ'
  : Math.max(1, Math.round(b / 1e3)) + ' КБ';
const fmtDate = ts => { const d = new Date(ts); return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '') + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); };
const WORD_RE = /([\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*)/u;
const countWords = t => (String(t || '').match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) || []).length;
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return n + ' ' + (a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? few : many); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const marked = s => esc(s).replace(/\*([^*\n]+)\*/g, '<mark>$1</mark>');
const norm = w => String(w).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');
const wordsOf = t => String(t || '').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) || [];
const SPEAK_WPM = 130;
const FAMILIES = {
  golos: "'Golos Text', -apple-system, system-ui, sans-serif",
  serif: "ui-serif, 'New York', Georgia, 'Times New Roman', serif",
  system: "-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif"
};
const FORMATS = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
const FORMAT_ORDER = ['9:16', '1:1', '16:9'];
const QUALITY = {
  '720': { size: [1280, 720], bps: 6e6 },
  '1080': { size: [1920, 1080], bps: 12e6 },
  '2160': { size: [3840, 2160], bps: 40e6 }
};
const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const isStandalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
const PEER_SRC = 'vendor/peerjs.min.js?v=1.5.5';
const QR_SRC = 'vendor/qrcode.js?v=1.4.4';

/* script text → html with every word in its own span (voice mode and the second screen follow them) */
function renderScript(text) {
  let html = '';
  for (const part of String(text).split(/(\*[^*\n]+\*)/g)) {
    if (!part) continue;
    const isMark = part.length > 2 && part[0] === '*' && part[part.length - 1] === '*';
    const body = isMark ? part.slice(1, -1) : part;
    let h = '';
    body.split(WORD_RE).forEach((t, i) => { if (t) h += (i % 2) ? '<span class="w">' + esc(t) + '</span>' : esc(t); });
    html += isMark ? '<mark>' + h + '</mark>' : h;
  }
  return html;
}
function autoTitle(text) {
  return String(text).replace(/\*/g, '').trim().split(/\s+/).slice(0, 5).join(' ').replace(/[.,!?;:—-]+$/, '').slice(0, 80) || 'Без названия';
}
const scriptCache = {};
function loadScript(src) {
  return scriptCache[src] || (scriptCache[src] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => res();
    s.onerror = () => { delete scriptCache[src]; s.remove(); rej(new Error('load failed: ' + src)); };
    document.head.append(s);
  }));
}
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}
async function readClipboard() {
  try { if (navigator.clipboard && navigator.clipboard.readText) return await navigator.clipboard.readText(); } catch (e) {}
  return null;
}

/* ---------- toast & confirm ---------- */
let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('top', !$('#stage').hidden || !$('#hStage').hidden || !$('#rcScreen').hidden);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function ask(text, yesLabel = 'Удалить') {
  return new Promise(res => {
    $('#cfText').textContent = text;
    $('#cfYes').textContent = yesLabel;
    $('#confirm').hidden = false;
    const done = v => { $('#confirm').hidden = true; $('#cfYes').onclick = $('#cfNo').onclick = $('#confirm').onclick = null; res(v); };
    $('#cfYes').onclick = () => done(true);
    $('#cfNo').onclick = () => done(false);
    $('#confirm').onclick = e => { if (e.target.id === 'confirm') done(false); };
  });
}

/* ---------- storage: scripts, settings, AI ---------- */
const KEY = 'sufler.v1';
const DEFAULTS = {
  font: 34, lineHeight: 1.4, family: 'golos', align: 'left',
  scrollMode: 'time', voiceLang: 'auto', wpm: 130, panel: 44, dim: 55, marker: true, mirrorText: false,
  facing: 'user', quality: '1080', format: '9:16', mirrorOutput: false, capture: 'video',
  countdown: 3, autoScroll: true, mirrorPreview: true, voiceFx: false
};
const AI_DEF = {
  gemini: { name: 'Gemini', model: 'gemini-3.1-flash-lite', keyUrl: 'https://aistudio.google.com/apikey',
    hint: 'Бесплатный ключ в Google AI Studio. Из России работает только с VPN.' },
  claude: { name: 'Claude', model: 'claude-haiku-5-5', keyUrl: 'https://console.anthropic.com/settings/keys',
    hint: 'Ключ Anthropic, оплата за использование — одна подсказка стоит доли цента. Из России нужен VPN.' },
  openai: { name: 'ChatGPT', model: 'gpt-5-mini', keyUrl: 'https://platform.openai.com/api-keys',
    hint: 'Ключ OpenAI, оплата за использование. Из России нужен VPN.' }
};
const AI_NONE_HINT = 'Сценарии: Суфлёр соберёт запрос, ты вставишь его в Claude или ChatGPT. Подсказкам в разговоре нужен ключ.';
const HINTS_DEF = { topic: '', mode: 'questions', lang: 'ru-RU', font: 34, mirror: false };

function sampleScript() {
  return {
    id: uid(), updated: Date.now(),
    title: 'Пример: как пользоваться',
    text: 'Привет! Это Суфлёр. Текст бежит прямо под камерой, а ты смотришь в объектив.\n\n' +
      'Нажми на текст — он встанет на паузу. Нажми ещё раз — поедет дальше. Его можно тянуть пальцем вверх и вниз.\n\n' +
      'Кнопка с микрофоном включает режим по голосу: текст едет, пока ты говоришь, и ждёт, когда молчишь.\n\n' +
      'Вверху меняется формат кадра, зеркало и пульт со второго телефона. Внизу — видео или фото.\n\n' +
      'Слова в *звёздочках* подсвечиваются — так удобно отмечать главное и паузы.\n\n' +
      'Готовое видео без водяных знаков сохраняется в Фото одной кнопкой.\n\n' +
      'Это пример. Удали его и вставь свой текст.'
  };
}
function normalizeAi(a) {
  a = Object.assign({ provider: 'none', about: '' }, a || {});
  a.keys = Object.assign({ gemini: '', claude: '', openai: '' }, a.keys || {});
  a.models = Object.assign({ gemini: AI_DEF.gemini.model, claude: AI_DEF.claude.model, openai: AI_DEF.openai.model }, a.models || {});
  if (!['none', 'gemini', 'claude', 'openai'].includes(a.provider)) a.provider = 'none';
  return a;
}
function load() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!d || !Array.isArray(d.scripts)) d = { scripts: [sampleScript()], settings: {} };
  d.settings = Object.assign({}, DEFAULTS, d.settings || {});
  if (!QUALITY[d.settings.quality]) d.settings.quality = '1080';
  d.ai = normalizeAi(d.ai);
  d.hints = Object.assign({}, HINTS_DEF, d.hints || {});
  return d;
}
let data = load();
let saveFailedShown = false;
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); }
  catch (e) { if (!saveFailedShown) { saveFailedShown = true; toast('Не получилось сохранить: память браузера недоступна'); } }
}
let saveTimer = 0;
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };
const prefs = {
  get(k) { try { return localStorage.getItem(KEY + '.' + k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(KEY + '.' + k, v); } catch (e) {} }
};
const S = () => data.settings;

/* ---------- storage: takes (IndexedDB) ---------- */
const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    if (!window.indexedDB) { rej(new Error('no indexedDB')); return; }
    const r = indexedDB.open('sufler', 1);
    r.onupgradeneeded = () => { const db = r.result; db.createObjectStore('meta', { keyPath: 'id' }); db.createObjectStore('blobs'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { p = null; rej(r.error); };
  }));
  const run = async (stores, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(stores, mode);
      const req = fn(t);
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = t.onabort = () => rej(t.error);
    });
  };
  return {
    list: () => run(['meta'], 'readonly', t => t.objectStore('meta').getAll()),
    blob: id => run(['blobs'], 'readonly', t => t.objectStore('blobs').get(id)),
    add: (meta, blob) => run(['meta', 'blobs'], 'readwrite', t => { t.objectStore('blobs').put(blob, meta.id); return t.objectStore('meta').put(meta); }),
    update: meta => run(['meta'], 'readwrite', t => t.objectStore('meta').put(meta)),
    remove: id => run(['meta', 'blobs'], 'readwrite', t => { t.objectStore('blobs').delete(id); return t.objectStore('meta').delete(id); })
  };
})();
let takes = [];
async function loadTakes() {
  try { takes = await DB.list(); } catch (e) { takes = []; }
  takes.sort((a, b) => b.created - a.created);
}

/* =====================================================================
   AI: Gemini, Claude, ChatGPT — called straight from the phone with the user's key
   ===================================================================== */
class AiErr extends Error { constructor(msg, status) { super(msg); this.name = 'AiErr'; this.status = status || 0; } }
const aiModelCache = {};
['gemini', 'claude', 'openai'].forEach(p => { try { const v = JSON.parse(prefs.get('models.' + p)); if (Array.isArray(v)) aiModelCache[p] = v; } catch (e) {} });

const aiReady = () => data.ai.provider !== 'none' && !!(data.ai.keys[data.ai.provider] || '').trim();
const aiModel = p => (data.ai.models[p] || AI_DEF[p].model).trim().replace(/^models\//, '');

function aiError(status, body) {
  let msg = '';
  try { const j = JSON.parse(body); msg = (j.error && (j.error.message || j.error.type)) || j.message || ''; } catch (e) { msg = String(body || '').slice(0, 200); }
  const low = msg.toLowerCase();
  if (/location is not supported|unsupported_country|unsupported country|region is not supported|not available in your (country|region)/.test(low))
    return new AiErr('ИИ не работает из твоей страны — включи VPN и попробуй снова', status);
  if (status === 401 || status === 403 || /api key not valid|invalid api key|incorrect api key|invalid x-api-key|authentication/.test(low))
    return new AiErr('Ключ не подошёл. Проверь, что скопировала его целиком', status);
  if (status === 404 || /model.*(not found|does not exist)|not supported for generatecontent|unknown model/.test(low))
    return new AiErr('Нет такой модели. Нажми «Проверить ключ» в Настройках — Суфлёр подберёт модель', status);
  if (/insufficient_quota|credit balance|billing|exceeded your current quota/.test(low))
    return new AiErr('На аккаунте ИИ закончились деньги или лимит', status);
  if (status === 429 || /rate limit|quota/.test(low))
    return new AiErr('Слишком много запросов. Подожди минуту и попробуй снова', status);
  if (status >= 500) return new AiErr('Сервис ИИ сейчас перегружен. Попробуй ещё раз', status);
  return new AiErr('Ошибка ИИ: ' + (msg || 'код ' + status), status);
}

async function readSSE(res, onData) {
  if (!res.body || !res.body.getReader) { const t = await res.text(); t.split('\n').forEach(l => handle(l)); return; }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  function handle(line) {
    line = line.replace(/\r$/, '');
    if (!line.startsWith('data:')) return;
    const s = line.slice(5).trim();
    if (!s || s === '[DONE]') return;
    let d;
    try { d = JSON.parse(s); } catch (e) { return; }
    onData(d);
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  buf += dec.decode();
  if (buf.trim()) handle(buf);
}

function aiFetch(p, key, model, system, user, maxTokens, lean, signal) {
  if (p === 'gemini') {
    const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] };
    if (!lean) body.generationConfig = { thinkingConfig: { thinkingLevel: 'low' } };
    return fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) +
      ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(key),
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  }
  if (p === 'claude') {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: {
        'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, stream: true, messages: [{ role: 'user', content: user }] })
    });
  }
  const body = { model, stream: true, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (!lean) body.reasoning_effort = 'low';
  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(body)
  });
}

/* streams text from the chosen provider; onText gets the whole answer so far */
async function aiStream({ system, user, onText = () => {}, signal, maxTokens = 1500 }) {
  const p = data.ai.provider;
  const key = (data.ai.keys[p] || '').trim();
  if (p === 'none' || !key) throw new AiErr('Сначала подключи ИИ: Настройки → ИИ');
  const model = aiModel(p);
  let attempt = 0, lean = false;
  for (;;) {
    let full = '';
    const emit = piece => { if (!piece) return; full += piece; onText(full); };
    try {
      const res = await aiFetch(p, key, model, system, user, maxTokens, lean, signal);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 400 && !lean && /thinking|reasoning/i.test(body)) { lean = true; continue; }
        throw aiError(res.status, body);
      }
      await readSSE(res, d => {
        if (p === 'gemini') {
          if (d.error) throw aiError(d.error.code || 500, JSON.stringify(d));
          const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
          emit(parts.filter(x => !x.thought).map(x => x.text || '').join(''));
        } else if (p === 'claude') {
          if (d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') emit(d.delta.text);
          else if (d.type === 'error') throw aiError(529, JSON.stringify(d));
        } else {
          if (d.error) throw aiError(500, JSON.stringify(d));
          emit(d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content);
        }
      });
      return full;
    } catch (e) {
      if (e.name === 'AbortError' || (signal && signal.aborted)) { const a = new Error('aborted'); a.name = 'AbortError'; throw a; }
      const transient = e instanceof TypeError || e.status >= 500 || e.status === 429;
      if (!full && attempt === 0 && transient && !/деньги/.test(e.message)) { attempt++; await sleep(1200); continue; }
      if (e instanceof AiErr) throw e;
      if (e instanceof TypeError) throw new AiErr('Нет связи с ИИ. Проверь интернет и VPN');
      throw new AiErr(String(e.message || e));
    }
  }
}

async function aiListModels(p, key) {
  let res;
  try {
    if (p === 'gemini') res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + encodeURIComponent(key));
    else if (p === 'claude') res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } });
    else res = await fetch('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer ' + key } });
  } catch (e) { throw new AiErr('Нет связи с ИИ. Проверь интернет и VPN'); }
  const body = await res.text();
  if (!res.ok) throw aiError(res.status, body);
  let j = {};
  try { j = JSON.parse(body); } catch (e) {}
  let ids = [];
  if (p === 'gemini') {
    ids = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(n => /^gemini/.test(n) && !/(image|tts|live|embedding|audio|native|computer|robotics|vision|aqa|learnlm)/.test(n));
  } else if (p === 'claude') {
    ids = (j.data || []).map(m => m.id).filter(Boolean);
  } else {
    ids = (j.data || []).map(m => m.id).filter(id => /^(gpt-|o\d|chatgpt-)/.test(id) &&
      !/(audio|realtime|transcribe|tts|image|search|embedding|instruct|codex|moderation|vision|computer)/.test(id));
  }
  return Array.from(new Set(ids)).sort().reverse();
}
function pickModel(p, list) {
  const pool0 = list.filter(x => !/(\d{4}-\d{2}-\d{2}|-\d{8})$/.test(x));
  const pool = pool0.length ? pool0 : list;
  const prefs_ = {
    gemini: [/flash-lite(?!.*(preview|exp))/, /flash(?!.*(preview|exp))/, /flash/, /./],
    claude: [/haiku/, /sonnet/, /./],
    openai: [/(mini|luna)/, /nano/, /./]
  }[p];
  for (const re of prefs_) { const m = pool.find(x => re.test(x)); if (m) return m; }
  return pool[0] || AI_DEF[p].model;
}
function cleanAi(t) {
  return String(t || '')
    .replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(хук|hook|призыв|cta|вступление|основная часть|финал)\s*[:—-]\s*/gim, '')
    .replace(/\[(хук|hook|призыв|cta|пауза)[^\]]*\]\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---------- tabs ---------- */
const TABS = ['scripts', 'hints', 'takes', 'settings'];
function showTab(name) {
  if (!TABS.includes(name)) name = 'scripts';
  TABS.forEach(t => { $('#tab-' + t).hidden = t !== name; });
  $$('.tabbar button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === name ? 'page' : 'false'));
  if (name === 'scripts') renderScripts();
  if (name === 'hints') renderHints();
  if (name === 'takes') renderTakes();
  if (name === 'settings') { buildSettings(); renderPreview(); renderAiSettings(); }
  window.scrollTo(0, 0);
  prefs.set('tab', name);
}
$$('.tabbar button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- scripts list ---------- */
const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
function renderScripts() {
  const q = $('#search').value.trim().toLowerCase();
  const all = data.scripts.slice().sort((a, b) => b.updated - a.updated);
  const list = all.filter(s => !q || (s.title + ' ' + s.text).toLowerCase().includes(q));
  const box = $('#scriptList');
  box.innerHTML = '';
  $('#scriptsEmpty').hidden = all.length > 0;
  $('#searchEmpty').hidden = !(all.length && !list.length);
  $('#search').parentElement.hidden = all.length < 2;
  for (const s of list) {
    const w = countWords(s.text);
    const title = s.title || 'Без названия';
    const el = document.createElement('article');
    el.className = 'script';
    const preview = s.text.replace(/\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
    el.innerHTML =
      `<button class="script-open" type="button" data-open="${s.id}"><h3>${esc(title)}</h3>` +
      `<p>${preview ? esc(preview) : 'Пустой сценарий'}</p>` +
      `<span class="meta">${plural(w, 'слово', 'слова', 'слов')} · ≈ ${fmtTime(w / SPEAK_WPM * 60)} · ${fmtDate(s.updated)}</span></button>` +
      `<button class="script-play" type="button" data-play="${s.id}" aria-label="Читать «${esc(title)}»"><span>${PLAY_SVG}</span></button>`;
    box.append(el);
  }
}
$('#scriptList').addEventListener('click', e => {
  const o = e.target.closest('[data-open]'); if (o) { openEditor(o.dataset.open); return; }
  const p = e.target.closest('[data-play]'); if (p) openStage(p.dataset.play);
});
$('#search').addEventListener('input', renderScripts);
$('#newScript').addEventListener('click', () => newScript(true));
$('#newScript2').addEventListener('click', () => newScript(true));
$('#pasteScript').addEventListener('click', pasteNewScript);
$('#aiNewScript').addEventListener('click', () => {
  newScript(false);
  openAiSheet('write');
  $('#aiTopic').focus();
});

if (!isStandalone() && prefs.get('tipHidden') !== '1') $('#installTip').hidden = false;
$('#tipClose').addEventListener('click', () => { $('#installTip').hidden = true; prefs.set('tipHidden', '1'); });

function addScript(title, text) {
  const s = { id: uid(), title: (title || '').trim().slice(0, 120) || autoTitle(text), text: String(text || ''), updated: Date.now() };
  data.scripts.push(s);
  save();
  return s;
}
async function pasteNewScript() {
  const text = await readClipboard();
  if (text && text.trim()) {
    const s = addScript('', text.trim());
    renderScripts();
    openEditor(s.id);
    toast('Сценарий создан из скопированного текста');
    return;
  }
  if (text === null) {
    newScript(false);
    toast('Не получилось прочитать буфер. Нажми в поле текста и выбери «Вставить»', 5000);
  } else {
    toast('В буфере нет текста. Скопируй текст и нажми ещё раз', 3500);
  }
}

/* ---------- editor ---------- */
let editing = null, edTimer = 0;
function newScript(focusTitle) {
  const s = { id: uid(), title: '', text: '', updated: Date.now() };
  data.scripts.push(s);
  save();
  openEditor(s.id);
  if (focusTitle) setTimeout(() => $('#edTitle').focus(), 60);
}
function openEditor(id) {
  editing = data.scripts.find(s => s.id === id);
  if (!editing) return;
  $('#edTitle').value = editing.title;
  $('#edText').value = editing.text;
  updateEdStats();
  $('#editor').hidden = false;
  document.body.classList.add('locked');
  $('#edText').scrollTop = 0;
}
function updateEdStats() {
  const w = countWords($('#edText').value);
  $('#edStats').textContent = plural(w, 'слово', 'слова', 'слов') + ' · ≈ ' + fmtTime(w / SPEAK_WPM * 60) + ' вслух';
}
function onEdit() {
  if (!editing) return;
  editing.title = $('#edTitle').value;
  editing.text = $('#edText').value;
  editing.updated = Date.now();
  updateEdStats();
  clearTimeout(edTimer);
  edTimer = setTimeout(save, 400);
}
function closeEditor() {
  if (!editing) return;
  clearTimeout(edTimer);
  editing.title = editing.title.trim();
  if (!editing.title && !editing.text.trim()) {
    data.scripts = data.scripts.filter(s => s !== editing);
  } else if (!editing.title) {
    editing.title = autoTitle(editing.text);
  }
  save();
  editing = null;
  $('#editor').hidden = true;
  document.body.classList.remove('locked');
  renderScripts();
}
$('#edTitle').addEventListener('input', onEdit);
$('#edText').addEventListener('input', onEdit);
$('#edBack').addEventListener('click', closeEditor);
$('#edAi').addEventListener('click', () => openAiSheet($('#edText').value.trim() ? 'edit' : 'write'));
$('#edGo').addEventListener('click', () => {
  if (!editing) return;
  if (!editing.text.trim()) { toast('Сначала вставь текст'); $('#edText').focus(); return; }
  const id = editing.id;
  closeEditor();
  openStage(id);
});
$('#edDelete').addEventListener('click', async () => {
  if (!editing) return;
  if (!(await ask('Удалить сценарий «' + (editing.title || 'Без названия') + '»? Записи останутся.'))) return;
  data.scripts = data.scripts.filter(s => s !== editing);
  editing = null;
  save();
  $('#editor').hidden = true;
  document.body.classList.remove('locked');
  renderScripts();
});
$('#edFile').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    const t = await f.text();
    const ta = $('#edText');
    ta.value = ta.value.trim() ? ta.value + '\n\n' + t : t;
    if (!$('#edTitle').value.trim()) $('#edTitle').value = f.name.replace(/\.[^.]+$/, '');
    onEdit();
  } catch (err) { toast('Не получилось прочитать файл'); }
  e.target.value = '';
});

/* =====================================================================
   AI script assistant (in the editor)
   ===================================================================== */
const AI_LENS = [[30, '30 сек'], [60, '1 мин'], [90, '1,5 мин'], [180, '3 мин']];
const AI_TONES = [['live', 'Живо'], ['expert', 'Экспертно'], ['fun', 'С юмором'], ['sell', 'Продающе']];
const TONE_TEXT = {
  live: 'живо и по-дружески, как будто рассказываешь подруге',
  expert: 'экспертно, но простыми словами и с конкретикой',
  fun: 'с юмором и самоиронией',
  sell: 'продающе: боль зрителя → решение → призыв'
};
const AI_TASKS = [
  ['shorten', 'Сократить', 'до выбранной длины, смысл сохранится'],
  ['lively', 'Сделать живее', 'разговорнее, без канцелярита'],
  ['hook', 'Усилить начало', 'цепляющий хук в первой фразе'],
  ['accents', 'Расставить акценты', 'главные слова — в *звёздочках*, текст — по абзацам'],
  ['fix', 'Исправить ошибки', 'пунктуация и опечатки, без переписывания']
];
const aiState = {
  tab: 'write', len: +prefs.get('aiLen') || 60, tone: prefs.get('aiTone') || 'live',
  out: '', err: '', running: false, abort: null, last: null, label: '', promptOnly: false
};
const fmtLen = sec => ({ 30: '30 секунд', 60: '1 минута', 90: '1,5 минуты', 180: '3 минуты' }[sec] || sec + ' секунд');
const wordsFor = sec => Math.round(sec * SPEAK_WPM / 60);

function scriptSystem() {
  const about = data.ai.about.trim();
  return [
    'Ты — сценарист коротких видео для блога. Пишешь текст, который человек прочитает с телесуфлёра на камеру.',
    'Правила: от первого лица, разговорно, короткими предложениями. Без заголовков, markdown, хэштегов, эмодзи, ремарок в скобках и пометок вроде «Хук:» или «[Призыв]». Каждый смысловой блок — отдельный абзац, между абзацами пустая строка. 1–2 главных слова в абзаце выдели *звёздочками* — на них человек сделает ударение. Верни только готовый текст.',
    'Пиши на языке запроса.',
    about ? 'Об авторе: ' + about : ''
  ].filter(Boolean).join('\n\n');
}
function writeUser(topic) {
  const sec = aiState.len;
  return 'Напиши сценарий ролика.\n' +
    'Тема: ' + topic + '\n' +
    'Длина: около ' + wordsFor(sec) + ' слов (≈ ' + fmtLen(sec) + ' вслух).\n' +
    'Тон: ' + TONE_TEXT[aiState.tone] + '.\n' +
    ($('#aiHook').checked ? 'Первая фраза — сильный хук: вопрос, смелое утверждение или неожиданный факт, чтобы зритель не пролистал первые 3 секунды.\n' : '') +
    'В конце — короткий призыв одной фразой: подписаться, написать в комментариях или сохранить.';
}
function editUser(task, text) {
  const map = {
    shorten: 'Сократи текст примерно до ' + wordsFor(aiState.len) + ' слов (≈ ' + fmtLen(aiState.len) + ' вслух). Сохрани главную мысль, хук и призыв.',
    lively: 'Сделай текст разговорнее и живее, как будто рассказываешь подруге. Убери канцелярит и длинные обороты, смысл не меняй.',
    hook: 'Перепиши только начало: первая фраза должна стать сильным хуком. Остальной текст оставь почти без изменений.',
    accents: 'Не меняй слова. Только раздели текст на короткие абзацы по смыслу и выдели *звёздочками* 1–2 главных слова в каждом абзаце.',
    fix: 'Исправь пунктуацию, опечатки и грамматику. Ничего не переписывай и не добавляй.'
  };
  return map[task] + '\n\nТекст:\n<<<\n' + text + '\n>>>';
}

function buildAiSheet() {
  $$('.ai-len').forEach(seg => {
    seg.innerHTML = AI_LENS.map(([v, l]) => `<button type="button" role="radio" data-len="${v}">${l}</button>`).join('');
  });
  $('#aiTone').innerHTML = AI_TONES.map(([v, l]) => `<button type="button" role="radio" data-tone="${v}">${l}</button>`).join('');
  $('#aiActions').innerHTML = AI_TASKS.map(([v, l, s]) => `<button type="button" data-task="${v}"><span data-label>${l}</span><small>${s}</small></button>`).join('');
}
function renderAiSheet() {
  $$('#aiTabs button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.aiTab === aiState.tab)));
  $('#aiWrite').hidden = aiState.tab !== 'write';
  $('#aiEdit').hidden = aiState.tab !== 'edit';
  $$('.ai-len button').forEach(b => b.setAttribute('aria-checked', String(+b.dataset.len === aiState.len)));
  $$('#aiTone button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.tone === aiState.tone)));
  const shortLabel = AI_LENS.find(x => x[0] === aiState.len);
  const sb = $('#aiActions [data-task="shorten"] [data-label]');
  if (sb) sb.textContent = 'Сократить до ' + (shortLabel ? shortLabel[1] : aiState.len + ' сек');
  $('#aiGoWrite').textContent = aiReady() ? 'Написать сценарий' : 'Скопировать запрос для ИИ';
}
function openAiSheet(tab) {
  if (!editing) return;
  aiState.tab = tab;
  aiState.out = ''; aiState.err = ''; aiState.promptOnly = false;
  $('#aiOut').hidden = true;
  $('#aiNoKey').hidden = true;
  renderAiSheet();
  $('#aiSheet').hidden = false;
}
function closeAiSheet() {
  if (aiState.abort) aiState.abort.abort();
  $('#aiSheet').hidden = true;
}
function renderOut() {
  const box = $('#aiOutText');
  $('#aiOut').hidden = false;
  $('#aiOutLabel').textContent = aiState.label || 'Результат';
  box.classList.toggle('err', !!aiState.err);
  box.classList.toggle('wait', !aiState.err && !aiState.out);
  box.textContent = aiState.err || aiState.out || (aiState.running ? 'Пишу…' : '');
  const w = countWords(aiState.out);
  $('#aiOutStats').textContent = aiState.out && !aiState.promptOnly ? plural(w, 'слово', 'слова', 'слов') + ' · ≈ ' + fmtTime(w / SPEAK_WPM * 60) : '';
  $('#aiOutBtns').hidden = aiState.promptOnly;
  $('#aiReplace').disabled = $('#aiAppend').disabled = aiState.running || !aiState.out;
  $('#aiRetry').hidden = aiState.promptOnly || (!aiState.running && !aiState.last);
  $('#aiRetry').textContent = aiState.running ? 'Остановить' : 'Ещё вариант';
  if (aiState.running) box.scrollTop = box.scrollHeight;
}
async function runAi(req) {
  aiState.last = req;
  if (!aiReady()) {
    const full = req.system + '\n\n' + req.user;
    const ok = await copyText(full);
    $('#aiNoKey').hidden = false;
    $('#aiNoKey b').textContent = ok ? 'Запрос скопирован.' : 'Скопируй запрос ниже.';
    if (!ok) { aiState.promptOnly = true; aiState.err = ''; aiState.out = full; aiState.label = 'Запрос для ИИ'; renderOut(); }
    else { aiState.promptOnly = false; $('#aiOut').hidden = true; }
    toast(ok ? 'Запрос скопирован — вставь его в Claude или ChatGPT' : 'Не получилось скопировать — выдели запрос вручную', 3500);
    setTimeout(() => $('#aiNoKey').scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
    return;
  }
  if (aiState.abort) aiState.abort.abort();
  const ctrl = new AbortController();
  Object.assign(aiState, { abort: ctrl, running: true, out: '', err: '', label: req.label, promptOnly: false });
  $('#aiNoKey').hidden = true;
  renderOut();
  $('#aiOut').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  try {
    const full = await aiStream({
      system: req.system, user: req.user, signal: ctrl.signal, maxTokens: 2000,
      onText: t => { if (aiState.abort === ctrl) { aiState.out = cleanAi(t); renderOut(); } }
    });
    if (aiState.abort === ctrl) aiState.out = cleanAi(full);
  } catch (e) {
    if (e.name !== 'AbortError' && aiState.abort === ctrl) aiState.err = e.message || 'Ошибка ИИ';
  }
  if (aiState.abort === ctrl) { aiState.abort = null; aiState.running = false; renderOut(); }
}
buildAiSheet();
$('#aiClose').addEventListener('click', closeAiSheet);
$('#aiSheet').addEventListener('click', e => { if (e.target.id === 'aiSheet') closeAiSheet(); });
$('#aiTabs').addEventListener('click', e => { const b = e.target.closest('[data-ai-tab]'); if (b) { aiState.tab = b.dataset.aiTab; renderAiSheet(); } });
$$('.ai-len').forEach(seg => seg.addEventListener('click', e => {
  const b = e.target.closest('[data-len]'); if (!b) return;
  aiState.len = +b.dataset.len; prefs.set('aiLen', aiState.len); renderAiSheet();
}));
$('#aiTone').addEventListener('click', e => {
  const b = e.target.closest('[data-tone]'); if (!b) return;
  aiState.tone = b.dataset.tone; prefs.set('aiTone', aiState.tone); renderAiSheet();
});
$('#aiGoWrite').addEventListener('click', () => {
  const topic = $('#aiTopic').value.trim();
  if (!topic) { toast('Напиши, о чём ролик'); $('#aiTopic').focus(); return; }
  runAi({ kind: 'write', topic, label: 'Сценарий', system: scriptSystem(), user: writeUser(topic) });
});
$('#aiActions').addEventListener('click', e => {
  const b = e.target.closest('[data-task]'); if (!b) return;
  const text = $('#edText').value.trim();
  if (!text) { toast('В сценарии пока нет текста'); return; }
  const t = AI_TASKS.find(x => x[0] === b.dataset.task);
  runAi({ kind: 'edit', label: t ? t[1] : 'Результат', system: scriptSystem(), user: editUser(b.dataset.task, text) });
});
$('#aiRetry').addEventListener('click', () => {
  if (aiState.running) { if (aiState.abort) aiState.abort.abort(); aiState.abort = null; aiState.running = false; renderOut(); return; }
  if (aiState.last) runAi(aiState.last);
});
$('#aiPaste').addEventListener('click', async () => {
  const t = await readClipboard();
  if (!t || !t.trim()) { toast(t === null ? 'Не получилось прочитать буфер — вставь ответ прямо в текст сценария' : 'В буфере нет текста — скопируй ответ ИИ', 4000); return; }
  Object.assign(aiState, { out: cleanAi(t), err: '', promptOnly: false, running: false, label: 'Ответ ИИ' });
  renderOut();
});
function applyAi(mode) {
  if (!editing || !aiState.out) return;
  const ta = $('#edText');
  ta.value = mode === 'append' && ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n\n' + aiState.out : aiState.out;
  if (!$('#edTitle').value.trim() && aiState.last && aiState.last.kind === 'write') $('#edTitle').value = autoTitle(aiState.last.topic);
  onEdit();
  closeAiSheet();
  toast(mode === 'append' ? 'Добавлено в конец' : 'Текст обновлён');
}
$('#aiReplace').addEventListener('click', () => applyAi('replace'));
$('#aiAppend').addEventListener('click', () => applyAi('append'));

/* =====================================================================
   Prompter stage
   ===================================================================== */
const st = {
  script: null, offset: 0, max: 0, playing: false, last: 0, raf: 0,
  pps: 30, cpw: 6.5, sample: '', lineH: 48, H: 0, markerY: 0, lang: 'ru-RU', showText: true,
  stream: null, rec: null, chunks: [], recStart: 0, recEnd: 0, recFormat: '9:16', recSize: null,
  thumb: '', thumbTimer: 0, wake: null, drag: null, busy: false, cdTimer: 0, cdResolve: null, statusAt: 0
};
const cam = $('#cam');
const measureCtx = document.createElement('canvas').getContext('2d');
const isVoice = () => S().scrollMode === 'voice';

function textStats(text) {
  const clean = text.replace(/\*/g, '');
  const w = countWords(clean);
  const flat = clean.replace(/\s+/g, ' ').trim();
  st.cpw = w ? flat.length / w : 6.5;
  st.sample = flat.slice(0, 900) || 'Пример текста для замера ширины строки';
  const cyr = (clean.match(/[а-яё]/gi) || []).length;
  const lat = (clean.match(/[a-z]/gi) || []).length;
  st.lang = lat > cyr ? 'en-US' : 'ru-RU';
}
function previewMirrored() {
  const s = S();
  return !!s.mirrorOutput || (s.facing === 'user' && s.mirrorPreview);
}
function layoutFrame() {
  const s = S();
  const ar = FORMATS[s.format] || FORMATS['9:16'];
  const W = window.innerWidth, H = window.innerHeight;
  const fw = Math.min(W, H * ar);
  const f = $('#frame');
  f.style.width = Math.round(fw) + 'px';
  f.style.height = Math.round(fw / ar) + 'px';
  $('#fmtBtn').textContent = s.format;
  $('#fmtBtn').setAttribute('aria-label', 'Формат кадра ' + s.format + ', нажми, чтобы сменить');
  cam.classList.toggle('mirror', previewMirrored());
  $('#mirBtn').setAttribute('aria-pressed', String(!!s.mirrorOutput));
}
function layoutStage() {
  if ($('#stage').hidden) return;
  const s = S();
  layoutFrame();
  const progress = st.max ? st.offset / st.max : 0;
  const panel = $('#panel'), pt = $('#ptext');
  panel.style.height = Math.round(window.innerHeight * s.panel / 100) + 'px';
  panel.style.setProperty('--dim', s.dim / 100);
  panel.style.visibility = st.showText ? '' : 'hidden';
  pt.style.fontSize = s.font + 'px';
  pt.style.lineHeight = s.lineHeight;
  pt.style.fontFamily = FAMILIES[s.family] || FAMILIES.golos;
  pt.style.textAlign = s.align;
  $('#mirrorBox').style.transform = s.mirrorText ? 'scaleX(-1)' : '';
  $('#marker').hidden = !s.marker;

  st.H = $('#viewport').clientHeight;
  st.lineH = s.font * s.lineHeight;
  st.markerY = Math.round(clamp(st.H * 0.26, st.lineH * 0.9, st.lineH * 2.4));
  pt.style.paddingTop = st.markerY + 'px';
  pt.style.paddingBottom = Math.max(0, st.H - st.markerY - st.lineH) + 'px';
  $('#marker').style.top = (st.markerY + st.lineH / 2) + 'px';

  // reading pace: words per minute → pixels per second for this font and width
  const cs = getComputedStyle(pt);
  const innerW = pt.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  measureCtx.font = `500 ${s.font}px ${pt.style.fontFamily}`;
  const avgChar = measureCtx.measureText(st.sample).width / st.sample.length || s.font * 0.55;
  const cpl = Math.max(4, (innerW / avgChar) * 0.92);
  st.pps = (s.wpm / 60) * st.cpw * st.lineH / cpl;

  st.max = Math.max(0, pt.offsetHeight - st.H);
  measureWords();
  if (isVoice()) { updateVoiceTarget(); st.offset = voice.target; }
  else st.offset = clamp(progress * st.max, 0, st.max);
  applyOffset();
  updateSteppers();
  updateModeUI();
  updateStatus();
}
function applyOffset() {
  $('#ptext').style.transform = 'translate3d(0,' + (-st.offset).toFixed(1) + 'px,0)';
  $('#endNote').hidden = !(st.max > 0 && st.offset >= st.max - 0.5);
}
function setPlaying(on) {
  st.playing = !!on;
  updatePlayBtn();
}
function updatePlayBtn() {
  const b = $('#stPlay');
  const on = isVoice() ? voice.on : st.playing;
  b.classList.toggle('on', on);
  b.setAttribute('aria-label', isVoice() ? (on ? 'Перестать слушать' : 'Слушать голос') : (on ? 'Пауза' : 'Пустить текст'));
}
function togglePlay() {
  if (isVoice()) { voice.on ? stopListening() : startListening(); return; }
  if (!st.playing && st.offset >= st.max - 0.5) { st.offset = 0; applyOffset(); }
  setPlaying(!st.playing);
}
function nudge(lines) {
  st.offset = clamp(st.offset + st.lineH * lines, 0, st.max);
  if (isVoice()) { cursorFromOffset(); voice.target = st.offset; }
  applyOffset();
  updateStatus();
}
function restartText() {
  st.offset = 0;
  if (isVoice()) setCursor(0);
  applyOffset();
  updateStatus();
}
function loop(t) {
  st.raf = requestAnimationFrame(loop);
  const dt = st.last ? Math.min(0.1, (t - st.last) / 1000) : 0;
  st.last = t;
  if (!st.drag) {
    if (isVoice()) {
      const d = voice.target - st.offset;
      if (Math.abs(d) > 0.4) { st.offset += d * Math.min(1, dt * 5); applyOffset(); }
    } else if (st.playing) {
      st.offset += st.pps * dt;
      if (st.offset >= st.max) { st.offset = st.max; setPlaying(false); }
      applyOffset();
    }
  }
  if (t - st.statusAt > 250) { st.statusAt = t; updateStatus(); }
  if (RH.clients.size && t - RH.sentAt > 100) { RH.sentAt = t; hostTick(); }
}
function updateStatus() {
  const pill = $('#stStatus'), txt = $('#stStatusText');
  pill.classList.toggle('is-rec', !!st.rec);
  pill.classList.toggle('is-voice', !st.rec && isVoice() && voice.on);
  if (st.rec) txt.textContent = fmtTime((Date.now() - st.recStart) / 1000);
  else if (isVoice()) txt.textContent = voice.on ? 'Слушаю' : 'Голос: нажми ▶';
  else if (!st.max) txt.textContent = 'Готов';
  else if (st.offset >= st.max - 0.5) txt.textContent = 'Конец текста';
  else txt.textContent = '≈ ' + fmtTime((st.max - st.offset) / st.pps) + ' до конца';
}
function updateSteppers() {
  $('#spVal').textContent = S().wpm;
  $('#fsVal').textContent = S().font;
}
function updateModeUI() {
  const s = S();
  $('#micBtn').setAttribute('aria-pressed', String(isVoice()));
  $('#speedStepper').hidden = isVoice();
  const photo = s.capture === 'photo';
  $$('#modeRow button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === s.capture)));
  const rb = $('#recBtn');
  rb.classList.toggle('photo', photo && !st.rec);
  rb.setAttribute('aria-label', st.rec ? 'Остановить запись' : photo ? 'Сделать фото' : 'Начать запись');
  const lock = !!(st.rec || st.busy);
  ['#fmtBtn', '#mirBtn', '#stFlip'].forEach(q => { $(q).disabled = lock; });
  $$('#modeRow button').forEach(b => { b.disabled = lock; });
  $('#rmBtn').setAttribute('aria-pressed', String(RH.clients.size > 0));
  updatePlayBtn();
}
function changeWpm(d) {
  S().wpm = clamp(S().wpm + d, 60, 300);
  save();
  layoutStage();
}
function changeFont(d) {
  S().font = clamp(S().font + d, 20, 72);
  save();
  layoutStage();
}

/* ---------- voice follow ---------- */
const voice = { rec: null, on: false, words: [], ys: [], cur: 0, target: 0, restartTimer: 0 };
function buildWords() {
  voice.words = $$('#ptext .w').map(el => ({ el, n: norm(el.textContent) }));
  voice.cur = 0;
}
function measureWords() {
  voice.ys = voice.words.map(w => w.el.offsetTop);
}
function updateVoiceTarget() {
  const n = voice.words.length;
  if (!n) { voice.target = 0; return; }
  if (voice.cur >= n) { voice.target = st.max; return; }
  voice.target = clamp(voice.ys[voice.cur] - st.markerY, 0, st.max);
}
function setCursor(i) {
  const W = voice.words;
  i = clamp(i, 0, W.length);
  const old = voice.cur;
  if (i > old) for (let k = old; k < i; k++) W[k].el.classList.add('said');
  else for (let k = i; k < old; k++) W[k].el.classList.remove('said');
  voice.cur = i;
  updateVoiceTarget();
}
function clearSaid() {
  voice.words.forEach(w => w.el.classList.remove('said'));
}
function cursorFromOffset() {
  const y = st.offset + st.markerY - st.lineH * 0.5;
  let i = voice.ys.findIndex(v => v >= y);
  if (i < 0) i = voice.words.length;
  setCursor(i);
}
function similar(a, b) {
  if (a === b) return true;
  const m = Math.min(a.length, b.length);
  if (m <= 3) return false;
  let p = 0;
  while (p < m && a[p] === b[p]) p++;
  return p >= Math.min(5, m - 1);
}
function voiceMatch(spoken) {
  const W = voice.words, n = W.length;
  if (!n || !spoken.length) return;
  const last = spoken[spoken.length - 1];
  const prev = spoken.slice(0, -1).reverse();
  const from = Math.max(0, voice.cur - 3), to = Math.min(n - 1, voice.cur + 30);
  let best = -1, bestScore = -1;
  for (let j = from; j <= to; j++) {
    if (!similar(last, W[j].n)) continue;
    let score = 1, k = j - 1;
    for (const pw of prev) {
      for (let s = k; s >= Math.max(0, k - 2); s--) {
        if (similar(pw, W[s].n)) { score++; k = s - 1; break; }
      }
    }
    score -= Math.abs(j - voice.cur) * 0.03;
    if (score > bestScore) { bestScore = score; best = j; }
  }
  if (best < 0) return;
  const near = best - voice.cur <= 2 && best - voice.cur >= -1;
  const ok = prev.length >= 2 ? (bestScore >= 1.9 || (near && bestScore >= 0.9)) : bestScore >= 0.85;
  if (ok && best + 1 !== voice.cur) setCursor(best + 1);
}
function startListening() {
  if (!SR) { toast('Распознавание речи недоступно. На iPhone включи Siri и диктовку и открой Суфлёр в Safari', 5000); return false; }
  if (voice.on) return true;
  if (H.on) hintsStop();
  const r = new SR();
  r.lang = S().voiceLang === 'auto' ? st.lang : S().voiceLang;
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;
  r.onresult = e => {
    let txt = '';
    for (let i = Math.max(0, e.results.length - 3); i < e.results.length; i++) txt += ' ' + e.results[i][0].transcript;
    const words = txt.split(/\s+/).map(norm).filter(Boolean);
    voiceMatch(words.slice(-6));
  };
  r.onerror = e => {
    const err = e && e.error;
    if (err === 'no-speech' || err === 'aborted') return;
    stopListening();
    if (err === 'not-allowed' || err === 'service-not-allowed') toast('Нет доступа к распознаванию речи. Включи Siri и диктовку: Настройки → Siri; и разреши Safari распознавание речи', 6000);
    else if (err === 'network') toast('Для режима по голосу нужен интернет', 4000);
    else if (err === 'audio-capture') toast('Микрофон занят — режим по голосу не запустился', 4000);
    else toast('Распознавание речи остановилось. Нажми ▶, чтобы продолжить', 4000);
  };
  r.onend = () => {
    if (!voice.on || voice.rec !== r) return;
    clearTimeout(voice.restartTimer);
    voice.restartTimer = setTimeout(() => {
      if (!voice.on || voice.rec !== r) return;
      try { r.start(); } catch (err) { voice.on = false; voice.rec = null; updatePlayBtn(); updateStatus(); }
    }, 150);
  };
  voice.rec = r;
  voice.on = true;
  try { r.start(); }
  catch (e) { voice.on = false; voice.rec = null; toast('Не получилось включить распознавание речи'); updatePlayBtn(); return false; }
  updatePlayBtn();
  updateStatus();
  return true;
}
function stopListening() {
  voice.on = false;
  clearTimeout(voice.restartTimer);
  const r = voice.rec;
  voice.rec = null;
  if (r) { r.onend = null; r.onresult = null; try { r.abort(); } catch (e) {} }
  updatePlayBtn();
  updateStatus();
}
function setScrollMode(m) {
  if (m === 'voice' && !SR) { toast('Распознавание речи недоступно в этом браузере. На iPhone открой Суфлёр в Safari', 4500); return; }
  stopListening();
  setPlaying(false);
  S().scrollMode = m;
  save();
  if (m === 'voice') cursorFromOffset(); else clearSaid();
  updateModeUI();
  updateStatus();
}

/* drag & tap on text */
const vp = $('#viewport');
vp.addEventListener('pointerdown', e => {
  st.drag = { y: e.clientY, o: st.offset, moved: false };
  try { vp.setPointerCapture(e.pointerId); } catch (err) {}
});
vp.addEventListener('pointermove', e => {
  if (!st.drag) return;
  const dy = e.clientY - st.drag.y;
  if (Math.abs(dy) > 7) st.drag.moved = true;
  if (st.drag.moved) { st.offset = clamp(st.drag.o - dy, 0, st.max); applyOffset(); updateStatus(); }
});
vp.addEventListener('pointerup', () => {
  const d = st.drag;
  st.drag = null;
  if (!d) return;
  if (!d.moved) togglePlay();
  else if (isVoice()) { cursorFromOffset(); voice.target = st.offset; }
});
vp.addEventListener('pointercancel', () => { st.drag = null; });

/* controls */
$('#spDown').addEventListener('click', () => changeWpm(-10));
$('#spUp').addEventListener('click', () => changeWpm(10));
$('#fsDown').addEventListener('click', () => changeFont(-2));
$('#fsUp').addEventListener('click', () => changeFont(2));
$('#stPlay').addEventListener('click', togglePlay);
$('#micBtn').addEventListener('click', () => {
  if (isVoice()) { setScrollMode('time'); toast('Текст едет по темпу'); }
  else { setScrollMode('voice'); if (isVoice() && startListening()) toast('Говори — текст поедет за голосом'); }
});
$('#stRestart').addEventListener('click', restartText);
$('#stClose').addEventListener('click', closeStage);
$('#stFlip').addEventListener('click', () => {
  if (st.rec || st.busy) return;
  S().facing = S().facing === 'user' ? 'environment' : 'user';
  save();
  openCamera();
});
$('#fmtBtn').addEventListener('click', () => {
  if (st.rec || st.busy) return;
  const s = S();
  s.format = FORMAT_ORDER[(FORMAT_ORDER.indexOf(s.format) + 1) % FORMAT_ORDER.length];
  save();
  layoutStage();
  const portrait = window.innerHeight > window.innerWidth;
  toast('Формат ' + s.format + (s.format === '16:9' && portrait ? ' — поверни телефон, так кадр будет крупнее' : ''), 2600);
});
$('#mirBtn').addEventListener('click', () => {
  if (st.rec || st.busy) return;
  S().mirrorOutput = !S().mirrorOutput;
  save();
  layoutFrame();
  toast(S().mirrorOutput ? 'Видео и фото сохранятся зеркально' : 'Зеркало выключено');
});
function setCapture(mode) {
  if (st.rec || st.busy || (mode !== 'video' && mode !== 'photo')) return;
  S().capture = mode;
  save();
  updateModeUI();
}
$$('#modeRow button').forEach(b => b.addEventListener('click', () => setCapture(b.dataset.mode)));
$('#recBtn').addEventListener('click', recToggle);
$('#camRetry').addEventListener('click', openCamera);
$('#rmBtn').addEventListener('click', openRemoteSheet);

function loadStageScript(s) {
  st.script = s;
  st.offset = 0; st.max = 0;
  setPlaying(false);
  $('#ptext').innerHTML = s.text.trim() ? renderScript(s.text) : '<span class="muted">Сценарий пустой. Вернись и вставь текст.</span>';
  buildWords();
  textStats(s.text);
  voice.target = 0;
  layoutStage();
  hostHelloAll();
}
function openStage(id) {
  const s = data.scripts.find(x => x.id === id);
  if (!s) return;
  if (H.on) hintsStop();
  $('#stage').hidden = false;
  document.body.classList.add('locked');
  st.showText = true;
  loadStageScript(s);
  openCamera();
  keepAwake(true);
  st.last = 0;
  cancelAnimationFrame(st.raf);
  st.raf = requestAnimationFrame(loop);
  if (prefs.get('remoteOn') === '1') hostStart();
}
function closeStage() {
  if (st.busy) cancelCountdown();
  if (st.rec) stopRec();
  stopListening();
  setPlaying(false);
  cancelAnimationFrame(st.raf);
  hostStop(true);
  $('#remoteSheet').hidden = true;
  stopCamera();
  keepAwake(false);
  $('#stage').hidden = true;
  $('#camMsg').hidden = true;
  if ($('#review').hidden) document.body.classList.remove('locked');
  renderScripts();
}
window.addEventListener('resize', () => { layoutStage(); if (!$('#rcScreen').hidden) rcLayout(); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { layoutStage(); if (!$('#rcScreen').hidden) rcLayout(); });

/* ---------- camera ---------- */
function camMessage(text) {
  $('#camMsgText').textContent = text;
  $('#camMsg').hidden = !text;
}
async function openCamera() {
  stopCamera();
  camMessage('');
  if (!window.isSecureContext) { camMessage('Камера работает только по ссылке https://. Открой Суфлёр с сайта, а не из файла.'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camMessage('Этот браузер не даёт доступ к камере. Открой Суфлёр в Safari.'); return; }
  const s = S();
  const q = QUALITY[s.quality] || QUALITY['1080'];
  const audio = s.voiceFx
    ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    : { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: s.facing, width: { ideal: q.size[0] }, height: { ideal: q.size[1] }, frameRate: { ideal: 30 } },
      audio
    });
  } catch (e) {
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: s.facing }, audio: true }); }
    catch (e2) {
      camMessage(e2 && e2.name === 'NotAllowedError'
        ? 'Нет доступа к камере и микрофону. На iPhone: Настройки → Safari → Камера и Микрофон → «Разрешить». Потом нажми кнопку ниже.'
        : 'Камера не включилась. Закрой другие приложения с камерой и попробуй снова.');
      return;
    }
  }
  if ($('#stage').hidden) { stream.getTracks().forEach(t => t.stop()); return; }
  st.stream = stream;
  const a = stream.getAudioTracks()[0];
  if (a) a.onmute = () => {
    if (st.rec && voice.on) {
      stopListening();
      toast('iPhone отдал микрофон распознаванию — выключила голос, чтобы в видео был звук. Текст поедет по темпу', 6000);
      setScrollMode('time');
      setPlaying(true);
    }
  };
  cam.onloadedmetadata = () => { cam.onloadedmetadata = null; reportResolution(); };
  cam.srcObject = stream;
  layoutFrame();
  try { await cam.play(); } catch (e) {}
}
function reportResolution() {
  const w = cam.videoWidth, h = cam.videoHeight;
  if (!w || S().quality !== '2160') return;
  if (Math.max(w, h) >= 3000) toast('4K включено · ' + w + '×' + h);
  else toast('Камера отдала ' + w + '×' + h + ' — 4K в браузере для неё недоступно', 4500);
}
function stopCamera() {
  if (st.stream) { st.stream.getTracks().forEach(t => t.stop()); st.stream = null; }
  cam.srcObject = null;
}
function cameraAlive() {
  if (!st.stream) return false;
  const v = st.stream.getVideoTracks()[0];
  return !!v && v.readyState === 'live';
}
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      st.wake = await navigator.wakeLock.request('screen');
    } else if (!on && st.wake) { await st.wake.release(); st.wake = null; }
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && H.on) hintsStop();
  if ($('#stage').hidden) return;
  if (document.visibilityState === 'hidden') {
    if (st.busy) cancelCountdown();
    if (st.rec) stopRec();
    stopListening();
    setPlaying(false);
  } else {
    keepAwake(true);
    if (!cameraAlive()) openCamera();
  }
});

/* ---------- framing: crop to format + mirror ---------- */
function cropRect(vw, vh, ar) {
  let cw, ch;
  if (vw / vh > ar) { ch = vh; cw = vh * ar; } else { cw = vw; ch = vw / ar; }
  return { sx: (vw - cw) / 2, sy: (vh - ch) / 2, cw, ch };
}
function drawFrame(ctx, w, h, mirror) {
  const vw = cam.videoWidth, vh = cam.videoHeight;
  if (!vw || !vh) return false;
  const r = cropRect(vw, vh, w / h);
  ctx.save();
  if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(cam, r.sx, r.sy, r.cw, r.ch, 0, 0, w, h);
  ctx.restore();
  return true;
}
function outputSize(format) {
  const r = cropRect(cam.videoWidth, cam.videoHeight, FORMATS[format]);
  let w = Math.round(r.cw), h = Math.round(r.ch);
  w -= w % 2; h -= h % 2;
  return { w, h };
}
function needsPipeline() {
  if (!cam.videoWidth) return false;
  const native = cam.videoWidth / cam.videoHeight;
  return !!S().mirrorOutput || Math.abs(native - FORMATS[S().format]) > 0.01;
}
const pipe = { on: false, stream: null, raf: 0, vfc: 0 };
function startPipeline() {
  const c = $('#recCanvas');
  if (!c.captureStream) throw new Error('captureStream not supported');
  const { w, h } = outputSize(S().format);
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const mirror = !!S().mirrorOutput;
  pipe.on = true;
  const step = () => {
    if (!pipe.on) return;
    drawFrame(ctx, w, h, mirror);
    if (cam.requestVideoFrameCallback) pipe.vfc = cam.requestVideoFrameCallback(step);
    else pipe.raf = requestAnimationFrame(step);
  };
  step();
  pipe.stream = c.captureStream(30);
  st.recSize = { w, h };
  return new MediaStream([...pipe.stream.getVideoTracks(), ...st.stream.getAudioTracks()]);
}
function stopPipeline() {
  pipe.on = false;
  cancelAnimationFrame(pipe.raf);
  if (pipe.vfc && cam.cancelVideoFrameCallback) { try { cam.cancelVideoFrameCallback(pipe.vfc); } catch (e) {} }
  if (pipe.stream) pipe.stream.getVideoTracks().forEach(t => t.stop());
  pipe.stream = null;
}

/* ---------- recording ---------- */
function pickMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  const list = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {} }
  return '';
}
function countdown(n) {
  return new Promise(res => {
    const box = $('#countdown'), num = $('#cdNum');
    let i = n;
    box.hidden = false;
    st.cdResolve = res;
    const tick = () => {
      if (i === 0) { box.hidden = true; st.cdResolve = null; res(true); return; }
      num.textContent = i;
      num.classList.remove('pop'); void num.offsetWidth; num.classList.add('pop');
      i--;
      st.cdTimer = setTimeout(tick, 1000);
    };
    tick();
  });
}
function cancelCountdown() {
  clearTimeout(st.cdTimer);
  $('#countdown').hidden = true;
  if (st.cdResolve) { const r = st.cdResolve; st.cdResolve = null; r(false); }
}
$('#countdown').addEventListener('click', cancelCountdown);

function recToggle() {
  if (st.busy) return;
  if (st.rec) { stopRec(); return; }
  if (S().capture === 'photo') takePhoto(); else startRec();
}
async function startRec() {
  if (!cameraAlive()) { toast('Камера не включена'); openCamera(); return; }
  if (!window.MediaRecorder) { toast('Этот браузер не умеет записывать видео. Нужен iOS 14.5 или новее'); return; }
  // voice recognition must start inside the tap itself
  if (isVoice() && S().autoScroll) startListening();
  st.busy = true;
  setPlaying(false);
  if (!isVoice() && st.offset >= st.max - 0.5) { st.offset = 0; applyOffset(); }
  updateModeUI();
  const n = +S().countdown;
  if (n > 0) {
    const go = await countdown(n);
    if (!go || !cameraAlive()) { st.busy = false; updateModeUI(); return; }
  }
  let source = st.stream;
  st.recSize = { w: cam.videoWidth, h: cam.videoHeight };
  if (needsPipeline()) {
    try { source = startPipeline(); }
    catch (e) { stopPipeline(); source = st.stream; st.recSize = { w: cam.videoWidth, h: cam.videoHeight }; toast('Формат и зеркало не применились — запишу кадр как есть', 4000); }
  }
  const mime = pickMime();
  const q = QUALITY[S().quality] || QUALITY['1080'];
  const opts = { videoBitsPerSecond: q.bps, audioBitsPerSecond: 128000 };
  if (mime) opts.mimeType = mime;
  let rec;
  try { rec = new MediaRecorder(source, opts); }
  catch (e) {
    try { rec = new MediaRecorder(source); }
    catch (e2) { stopPipeline(); toast('Не получилось начать запись'); st.busy = false; updateModeUI(); return; }
  }
  st.chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) st.chunks.push(e.data); };
  rec.onstop = () => finishRec(rec);
  try { rec.start(1000); }
  catch (e) { stopPipeline(); toast('Не получилось начать запись'); st.busy = false; updateModeUI(); return; }
  st.rec = rec;
  st.recStart = Date.now();
  st.recFormat = S().format;
  st.thumb = '';
  clearTimeout(st.thumbTimer);
  st.thumbTimer = setTimeout(() => { st.thumb = grabThumb(); }, 900);
  $('#stage').classList.add('recording');
  if (!isVoice() && S().autoScroll) setPlaying(true);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  st.busy = false;
  updateModeUI();
  updateStatus();
  hostSendState(true);
}
function stopRec() {
  const rec = st.rec;
  if (!rec) return;
  st.recEnd = Date.now();
  if (!st.thumb) st.thumb = grabThumb();
  clearTimeout(st.thumbTimer);
  setPlaying(false);
  stopListening();
  try { if (rec.state !== 'inactive') rec.stop(); else finishRec(rec); } catch (e) { finishRec(rec); }
}
function makeThumb(format) {
  if (!cam.videoWidth) return '';
  const ar = FORMATS[format] || FORMATS['9:16'];
  const w = ar >= 1 ? 360 : 270, h = Math.round(w / ar);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  try { drawFrame(c.getContext('2d'), w, h, !!S().mirrorOutput); return c.toDataURL('image/jpeg', 0.72); } catch (e) { return ''; }
}
function grabThumb() { return makeThumb(st.recFormat || S().format); }
async function finishRec(rec) {
  if (rec._done) return;
  rec._done = true;
  stopPipeline();
  const type = ((rec.mimeType || (st.chunks[0] && st.chunks[0].type) || 'video/mp4').split(';')[0]) || 'video/mp4';
  const blob = new Blob(st.chunks, { type });
  st.chunks = [];
  st.rec = null;
  $('#stage').classList.remove('recording');
  updateModeUI();
  updateStatus();
  hostSendState(true);
  if (!blob.size) { toast('Запись получилась пустой. Попробуй ещё раз'); return; }
  const script = st.script || { id: '', title: 'Без названия' };
  const n = takes.filter(t => t.scriptId === script.id && t.kind !== 'photo').length + 1;
  const meta = {
    id: uid(), kind: 'video', scriptId: script.id, title: script.title || 'Без названия', take: n,
    created: st.recStart, duration: Math.max(0, ((st.recEnd || Date.now()) - st.recStart) / 1000),
    size: blob.size, type, thumb: st.thumb || '', saved: false,
    format: st.recFormat, w: st.recSize ? st.recSize.w : 0, h: st.recSize ? st.recSize.h : 0, mirrored: !!S().mirrorOutput
  };
  try { await DB.add(meta, blob); takes.unshift(meta); }
  catch (e) { toast('Не хватило места, чтобы оставить запись в приложении. Сохрани её в Фото сейчас', 5000); }
  openReview(meta, blob, !$('#stage').hidden);
}

/* ---------- photo ---------- */
async function takePhoto() {
  if (!cameraAlive() || !cam.videoWidth) { toast('Камера не включена'); openCamera(); return; }
  st.busy = true;
  updateModeUI();
  const n = +S().countdown;
  if (n > 0) {
    const go = await countdown(n);
    if (!go || !cameraAlive()) { st.busy = false; updateModeUI(); return; }
  }
  const format = S().format;
  const { w, h } = outputSize(format);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  drawFrame(c.getContext('2d'), w, h, !!S().mirrorOutput);
  const fl = $('#flash');
  fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
  const thumb = makeThumb(format);
  const blob = await new Promise(r => { try { c.toBlob(r, 'image/jpeg', 0.92); } catch (e) { r(null); } });
  st.busy = false;
  updateModeUI();
  if (!blob) { toast('Фото не получилось. Попробуй ещё раз'); return; }
  const script = st.script || { id: '', title: 'Без названия' };
  const num = takes.filter(t => t.scriptId === script.id && t.kind === 'photo').length + 1;
  const meta = {
    id: uid(), kind: 'photo', scriptId: script.id, title: script.title || 'Без названия', take: num,
    created: Date.now(), duration: 0, size: blob.size, type: 'image/jpeg', thumb, saved: false,
    format, w, h, mirrored: !!S().mirrorOutput
  };
  try { await DB.add(meta, blob); takes.unshift(meta); }
  catch (e) { toast('Не хватило места, чтобы оставить фото в приложении. Сохрани его в Фото сейчас', 5000); }
  openReview(meta, blob, !$('#stage').hidden);
  hostSendMsg('Фото сделано');
}

/* ---------- review ---------- */
let rv = null;
function fileName(meta) {
  const d = new Date(meta.created);
  const p = x => String(x).padStart(2, '0');
  const ext = meta.kind === 'photo' ? 'jpg' : /webm/.test(meta.type) ? 'webm' : 'mp4';
  return `Sufler_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
}
function takeLabel(meta) {
  return meta.title + (meta.kind === 'photo' ? ' · фото ' : ' · дубль ') + meta.take;
}
function openReview(meta, blob, fromStage) {
  releaseReview();
  let file = null;
  try { file = new File([blob], fileName(meta), { type: blob.type || meta.type }); } catch (e) {}
  rv = { meta, blob, file, url: URL.createObjectURL(blob), fromStage };
  const photo = meta.kind === 'photo';
  const v = $('#rvVideo'), img = $('#rvImg');
  v.hidden = photo; img.hidden = !photo;
  if (photo) img.src = rv.url; else v.src = rv.url;
  $('#rvTitle').textContent = takeLabel(meta);
  const bits = [];
  if (!photo) bits.push(fmtTime(meta.duration));
  if (meta.format) bits.push(meta.format + (meta.mirrored ? ', зеркально' : ''));
  if (meta.w && meta.h) bits.push(meta.w + '×' + meta.h);
  bits.push(fmtSize(meta.size), fmtDate(meta.created));
  $('#rvInfo').textContent = bits.join(' · ');
  $('#rvSaved').hidden = !meta.saved;
  $('#rvAgain').hidden = !fromStage;
  $('#rvAgain').textContent = photo ? 'Ещё фото' : 'Ещё дубль';
  $('#review').hidden = false;
  document.body.classList.add('locked');
}
function releaseReview() {
  if (!rv) return;
  const v = $('#rvVideo');
  v.pause();
  v.removeAttribute('src');
  v.load();
  $('#rvImg').removeAttribute('src');
  URL.revokeObjectURL(rv.url);
  rv = null;
}
function closeReview() {
  releaseReview();
  $('#review').hidden = true;
  if ($('#stage').hidden) document.body.classList.remove('locked');
  if (!$('#tab-takes').hidden) renderTakes();
}
$('#rvClose').addEventListener('click', closeReview);
$('#rvAgain').addEventListener('click', () => {
  const photo = rv && rv.meta.kind === 'photo';
  closeReview();
  if (!photo) restartText();
});
$('#rvSave').addEventListener('click', async () => {
  if (!rv) return;
  const cur = rv;
  if (cur.file && navigator.canShare && navigator.canShare({ files: [cur.file] })) {
    try {
      await navigator.share({ files: [cur.file] });
      markSaved(cur.meta);
      return;
    } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = cur.url;
  a.download = cur.file ? cur.file.name : fileName(cur.meta);
  document.body.append(a);
  a.click();
  a.remove();
  markSaved(cur.meta);
  toast('Файл скачан. На iPhone он в «Файлах» → «Загрузки»', 4000);
});
function markSaved(meta) {
  meta.saved = true;
  DB.update(meta).catch(() => {});
  if (rv && rv.meta === meta) $('#rvSaved').hidden = false;
}
$('#rvDelete').addEventListener('click', async () => {
  if (!rv) return;
  const meta = rv.meta;
  if (!(await ask('Удалить «' + takeLabel(meta) + '»? Вернуть не получится.'))) return;
  try { await DB.remove(meta.id); } catch (e) {}
  takes = takes.filter(t => t.id !== meta.id);
  closeReview();
  toast('Удалено');
});
$('#review').addEventListener('click', e => { if (e.target.id === 'review') closeReview(); });

/* ---------- takes grid ---------- */
const CAM_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="13.5" height="12" rx="2.5"/><path d="M16 10.5l5.5-3v9l-5.5-3z"/></svg>';
async function renderTakes() {
  await loadTakes();
  const grid = $('#takeGrid');
  grid.innerHTML = '';
  $('#takesEmpty').hidden = takes.length > 0;
  const total = takes.reduce((a, t) => a + (t.size || 0), 0);
  $('#takesInfo').textContent = takes.length ? plural(takes.length, 'запись', 'записи', 'записей') + ' · ' + fmtSize(total) : '';
  for (const t of takes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'take';
    b.dataset.id = t.id;
    const photo = t.kind === 'photo';
    const fourK = t.w && t.h && Math.max(t.w, t.h) >= 3000;
    b.innerHTML =
      (t.thumb ? `<img src="${t.thumb}" alt="">` : `<span class="noimg">${CAM_SVG}</span>`) +
      `<span class="chip">${photo ? 'Фото' : fmtTime(t.duration)}${t.format && t.format !== '9:16' ? ' · ' + t.format : ''}${fourK ? ' · 4K' : ''}</span>` +
      (t.saved ? '<span class="chip saved">✓ сохранено</span>' : '') +
      `<span class="cap"><b>${esc(t.title)}</b><span>${photo ? 'фото' : 'дубль'} ${t.take} · ${fmtDate(t.created)}</span></span>`;
    grid.append(b);
  }
}
$('#takeGrid').addEventListener('click', async e => {
  const b = e.target.closest('.take');
  if (!b) return;
  const meta = takes.find(t => t.id === b.dataset.id);
  if (!meta) return;
  let blob = null;
  try { blob = await DB.blob(meta.id); } catch (err) {}
  if (!blob) { toast('Файл не найден — возможно, браузер очистил память'); return; }
  openReview(meta, blob, false);
});

/* =====================================================================
   Hints: listen to the other person, catch questions, stream an answer
   ===================================================================== */
const H = {
  rec: null, on: false, procIdx: 0, lastLen: 0, pending: '', timer: 0, restartTimer: 0,
  ctx: [], queue: [], busy: false, cur: null, abort: null, err: '', history: []
};
try { const a = JSON.parse(localStorage.getItem(KEY + '.hints')); if (Array.isArray(a)) H.history = a; } catch (e) {}
const saveHintHistory = () => { try { localStorage.setItem(KEY + '.hints', JSON.stringify(H.history.slice(0, 60))); } catch (e) {} };

const Q_START = new Set(('как каким какой какая какое какие каких какую каком какого что чем чего чему почему зачем отчего когда где куда откуда сколько ' +
  'кто кого кому кем чей чья чье чьи разве неужели можно стоит нужно надо правда расскажи расскажите объясни объясните подскажи подскажите ' +
  'посоветуй посоветуйте поделись поделитесь назови назовите опиши опишите представь представьте скажи скажите ' +
  'what whats why how when where who whom whose which can could would should will do does did is are was were tell explain describe').split(' '));
const Q_TASK = new Set('напиши придумай сравни оцени предложи составь implement design optimize compare suggest'.split(' '));
const Q_OPINION = new Set('думаешь думаете считаешь считаете посоветуешь посоветуете пробовал пробовала пробовали относишься относитесь'.split(' '));
const FILLERS = new Set('а ну и так вот слушай слушайте окей ок кстати но ok so and well hey also but'.split(' '));
function isQuestion(text) {
  const t = String(text).trim();
  if (/\?\s*$/.test(t)) return true;
  const w = wordsOf(t);
  while (w.length > 1 && FILLERS.has(w[0])) w.shift();
  if (!w.length) return false;
  if (Q_START.has(w[0]) || Q_TASK.has(w[0])) return true;
  const head = w.slice(0, 6);
  if (head.includes('ли')) return true;
  return head.some(x => Q_OPINION.has(x));
}
/* the speaker reading the answer aloud should not trigger a new answer */
function isEcho(text) {
  const ref = ((H.cur && H.cur.a) || '') + ' ' + (H.history[0] ? H.history[0].a : '');
  const refSet = new Set(wordsOf(ref).filter(x => x.length > 3));
  const words = wordsOf(text).filter(x => x.length > 3);
  if (words.length < 3 || !refSet.size) return false;
  return words.filter(x => refSet.has(x)).length / words.length >= 0.6;
}
function hintSystem() {
  const about = data.ai.about.trim(), topic = data.hints.topic.trim();
  return [
    'Ты — суфлёр-подсказчик. Человек прямо сейчас в живом разговоре: эфир, подкаст, интервью или созвон. Собеседник задал вопрос. Напиши ответ, который человек сразу прочитает вслух от первого лица.',
    'Правила: 2–4 коротких предложения, главная мысль — в первом. Просто и разговорно. Без списков, markdown, эмодзи и вступлений вроде «Отличный вопрос». Если уместен пример или цифра — одна и конкретная. Если вопрос технический или просит план — можно до 6 предложений. Если вопрос личный, а фактов о человеке нет — дай честный нейтральный ответ, который легко дополнить своим.',
    'Отвечай на том же языке, на котором задан вопрос.',
    about ? 'О человеке: ' + about : '',
    topic ? 'Тема разговора: ' + topic : ''
  ].filter(Boolean).join('\n\n');
}
function hintUser(item) {
  return (item.ctx && item.ctx.length ? 'Последние фразы разговора:\n' + item.ctx.map(x => '— ' + x).join('\n') + '\n\n' : '') +
    'Вопрос собеседника: ' + item.q +
    (item.prev ? '\n\nДай другой вариант ответа, не повторяй этот: «' + item.prev + '»' : '');
}

function hintsStart() {
  if (!aiReady()) { toast('Сначала подключи ИИ: Настройки → ИИ', 3500); renderHints(); return; }
  if (!SR) { toast('Распознавание речи недоступно. На iPhone открой Суфлёр в Safari и включи Siri и диктовку', 5000); return; }
  if (H.on) return;
  H.on = true;
  H.procIdx = 0; H.lastLen = 0; H.pending = '';
  const r = new SR();
  r.lang = data.hints.lang;
  r.continuous = true;
  r.interimResults = true;
  r.onresult = e => {
    let txt = '';
    for (let i = H.procIdx; i < e.results.length; i++) txt += ' ' + e.results[i][0].transcript;
    H.pending = txt.replace(/\s+/g, ' ').trim();
    H.lastLen = e.results.length;
    $('#hHeard').textContent = H.pending ? H.pending.slice(-160) : '—';
    clearTimeout(H.timer);
    if (countWords(H.pending) >= 45) hintsFlush();
    else H.timer = setTimeout(hintsFlush, 1300);
  };
  r.onerror = e => {
    const err = e && e.error;
    if (err === 'no-speech' || err === 'aborted') return;
    hintsStop();
    if (err === 'not-allowed' || err === 'service-not-allowed') toast('Нет доступа к распознаванию речи. Включи Siri и диктовку и разреши микрофон', 6000);
    else if (err === 'network') toast('Для распознавания речи нужен интернет', 4000);
    else if (err === 'audio-capture') toast('Микрофон занят другим приложением', 4000);
    else toast('Распознавание речи остановилось. Нажми «Слушать» ещё раз', 4000);
  };
  r.onend = () => {
    if (H.rec !== r) return;
    hintsFlush();
    if (!H.on) return;
    clearTimeout(H.restartTimer);
    H.restartTimer = setTimeout(() => {
      if (!H.on || H.rec !== r) return;
      H.procIdx = 0; H.lastLen = 0;
      try { r.start(); } catch (err) { hintsStop(); }
    }, 200);
  };
  H.rec = r;
  try { r.start(); }
  catch (e) { H.on = false; H.rec = null; toast('Не получилось включить микрофон'); }
  renderHintsState();
}
function hintsStop() {
  H.on = false;
  clearTimeout(H.restartTimer);
  const r = H.rec;
  H.rec = null;
  if (r) { r.onend = null; r.onresult = null; try { r.abort(); } catch (e) {} }
  hintsFlush();
  renderHintsState();
}
function hintsFlush() {
  clearTimeout(H.timer);
  const text = H.pending;
  H.pending = '';
  H.procIdx = H.lastLen;
  if (text) hintsHeard(text);
}
function hintsHeard(text) {
  text = String(text).replace(/\s+/g, ' ').trim();
  if (!text || isEcho(text)) return;
  const n = countWords(text);
  const want = data.hints.mode === 'all' ? n >= 3 : isQuestion(text);
  if (want) {
    const q = n < 4 && H.ctx.length ? H.ctx[H.ctx.length - 1] + ' ' + text : text;
    hintsEnqueue(q, H.ctx.slice(-5));
  }
  H.ctx.push(text);
  if (H.ctx.length > 10) H.ctx.shift();
}
function hintsEnqueue(q, ctx, prev) {
  H.queue.push({ q, ctx: ctx || [], prev });
  renderHintsState();
  hintsPump();
}
async function hintsPump() {
  if (H.busy || !H.queue.length) return;
  H.busy = true;
  const item = H.queue.shift();
  renderHintsState();
  await hintsAnswer(item);
  H.busy = false;
  renderHintsState();
  hintsPump();
}
async function hintsAnswer(item) {
  H.cur = { id: uid(), q: item.q, a: '', ts: Date.now() };
  H.err = '';
  renderAnswer();
  const ctrl = new AbortController();
  H.abort = ctrl;
  try {
    await aiStream({
      system: hintSystem(), user: hintUser(item), maxTokens: 500, signal: ctrl.signal,
      onText: t => { if (H.abort === ctrl) { H.cur.a = cleanAi(t); renderAnswer(); } }
    });
  } catch (e) {
    if (e.name !== 'AbortError') H.err = e.message || 'Ошибка ИИ';
  }
  H.abort = null;
  if (H.cur.a) {
    H.history.unshift({ id: H.cur.id, q: H.cur.q, a: H.cur.a, ts: H.cur.ts });
    if (H.history.length > 60) H.history.length = 60;
    saveHintHistory();
    renderHistory();
  }
  renderAnswer();
}
function renderAnswer() {
  const c = H.cur, a = $('#hA');
  $('#hQ').textContent = c ? 'Вопрос: ' + c.q : 'Здесь появится вопрос';
  a.className = 'h-a';
  if (H.err) { a.classList.add('err'); a.textContent = H.err; }
  else if (!c) { a.classList.add('empty'); a.textContent = 'Нажми «Слушать» или напиши вопрос ниже.'; }
  else if (!c.a) { a.classList.add('empty'); a.textContent = 'Думаю…'; }
  else a.textContent = c.a;
  $('#hActions').hidden = !(c && c.a && !H.abort);
  // big reader
  if (!$('#hStage').hidden) {
    const body = $('#hsBody');
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    $('#hsQ').textContent = c ? c.q : '';
    $('#hsA').textContent = H.err || (c ? (c.a || 'Думаю…') : 'Задай вопрос — ответ появится здесь.');
    if (stick) body.scrollTop = body.scrollHeight;
  }
}
function renderHintsState() {
  const chip = $('#hStatus');
  chip.className = 'status-chip';
  if (H.busy) { chip.textContent = 'Думаю…'; chip.classList.add('busy'); }
  else if (H.on) { chip.textContent = 'Слушаю'; chip.classList.add('on'); }
  else chip.textContent = 'Выключено';
  const mic = $('#hMic');
  mic.classList.toggle('on', H.on);
  mic.textContent = H.on ? 'Остановить' : 'Слушать';
  $('#hsMic').setAttribute('aria-pressed', String(H.on));
  $('#hsMic').setAttribute('aria-label', H.on ? 'Перестать слушать' : 'Слушать');
  const q = $('#hQueue');
  q.hidden = !H.queue.length;
  q.textContent = H.queue.length ? 'Ещё ' + plural(H.queue.length, 'вопрос', 'вопроса', 'вопросов') + ' в очереди' : '';
  $('#hNoKey').hidden = aiReady();
  if (!H.on && !H.pending) $('#hHeard').textContent = '—';
}
function renderHistory() {
  const box = $('#hHist');
  box.innerHTML = '';
  $('#hHistWrap').hidden = !H.history.length;
  for (const it of H.history.slice(0, 30)) {
    const el = document.createElement('article');
    el.className = 'h-item';
    el.innerHTML = `<b>${esc(it.q)}</b><p>${esc(it.a)}</p>` +
      `<div class="h-item-foot"><span class="meta">${fmtDate(it.ts)}</span><button class="link" type="button" data-h2s="${it.id}">В сценарий</button></div>`;
    box.append(el);
  }
}
function renderHints() {
  $('#hTopic').value = data.hints.topic;
  $$('#hMode button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === data.hints.mode)));
  $$('#hLang button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === data.hints.lang)));
  renderHintsState();
  renderAnswer();
  renderHistory();
}
function hintToScript(q, a) {
  const s = addScript(q, a);
  renderScripts();
  toast('Добавлено в Сценарии: ' + s.title);
}
$('#hMic').addEventListener('click', () => { H.on ? hintsStop() : hintsStart(); });
$('#hsMic').addEventListener('click', () => { H.on ? hintsStop() : hintsStart(); });
$('#hAskForm').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('#hAsk').value.trim();
  if (!q) return;
  if (!aiReady()) { toast('Сначала подключи ИИ: Настройки → ИИ', 3500); return; }
  $('#hAsk').value = '';
  hintsEnqueue(q, H.ctx.slice(-5));
  H.ctx.push(q);
});
$('#hRegen').addEventListener('click', () => {
  if (!H.cur || !H.cur.a) return;
  H.queue.unshift({ q: H.cur.q, ctx: [], prev: H.cur.a });
  hintsPump();
});
$('#hToScript').addEventListener('click', () => { if (H.cur && H.cur.a) hintToScript(H.cur.q, H.cur.a); });
$('#hHist').addEventListener('click', e => {
  const b = e.target.closest('[data-h2s]'); if (!b) return;
  const it = H.history.find(x => x.id === b.dataset.h2s);
  if (it) hintToScript(it.q, it.a);
});
$('#hClear').addEventListener('click', async () => {
  if (!(await ask('Очистить историю подсказок?', 'Очистить'))) return;
  H.history = [];
  saveHintHistory();
  renderHistory();
});
$('#hConnect').addEventListener('click', () => {
  showTab('settings');
  setTimeout(() => $('#aiSettings').scrollIntoView({ block: 'start' }), 30);
});
$('#hTopic').addEventListener('input', e => { data.hints.topic = e.target.value; saveSoon(); });
$('#hMode').addEventListener('click', e => {
  const b = e.target.closest('[data-v]'); if (!b) return;
  data.hints.mode = b.dataset.v; save(); renderHints();
});
$('#hLang').addEventListener('click', e => {
  const b = e.target.closest('[data-v]'); if (!b) return;
  data.hints.lang = b.dataset.v; save(); renderHints();
  if (H.on) { hintsStop(); hintsStart(); }
});
/* big reader */
function applyHintStage() {
  $('#hsBody').style.fontSize = data.hints.font + 'px';
  $('#hsMirrorBox').style.transform = data.hints.mirror ? 'scaleX(-1)' : '';
  $('#hsMirror').setAttribute('aria-pressed', String(!!data.hints.mirror));
}
$('#hBig').addEventListener('click', () => {
  $('#hStage').hidden = false;
  document.body.classList.add('locked');
  applyHintStage();
  renderAnswer();
  keepAwake(true);
});
$('#hsClose').addEventListener('click', () => {
  $('#hStage').hidden = true;
  if ($('#stage').hidden) { document.body.classList.remove('locked'); keepAwake(false); }
});
$('#hsMirror').addEventListener('click', () => { data.hints.mirror = !data.hints.mirror; save(); applyHintStage(); });
$('#hsDown').addEventListener('click', () => { data.hints.font = clamp(data.hints.font - 2, 18, 80); save(); applyHintStage(); });
$('#hsUp').addEventListener('click', () => { data.hints.font = clamp(data.hints.font + 2, 18, 80); save(); applyHintStage(); });

/* =====================================================================
   Remote host: the prompter phone, reachable by QR code (PeerJS, P2P)
   ===================================================================== */
const RH = { peer: null, id: '', clients: new Set(), status: 'off', statusText: '', sentAt: 0, lastPos: '', lastState: '', stateAt: 0, idRetries: 0, retryT: 0, stopping: false };
function randomId() {
  const a = new Uint8Array(10);
  (window.crypto || window.msCrypto).getRandomValues(a);
  return 'sufler-' + Array.from(a, x => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join('');
}
function hostId() {
  let id = prefs.get('remoteId');
  if (!id || !/^sufler-[a-z0-9]{10}$/.test(id)) { id = randomId(); prefs.set('remoteId', id); }
  return id;
}
const remoteUrl = id => location.href.split('#')[0].split('?')[0] + '#remote=' + id;
function setHostStatus(status, text) {
  RH.status = status;
  RH.statusText = text;
  const el = $('#rmStatus');
  el.textContent = text;
  el.className = 'rm-status' + (status === 'ok' ? ' ok' : status === 'err' ? ' err' : '');
  $('#rmBtn').setAttribute('aria-pressed', String(RH.clients.size > 0));
}
function hostClientsText() {
  return RH.clients.size ? 'Подключено: ' + plural(RH.clients.size, 'устройство', 'устройства', 'устройств') : 'Готово — жду второй телефон';
}
async function hostStart() {
  if (RH.peer) return;
  RH.stopping = false;
  setHostStatus('wait', 'Подключаюсь…');
  try { await loadScript(PEER_SRC); }
  catch (e) { setHostStatus('err', 'Не загрузилась библиотека пульта. Проверь интернет'); return; }
  if ($('#stage').hidden || RH.peer || RH.stopping) return;
  RH.id = hostId();
  renderRemoteLink();
  let peer;
  try { peer = new window.Peer(RH.id, { debug: 0 }); }
  catch (e) { setHostStatus('err', 'Этот браузер не умеет пульт'); return; }
  RH.peer = peer;
  peer.on('open', () => { RH.idRetries = 0; setHostStatus('ok', hostClientsText()); });
  peer.on('connection', conn => {
    conn.on('open', () => {
      RH.clients.add(conn);
      setHostStatus('ok', hostClientsText());
      hostHello(conn);
      toast('Пульт подключён');
    });
    conn.on('data', d => onRemoteCmd(d, conn));
    const drop = () => { if (RH.clients.delete(conn)) setHostStatus(RH.peer ? 'ok' : 'off', hostClientsText()); };
    conn.on('close', drop);
    conn.on('error', drop);
  });
  peer.on('error', err => {
    const t = err && err.type;
    if (RH.peer !== peer) return;
    if (t === 'unavailable-id') {
      hostStop(false);
      if (RH.idRetries++ >= 2) { prefs.set('remoteId', randomId()); RH.idRetries = 0; }
      setHostStatus('wait', 'Подключаюсь…');
      RH.retryT = setTimeout(() => { if (!$('#stage').hidden) hostStart(); }, 2000);
    } else if (t === 'browser-incompatible') {
      setHostStatus('err', 'Этот браузер не умеет пульт');
    } else if (t === 'peer-unavailable') {
      /* not used by the host */
    } else {
      hostStop(false);
      setHostStatus('err', 'Нет связи с сервером пульта. Проверь интернет — пробую снова…');
      RH.retryT = setTimeout(() => { if (!$('#stage').hidden) hostStart(); }, 5000);
    }
  });
  peer.on('disconnected', () => {
    if (RH.peer !== peer || RH.stopping) return;
    setTimeout(() => { try { if (RH.peer === peer && !peer.destroyed) peer.reconnect(); } catch (e) {} }, 1500);
  });
}
function hostStop(sayBye) {
  clearTimeout(RH.retryT);
  RH.stopping = true;
  if (sayBye) hostBroadcast({ t: 'bye' });
  for (const c of RH.clients) { try { c.close(); } catch (e) {} }
  RH.clients.clear();
  if (RH.peer) { const p = RH.peer; RH.peer = null; setTimeout(() => { try { p.destroy(); } catch (e) {} }, sayBye ? 300 : 0); }
  RH.lastPos = ''; RH.lastState = '';
  setHostStatus('off', 'Пульт выключен');
}
function hostBroadcast(msg) {
  for (const c of RH.clients) { if (c.open) { try { c.send(msg); } catch (e) {} } }
}
function hostHello(c) {
  const s = st.script || { title: '', text: '' };
  try {
    c.send({ t: 'hello', title: s.title || 'Без названия', text: s.text || '' });
    c.send(stateMsg());
    c.send(Object.assign({ t: 'pos' }, linePos()));
  } catch (e) {}
}
function hostHelloAll() { for (const c of RH.clients) if (c.open) hostHello(c); }
function stateMsg() {
  return {
    t: 'state', rec: !!st.rec, el: st.rec ? (Date.now() - st.recStart) / 1000 : 0, busy: !!st.busy,
    playing: !!st.playing, voice: isVoice(), listening: !!voice.on, wpm: S().wpm, font: S().font,
    capture: S().capture, title: (st.script && st.script.title) || '', end: st.max > 0 && st.offset >= st.max - 0.5
  };
}
function hostSendState(force) {
  if (!RH.clients.size) return;
  const m = stateMsg();
  const sig = JSON.stringify(Object.assign({}, m, { el: 0 }));
  const now = Date.now();
  if (force || sig !== RH.lastState || now - RH.stateAt > 1000) {
    RH.lastState = sig; RH.stateAt = now;
    hostBroadcast(m);
  }
}
function hostSendMsg(text) { hostBroadcast({ t: 'msg', text }); }
function linePos() {
  const ys = voice.ys, n = ys.length;
  if (!n) return { w: 0, f: 0 };
  const y = st.offset + st.markerY;
  if (y < ys[0]) return { w: 0, f: 0 };
  let lo = 0, hi = n - 1, k = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (ys[mid] <= y + 0.5) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  const top = ys[k];
  let s = k; while (s > 0 && ys[s - 1] === top) s--;
  let nx = k + 1; while (nx < n && ys[nx] === top) nx++;
  const nextY = nx < n ? ys[nx] : top + st.lineH;
  return { w: s, f: Math.round(clamp((y - top) / Math.max(1, nextY - top), 0, 1) * 1000) / 1000 };
}
function hostTick() {
  const p = linePos();
  const sig = p.w + ':' + p.f;
  if (sig !== RH.lastPos) { RH.lastPos = sig; hostBroadcast({ t: 'pos', w: p.w, f: p.f }); }
  hostSendState(false);
}
function onRemoteCmd(d, conn) {
  if (!d || typeof d.t !== 'string' || $('#stage').hidden) return;
  const reply = text => { try { conn.send({ t: 'msg', text }); } catch (e) {} };
  switch (d.t) {
    case 'toggle':
      if (st.busy) break;
      if (isVoice()) { if (voice.on) stopListening(); else reply('Режим по голосу включается только на самом суфлёре'); }
      else togglePlay();
      break;
    case 'back': nudge(-2); break;
    case 'fwd': nudge(2); break;
    case 'slower': changeWpm(-10); break;
    case 'faster': changeWpm(10); break;
    case 'smaller': changeFont(-2); break;
    case 'bigger': changeFont(2); break;
    case 'restart': restartText(); break;
    case 'capture': setCapture(d.v); break;
    case 'rec':
      if (st.rec) { stopRec(); break; }
      if (st.busy) { cancelCountdown(); break; }
      if (!$('#review').hidden) closeReview();
      if (!$('#remoteSheet').hidden) $('#remoteSheet').hidden = true;
      recToggle();
      break;
    case 'load': {
      const text = String(d.text || '').slice(0, 100000);
      if (!text.trim()) { reply('Текст пустой'); break; }
      if (st.rec || st.busy) { reply('Сначала останови запись'); break; }
      const s = addScript(String(d.title || ''), text);
      loadStageScript(s);
      toast('Новый текст с пульта: ' + s.title);
      reply('Текст открыт на суфлёре');
      break;
    }
  }
  hostSendState(true);
}
/* the sheet with the QR code */
function renderRemoteLink() {
  const id = RH.id || hostId();
  const url = remoteUrl(id);
  $('#rmLink').textContent = url;
  $('#rmOpen').href = url;
  const box = $('#rmQr');
  loadScript(QR_SRC).then(() => {
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      box.innerHTML = qr.createImgTag(8, 0, 'QR-код пульта');
    } catch (e) { box.textContent = 'Код не получился — открой ссылку ниже на втором телефоне'; }
  }).catch(() => { box.textContent = 'Код не загрузился — открой ссылку ниже на втором телефоне'; });
}
function openRemoteSheet() {
  prefs.set('remoteOn', '1');
  RH.id = RH.id || hostId();
  renderRemoteLink();
  $('#rmShowText').checked = st.showText;
  setHostStatus(RH.peer ? (RH.status === 'err' ? 'err' : 'ok') : 'wait', RH.peer ? (RH.status === 'err' ? RH.statusText : hostClientsText()) : 'Подключаюсь…');
  $('#remoteSheet').hidden = false;
  hostStart();
}
$('#rmClose').addEventListener('click', () => { $('#remoteSheet').hidden = true; });
$('#remoteSheet').addEventListener('click', e => { if (e.target.id === 'remoteSheet') $('#remoteSheet').hidden = true; });
$('#rmCopy').addEventListener('click', async () => {
  const ok = await copyText($('#rmLink').textContent);
  toast(ok ? 'Ссылка скопирована' : 'Не получилось скопировать — выдели ссылку вручную');
});
$('#rmShowText').addEventListener('change', e => { st.showText = e.target.checked; layoutStage(); });
$('#rmOff').addEventListener('click', () => {
  prefs.set('remoteOn', '0');
  hostStop(true);
  $('#remoteSheet').hidden = true;
  toast('Пульт выключен');
});

/* =====================================================================
   Remote client: the second phone (pult + screen with the text)
   ===================================================================== */
const RC = {
  hostId: '', peer: null, conn: null, open: false, state: null, stateAt: 0, script: null, pos: null,
  ys: [], lineH: 60, markerY: 120, max: 0, offset: 0, raf: 0, last: 0, retryT: 0, wake: null, barT: 0
};
const rcFont = () => clamp(+prefs.get('rcFont') || 44, 20, 96);
const rcMirrorOn = () => prefs.get('rcMirror') === '1';
function rcConnStatus(text, cls) {
  const el = $('#rcConn');
  el.textContent = text;
  el.className = 'conn' + (cls ? ' ' + cls : '');
}
function rcMessage(text) {
  $('#rcMsg').textContent = text || '';
  $('#rcMsg').hidden = !text;
}
function rcRetry(fn, ms) { clearTimeout(RC.retryT); RC.retryT = setTimeout(fn, ms); }
async function startRemoteClient(id) {
  RC.hostId = id;
  document.body.classList.add('remote-mode');
  $('#remoteApp').hidden = false;
  document.title = 'Пульт Суфлёра';
  $$('#remoteApp [data-cmd]').forEach(b => b.addEventListener('click', () => rcSend({ t: b.dataset.cmd })));
  $('#rcPlay').addEventListener('click', () => rcSend({ t: 'toggle' }));
  $('#rcsPlay').addEventListener('click', () => rcSend({ t: 'toggle' }));
  $('#rcRec').addEventListener('click', () => rcSend({ t: 'rec' }));
  $$('#rcMode button').forEach(b => b.addEventListener('click', () => rcSend({ t: 'capture', v: b.dataset.mode })));
  $('#rcTabs').addEventListener('click', e => { const b = e.target.closest('[data-rc]'); if (b) rcShowScreen(b.dataset.rc === 'screen'); });
  $('#rcScreenClose').addEventListener('click', () => rcShowScreen(false));
  $('#rcsDown').addEventListener('click', () => { prefs.set('rcFont', rcFont() - 4); rcLayout(); rcBarShow(); });
  $('#rcsUp').addEventListener('click', () => { prefs.set('rcFont', rcFont() + 4); rcLayout(); rcBarShow(); });
  $('#rcsMirror').addEventListener('click', () => { prefs.set('rcMirror', rcMirrorOn() ? '0' : '1'); rcLayout(); rcBarShow(); });
  $('#rcView').addEventListener('click', () => { $('#rcBar').classList.contains('hide') ? rcBarShow() : $('#rcBar').classList.add('hide'); });
  $('#rcPasteBtn').addEventListener('click', async () => {
    const t = await readClipboard();
    if (t && t.trim()) $('#rcSendText').value = t;
    else toast(t === null ? 'Не получилось прочитать буфер — вставь текст в поле' : 'В буфере нет текста');
  });
  $('#rcSendBtn').addEventListener('click', () => {
    const text = $('#rcSendText').value;
    if (!text.trim()) { toast('Вставь текст'); return; }
    if (rcSend({ t: 'load', title: $('#rcSendTitle').value, text })) {
      $('#rcSendText').value = ''; $('#rcSendTitle').value = '';
      $('.rc-send').open = false;
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    rcWake();
    if (!RC.open) rcRetry(rcDial, 300);
  });
  setInterval(rcRender, 500);
  rcRender();
  rcConnStatus('Подключаюсь…', '');
  try { await loadScript(PEER_SRC); }
  catch (e) { rcConnStatus('Нет связи', 'err'); rcMessage('Не загрузилась библиотека пульта. Проверь интернет и обнови страницу.'); return; }
  rcConnect();
}
function rcConnect() {
  clearTimeout(RC.retryT);
  if (RC.peer && !RC.peer.destroyed) { if (RC.peer.open) rcDial(); return; }
  let peer;
  try { peer = new window.Peer({ debug: 0 }); }
  catch (e) { rcConnStatus('Нет связи', 'err'); rcMessage('Этот браузер не умеет пульт. Открой ссылку в Safari или Chrome.'); return; }
  RC.peer = peer;
  peer.on('open', () => rcDial());
  peer.on('error', err => {
    const t = err && err.type;
    if (t === 'peer-unavailable') {
      rcConnStatus('Не найден', 'err');
      rcMessage('Суфлёр не найден. На первом телефоне открой сценарий на экране записи — пульт подключится сам.');
      rcRetry(rcDial, 3000);
    } else if (t === 'browser-incompatible') {
      rcConnStatus('Нет связи', 'err');
      rcMessage('Этот браузер не умеет пульт. Открой ссылку в Safari или Chrome.');
    } else {
      rcConnStatus('Нет связи', 'err');
      rcMessage('Нет связи с сервером пульта. Проверь интернет — переподключаюсь…');
      try { peer.destroy(); } catch (e) {}
      if (RC.peer === peer) RC.peer = null;
      rcRetry(rcConnect, 4000);
    }
  });
  peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => { try { if (!peer.destroyed) peer.reconnect(); } catch (e) {} }, 1500); });
}
function rcDial() {
  if (!RC.peer || RC.peer.destroyed || !RC.peer.open) { rcConnect(); return; }
  if (RC.conn) { const old = RC.conn; RC.conn = null; try { old.close(); } catch (e) {} }
  const c = RC.peer.connect(RC.hostId, { reliable: true, serialization: 'json' });
  RC.conn = c;
  const to = setTimeout(() => {
    if (c.open || RC.conn !== c) return;
    try { c.close(); } catch (e) {}
    rcConnStatus('Нет связи', 'err');
    rcMessage('Не получается связаться с суфлёром. Подключи оба телефона к одному Wi‑Fi и держи экран записи открытым.');
    rcRetry(rcDial, 1500);
  }, 12000);
  c.on('open', () => {
    clearTimeout(to);
    if (RC.conn !== c) return;
    RC.open = true;
    rcConnStatus('Подключено', 'ok');
    rcMessage('');
    rcRender();
    rcWake();
  });
  c.on('data', rcOnData);
  c.on('close', () => {
    clearTimeout(to);
    if (RC.conn !== c) return;
    RC.open = false;
    rcConnStatus('Нет связи', 'err');
    if ($('#rcMsg').hidden) rcMessage('Связь с суфлёром пропала — переподключаюсь…');
    rcRender();
    rcRetry(rcDial, 2000);
  });
  c.on('error', () => {});
}
function rcOnData(d) {
  if (!d || typeof d.t !== 'string') return;
  switch (d.t) {
    case 'hello':
      RC.script = { title: String(d.title || ''), text: String(d.text || '') };
      rcRenderText();
      break;
    case 'state':
      RC.state = d; RC.stateAt = Date.now();
      rcRender();
      break;
    case 'pos':
      RC.pos = { w: +d.w || 0, f: +d.f || 0 };
      break;
    case 'msg':
      toast(String(d.text || ''), 3500);
      break;
    case 'bye':
      rcMessage('Суфлёр закрыт. Открой сценарий снова — пульт подключится сам.');
      break;
  }
}
function rcSend(msg) {
  if (!RC.open || !RC.conn || !RC.conn.open) { toast('Нет связи с суфлёром'); return false; }
  try { RC.conn.send(msg); return true; } catch (e) { toast('Нет связи с суфлёром'); return false; }
}
function rcRender() {
  if ($('#remoteApp').hidden) return;
  const s = RC.state, b = $('#rcState');
  let label = '—';
  if (RC.open && s) {
    if (s.rec) label = '● Запись ' + fmtTime(s.el + (Date.now() - RC.stateAt) / 1000);
    else if (s.busy) label = 'Отсчёт…';
    else if (s.voice) label = s.listening ? 'Текст идёт за голосом' : 'Режим по голосу';
    else if (s.end) label = 'Конец текста';
    else label = s.playing ? 'Текст едет' : 'Пауза';
  }
  b.textContent = label;
  b.classList.toggle('rec-on', !!(RC.open && s && s.rec));
  $('#rcTitle').textContent = RC.open ? ((s && s.title) || (RC.script && RC.script.title) || 'Без названия') : 'Жду суфлёр';
  $('#rcWpm').textContent = s && RC.open ? s.wpm : '—';
  $('#rcFont').textContent = s && RC.open ? s.font : '—';
  const playing = !!(s && (s.playing || s.listening));
  $('#rcPlay').classList.toggle('on', playing);
  $('#rcsPlay').classList.toggle('on', playing);
  $('#rcPlay').setAttribute('aria-label', playing ? 'Пауза' : 'Пустить текст');
  const rec = $('#rcRec'), photo = s && s.capture === 'photo';
  rec.classList.toggle('on', !!(s && s.rec));
  rec.classList.toggle('photo', !!(photo && !(s && s.rec)));
  rec.setAttribute('aria-label', s && s.rec ? 'Остановить запись' : photo ? 'Сделать фото' : 'Начать запись');
  $$('#rcMode button').forEach(x => x.setAttribute('aria-checked', String(x.dataset.mode === ((s && s.capture) || 'video'))));
}
/* screen with the text */
function rcRenderText() {
  const s = RC.script;
  $('#rcText').innerHTML = s && s.text.trim() ? renderScript(s.text) : '<span class="muted">Текст появится, когда суфлёр подключится.</span>';
  rcRender();
  if (!$('#rcScreen').hidden) rcLayout();
}
function rcLayout() {
  if ($('#rcScreen').hidden) return;
  const font = rcFont(), t = $('#rcText');
  t.style.fontSize = font + 'px';
  const H = $('#rcView').clientHeight;
  RC.lineH = font * 1.35;
  RC.markerY = Math.round(clamp(H * 0.3, RC.lineH, H * 0.5));
  t.style.paddingTop = RC.markerY + 'px';
  t.style.paddingBottom = H + 'px';
  $('#rcMarker').style.top = (RC.markerY + RC.lineH / 2) + 'px';
  $('#rcMirror').style.transform = rcMirrorOn() ? 'scaleX(-1)' : '';
  $('#rcsMirror').setAttribute('aria-pressed', String(rcMirrorOn()));
  RC.ys = $$('#rcText .w').map(el => el.offsetTop);
  RC.max = Math.max(0, t.offsetHeight - H);
}
function rcTarget() {
  const p = RC.pos, ys = RC.ys, n = ys.length;
  if (!p || !n) return 0;
  const w = clamp(p.w, 0, n - 1), top = ys[w];
  let nx = w + 1;
  while (nx < n && ys[nx] <= top) nx++;
  const nextY = nx < n ? ys[nx] : top + RC.lineH;
  return clamp(top + p.f * (nextY - top) - RC.markerY, 0, RC.max);
}
function rcApply() { $('#rcText').style.transform = 'translate3d(0,' + (-RC.offset).toFixed(1) + 'px,0)'; }
function rcLoop(t) {
  RC.raf = requestAnimationFrame(rcLoop);
  const dt = RC.last ? Math.min(0.1, (t - RC.last) / 1000) : 0;
  RC.last = t;
  const d = rcTarget() - RC.offset;
  if (Math.abs(d) > 0.3) { RC.offset += d * Math.min(1, dt * 7); rcApply(); }
}
function rcBarShow() {
  $('#rcBar').classList.remove('hide');
  clearTimeout(RC.barT);
  RC.barT = setTimeout(() => $('#rcBar').classList.add('hide'), 3500);
}
function rcShowScreen(on) {
  $('#rcScreen').hidden = !on;
  $$('#rcTabs button').forEach(b => b.setAttribute('aria-checked', String((b.dataset.rc === 'screen') === on)));
  document.body.classList.toggle('locked', on);
  cancelAnimationFrame(RC.raf);
  if (on) {
    rcLayout();
    RC.offset = rcTarget();
    rcApply();
    RC.last = 0;
    RC.raf = requestAnimationFrame(rcLoop);
    rcBarShow();
    rcWake();
  }
}
async function rcWake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !RC.wake) {
      RC.wake = await navigator.wakeLock.request('screen');
      RC.wake.addEventListener('release', () => { RC.wake = null; });
    }
  } catch (e) {}
}

/* =====================================================================
   Settings
   ===================================================================== */
const SETTINGS_UI = [
  { group: 'Как едет текст', items: [
    { key: 'scrollMode', type: 'seg', label: 'Прокрутка', options: [['time', 'По темпу'], ['voice', 'По голосу']], hint: 'По голосу: текст едет, пока ты говоришь, и ждёт, когда молчишь. Нужны Siri, диктовка и интернет.' },
    { key: 'voiceLang', type: 'seg', label: 'Язык голоса', options: [['auto', 'Авто'], ['ru-RU', 'Русский'], ['en-US', 'English']], hint: 'Авто — по языку сценария.' },
    { key: 'wpm', type: 'range', label: 'Темп чтения', min: 60, max: 300, step: 10, fmt: v => v + ' слов/мин', hint: 'Для режима по темпу. Обычная речь — около 130.' },
    { key: 'autoScroll', type: 'toggle', label: 'Запускать текст вместе с записью' }
  ] },
  { group: 'Текст', items: [
    { key: 'font', type: 'range', label: 'Размер шрифта', min: 20, max: 72, step: 1, fmt: v => v + ' px' },
    { key: 'lineHeight', type: 'range', label: 'Межстрочный интервал', min: 1.1, max: 2, step: 0.05, fmt: v => (+v).toFixed(2).replace('.', ',') },
    { key: 'family', type: 'seg', label: 'Шрифт', options: [['golos', 'Гротеск'], ['serif', 'С засечками'], ['system', 'Системный']] },
    { key: 'align', type: 'seg', label: 'Выравнивание', options: [['left', 'Слева'], ['center', 'По центру']] }
  ] },
  { group: 'Окно суфлёра', items: [
    { key: 'panel', type: 'range', label: 'Высота окна с текстом', min: 25, max: 75, step: 1, fmt: v => v + '%' },
    { key: 'dim', type: 'range', label: 'Затемнение под текстом', min: 0, max: 90, step: 5, fmt: v => v + '%' },
    { key: 'marker', type: 'toggle', label: 'Метка строки чтения' },
    { key: 'mirrorText', type: 'toggle', label: 'Зеркалить текст', hint: 'Для суфлёра со стеклом перед камерой.' }
  ] },
  { group: 'Камера и запись', items: [
    { key: 'format', type: 'seg', label: 'Формат кадра', options: [['9:16', '9:16'], ['1:1', '1:1'], ['16:9', '16:9']], hint: '9:16 — Reels, TikTok, Shorts. 1:1 — лента. 16:9 — YouTube, лучше снимать горизонтально.' },
    { key: 'quality', type: 'seg', label: 'Качество', options: [['720', '720p'], ['1080', '1080p'], ['2160', '4K']], hint: 'В 4K минута видео ≈ 300 МБ. Если камера не отдаёт 4K в браузер, Суфлёр скажет об этом.' },
    { key: 'mirrorOutput', type: 'toggle', label: 'Зеркалить видео и фото', hint: 'Сохранённые файлы будут отражены, как в зеркале.' },
    { key: 'facing', type: 'seg', label: 'Камера', options: [['user', 'Фронтальная'], ['environment', 'Основная']] },
    { key: 'countdown', type: 'seg', label: 'Отсчёт перед съёмкой', options: [[0, 'Нет'], [3, '3 сек'], [5, '5 сек']] },
    { key: 'mirrorPreview', type: 'toggle', label: 'Зеркальное превью фронталки', hint: 'Только на экране. Как сохранится файл — решает «Зеркалить видео и фото».' },
    { key: 'voiceFx', type: 'toggle', label: 'Шумоподавление', hint: 'Выключи, если пишешь звук на петличку — так голос чище.' }
  ] }
];
function buildSettings() {
  const root = $('#settingsGroups');
  root.innerHTML = '';
  for (const g of SETTINGS_UI) {
    const sec = document.createElement('section');
    sec.className = 'set-group';
    sec.innerHTML = `<h2>${g.group}</h2>`;
    const card = document.createElement('div');
    card.className = 'set-card';
    sec.append(card);
    for (const it of g.items) {
      const row = document.createElement('div');
      row.className = 'set-row';
      const id = 'set-' + it.key;
      const v = S()[it.key];
      const hint = it.hint ? `<p class="hint">${it.hint}</p>` : '';
      if (it.type === 'range') {
        row.innerHTML = `<div class="set-head"><label for="${id}">${it.label}</label><output id="${id}-v" class="set-val" for="${id}">${it.fmt(v)}</output></div>` +
          `<input type="range" id="${id}" min="${it.min}" max="${it.max}" step="${it.step}" value="${v}">${hint}`;
        row.querySelector('input').addEventListener('input', e => {
          const nv = parseFloat(e.target.value);
          setSetting(it.key, nv);
          row.querySelector('output').textContent = it.fmt(nv);
        });
      } else if (it.type === 'seg') {
        row.innerHTML = `<div class="set-head"><span id="${id}-l">${it.label}</span></div>` +
          `<div class="seg" role="radiogroup" aria-labelledby="${id}-l">` +
          it.options.map((o, i) => `<button type="button" role="radio" id="${id}-${i}" data-i="${i}" aria-checked="${String(o[0]) === String(v)}">${o[1]}</button>`).join('') +
          `</div>${hint}`;
        row.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
          const val = it.options[+b.dataset.i][0];
          if (it.key === 'scrollMode' && val === 'voice' && !SR) { toast('Распознавание речи недоступно в этом браузере. На iPhone открой Суфлёр в Safari', 4500); return; }
          setSetting(it.key, val);
          row.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
        }));
      } else {
        row.innerHTML = `<div class="set-head"><label for="${id}">${it.label}</label><input type="checkbox" class="switch" id="${id}" ${v ? 'checked' : ''}></div>${hint}`;
        row.querySelector('input').addEventListener('change', e => setSetting(it.key, e.target.checked));
      }
      card.append(row);
    }
    root.append(sec);
  }
}
function setSetting(k, v) {
  S()[k] = v;
  save();
  renderPreview();
}
function renderPreview() {
  const s = S();
  const t = $('#pvText');
  t.innerHTML = marked('Смотри в камеру, а *текст* бежит сам.');
  t.style.fontSize = s.font + 'px';
  t.style.lineHeight = s.lineHeight;
  t.style.fontFamily = FAMILIES[s.family] || FAMILIES.golos;
  t.style.textAlign = s.align;
  t.style.transform = s.mirrorText ? 'scaleX(-1)' : '';
  const lh = s.font * s.lineHeight;
  $('#preview').style.setProperty('--dim', s.dim / 100);
  const m = $('#pvMarker');
  m.hidden = !s.marker;
  m.style.top = (14 + lh / 2) + 'px';
}
$('#resetSettings').addEventListener('click', async () => {
  if (!(await ask('Вернуть настройки суфлёра как было? Сценарии, записи и ключ ИИ не тронем.', 'Сбросить'))) return;
  data.settings = Object.assign({}, DEFAULTS);
  save();
  buildSettings();
  renderPreview();
  toast('Настройки сброшены');
});
/* AI settings */
function fillModelList() {
  const p = data.ai.provider;
  const list = aiModelCache[p] || [];
  $('#aiModels').innerHTML = list.map(m => `<option value="${esc(m)}"></option>`).join('');
}
function setCheckRes(text, cls) {
  const el = $('#aiCheckRes');
  el.textContent = text;
  el.className = 'hint' + (cls ? ' ' + cls : '');
}
function renderAiSettings() {
  const a = data.ai, p = a.provider;
  $$('#aiProv button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.p === p)));
  $('#aiProvHint').textContent = p === 'none' ? AI_NONE_HINT : AI_DEF[p].hint;
  $('#aiKeyRow').hidden = $('#aiModelRow').hidden = p === 'none';
  if (p !== 'none') {
    $('#aiKey').value = a.keys[p] || '';
    $('#aiKeyLink').href = AI_DEF[p].keyUrl;
    $('#aiKeyLink').textContent = 'Где взять ключ ' + AI_DEF[p].name;
    $('#aiModel').value = aiModel(p);
    $('#aiModel').placeholder = AI_DEF[p].model;
    fillModelList();
  }
  $('#aiAbout').value = a.about;
  setCheckRes('', '');
}
async function aiCheck() {
  const p = data.ai.provider;
  if (p === 'none') return;
  if (!(data.ai.keys[p] || '').trim()) { setCheckRes('Сначала вставь ключ', 'err'); return; }
  setCheckRes('Проверяю…', '');
  $('#aiCheck').disabled = true;
  try {
    let models = [];
    try { models = await aiListModels(p, data.ai.keys[p].trim()); }
    catch (e) { if (e.status === 401 || e.status === 403 || /страны/.test(e.message)) throw e; }
    if (models.length) {
      aiModelCache[p] = models;
      prefs.set('models.' + p, JSON.stringify(models));
      fillModelList();
      if (!models.includes(aiModel(p))) { data.ai.models[p] = pickModel(p, models); save(); $('#aiModel').value = data.ai.models[p]; }
    }
    await aiStream({ system: 'Отвечай одним словом.', user: 'Напиши слово: готово', maxTokens: 30 });
    setCheckRes('✓ Работает · ' + aiModel(p), 'ok');
  } catch (e) {
    setCheckRes('✗ ' + (e.message || 'Ошибка'), 'err');
  }
  $('#aiCheck').disabled = false;
  renderHintsState();
}
$('#aiProv').addEventListener('click', e => {
  const b = e.target.closest('[data-p]'); if (!b) return;
  data.ai.provider = b.dataset.p;
  save();
  renderAiSettings();
  renderHintsState();
});
$('#aiKey').addEventListener('input', e => {
  const p = data.ai.provider; if (p === 'none') return;
  data.ai.keys[p] = e.target.value.trim();
  saveSoon();
  setCheckRes('', '');
  renderHintsState();
});
$('#aiKeyShow').addEventListener('click', () => {
  const k = $('#aiKey'), show = k.type === 'password';
  k.type = show ? 'text' : 'password';
  $('#aiKeyShow').textContent = show ? 'Скрыть' : 'Показать';
});
$('#aiModel').addEventListener('change', e => {
  const p = data.ai.provider; if (p === 'none') return;
  data.ai.models[p] = e.target.value.trim().replace(/^models\//, '') || AI_DEF[p].model;
  e.target.value = data.ai.models[p];
  save();
});
$('#aiCheck').addEventListener('click', aiCheck);
$('#aiAbout').addEventListener('input', e => { data.ai.about = e.target.value; saveSoon(); });
$('#shareHelpBtn').addEventListener('click', () => { $('#shareHelp').hidden = false; });
['#shClose', '#shOk'].forEach(q => $(q).addEventListener('click', () => { $('#shareHelp').hidden = true; }));
$('#shareHelp').addEventListener('click', e => { if (e.target.id === 'shareHelp') $('#shareHelp').hidden = true; });

/* ---------- keyboard / remote clicker ---------- */
document.addEventListener('keydown', e => {
  if (!$('#confirm').hidden) { if (e.key === 'Escape') $('#cfNo').click(); return; }
  if (e.key === 'Escape') {
    if (!$('#shareHelp').hidden) { $('#shareHelp').hidden = true; return; }
    if (!$('#aiSheet').hidden) { closeAiSheet(); return; }
    if (!$('#remoteSheet').hidden) { $('#remoteSheet').hidden = true; return; }
    if (!$('#review').hidden) { closeReview(); return; }
    if (!$('#hStage').hidden) { $('#hsClose').click(); return; }
    if (!$('#rcScreen').hidden) { rcShowScreen(false); return; }
  }
  if (!$('#review').hidden || !$('#aiSheet').hidden || !$('#remoteSheet').hidden) return;
  if ($('#stage').hidden) { if (e.key === 'Escape' && !$('#editor').hidden) closeEditor(); return; }
  if (e.target.closest && e.target.closest('input, textarea')) return;
  switch (e.key) {
    case ' ': case 'PageDown': case 'ArrowRight': e.preventDefault(); togglePlay(); break;
    case 'ArrowUp': e.preventDefault(); changeWpm(10); break;
    case 'ArrowDown': e.preventDefault(); changeWpm(-10); break;
    case 'PageUp': case 'ArrowLeft': e.preventDefault(); nudge(-2); break;
    case 'Enter': e.preventDefault(); recToggle(); break;
    case 'Escape': closeStage(); break;
  }
});

/* self-test hooks, only with ?selftest in the address */
if (location.search.includes('selftest')) {
  window.__sufler = {
    say: words => voiceMatch(words.map(norm)),
    state: () => ({ cur: voice.cur, total: voice.words.length, target: Math.round(voice.target), offset: Math.round(st.offset), mode: S().scrollMode, lang: st.lang }),
    isQuestion,
    hear: t => hintsHeard(t),
    hints: () => ({ queue: H.queue.length, busy: H.busy, q: H.cur && H.cur.q, a: H.cur && H.cur.a, err: H.err, history: H.history.length }),
    remote: () => ({ id: RH.id, clients: RH.clients.size, status: RH.status, text: RH.statusText }),
    linePos
  };
}

/* ---------- start ---------- */
const remoteMatch = location.hash.match(/remote=([A-Za-z0-9_-]{6,64})/);
if (remoteMatch) {
  startRemoteClient(remoteMatch[1]);
} else {
  buildSettings();
  renderPreview();
  showTab(prefs.get('tab') || 'scripts');
  loadTakes();
}
})();
