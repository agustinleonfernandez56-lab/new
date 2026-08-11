'use strict';

// ─── Config ──────────────────────────────────────────────────────────────────
const API = window.location.origin;
const TOKEN_KEY = 'chatOpToken';
const CHATS_PER_PAGE = 11;
const POLL_CLIENTS_MS = 5000;
const POLL_MESSAGES_MS = 3500;

// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  clients: [],
  activeSessionId: null,
  activeMessages: [],
  activeClient: null,
  chatLastReadAt: null,
  filter: 'all',
  search: '',
  page: 1,

  clientPollTimer: null,
  msgPollTimer: null,
  activePaymentStatus: 'none',
  activePaymentStatuses: { insurance: 'none', return: 'none', loantransfer: 'none', creditcard: 'none' },
  scenarioTexts: {},     // тексты этапов из админки (грузим один раз после входа)
  smsEntries: [],        // история SMS активного клиента — по ней ловим ручные отправки
  noteDrafts: {},
  noteSaving: {},
  notes: [],             // общие заметки операторов (с сервера)
  unreadBySession: {},   // flowSessionId -> кол-во непрочитанных (для звука о новом сообщении)
  soundReady: false,     // первый loadClients только выставляет базу, без звука
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const els = {
  loginWrap:    $('#loginWrap'),
  workspace:    $('#workspace'),
  loginForm:    $('#loginForm'),
  loginUser:    $('#loginUser'),
  loginPass:    $('#loginPass'),
  loginBtn:     $('#loginBtn'),
  loginErr:     $('#loginErr'),
  totalCount:   $('[data-total-count]'),
  filter:       $('[data-filter]'),
  search:       $('[data-search]'),
  searchClear:  $('[data-search-clear]'),
  conversations:$('[data-conversations]'),
  pagination:   $('[data-chat-pagination]'),
  profile:      $('[data-profile]'),
  chatDate:     $('[data-chat-date]'),
  messages:     $('[data-messages]'),
  messageForm:  $('[data-message-form]'),
  messageInput: $('[data-message-input]'),
  mainInfo:     $('[data-main-info]'),
  clientData:   $('[data-client-data]'),
  stages:       $('[data-stages]'),

  chatNoteInput:  $('#chatNoteInput'),
  chatNoteSave:   $('#chatNoteSave'),
  chatNoteDelete: $('#chatNoteDelete'),
  chatNoteStatus: $('#chatNoteStatus'),
  imageInput:   $('[data-image-input]'),
  imageBtn:     $('[data-image-btn]'),
  balanceDisp:  $('#clientBalanceDisp'),
  chargeAmount: $('#chargeAmountInp'),
  chargeDesc:   $('#chargeDescInp'),
  chargeBtn:    $('#chargeBtnEl'),
  chargeResult: $('#chargeResultMsg'),
  balanceModeBtns: document.querySelectorAll('[data-balance-mode]'),
  debitoBtn:    $('#debitoBtn'),
  debitoModal:  $('#debitoModal'),
  debitoClose:  $('#debitoModalClose'),
  addAccountNotice: $('#addAccountNotice'),
  demoNoticeModal: $('#demoNoticeModal'),
  demoNoticeOk: $('#demoNoticeOk'),
  balanceTargetBtns: document.querySelectorAll('[data-balance-target]'),
  balanceModeGroup: $('#balanceModeGroup'),
  balanceOperationFields: $('#balanceOperationFields'),
  startChatBar: $('#startChatBar'),
  startChatBtn: $('#startChatBtn'),
  // Общие заметки оператора
  opNoteInput:  $('#opNoteInput'),
  opNoteAddBtn: $('#opNoteAddBtn'),
  opNoteOpenBtn:$('#opNoteOpenBtn'),
  notesModal:   $('#notesModal'),
  notesModalClose: $('#notesModalClose'),
  notesModalInput: $('#notesModalInput'),
  notesModalAdd:   $('#notesModalAdd'),
  notesModalList:  $('#notesModalList'),
};

let balanceMode = 'charge';

const STATUS_NEW = 'ЗАПРОСИЛ ЗВОНОК (ЧЕРЕЗ ЧАТ)';

// ─── Utilities ───────────────────────────────────────────────────────────────
function isImg(s) { return typeof s === 'string' && s.startsWith('/uploads/'); }
function getPaymentScreenshot(s) {
  if (typeof s !== 'string') return null;
  if (s.startsWith('PAYMENT_SCREENSHOT_LOAN_TRANSFER:')) {
    return {
      type: 'loantransfer',
      url: s.slice('PAYMENT_SCREENSHOT_LOAN_TRANSFER:'.length),
      title: 'Пользователь отправил скриншот оплаты RD2',
    };
  }
  if (s.startsWith('PAYMENT_SCREENSHOT_CREDIT_CARD:')) {
    return {
      type: 'creditcard',
      url: s.slice('PAYMENT_SCREENSHOT_CREDIT_CARD:'.length),
      title: 'Пользователь отправил скриншот оплаты RD3',
    };
  }
  if (s.startsWith('PAYMENT_SCREENSHOT_RETURN:')) {
    return {
      type: 'return',
      url: s.slice('PAYMENT_SCREENSHOT_RETURN:'.length),
      title: 'Пользователь отправил скриншот оплаты RD',
    };
  }
  if (s.startsWith('PAYMENT_SCREENSHOT:')) {
    return {
      type: 'insurance',
      url: s.slice('PAYMENT_SCREENSHOT:'.length),
      title: 'Пользователь отправил скриншот оплаты',
    };
  }
  return null;
}
function isPaymentScreenshot(s) { return !!getPaymentScreenshot(s); }
function paymentStatusesFrom(data) {
  return {
    insurance: data?.paymentStatuses?.insurance || data?.paymentStatus || 'none',
    return: data?.paymentStatuses?.return || 'none',
    loantransfer: data?.paymentStatuses?.loantransfer || 'none',
    creditcard: data?.paymentStatuses?.creditcard || 'none',
  };
}
function hasPendingPaymentStatus(statuses) {
  return statuses.insurance === 'pending'
    || statuses.return === 'pending'
    || statuses.loantransfer === 'pending'
    || statuses.creditcard === 'pending';
}

async function uploadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1200;
        let { width: w, height: h } = img;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(async (blob) => {
          const fd = new FormData();
          fd.append('image', blob, 'photo.jpg');
          try {
            const res = await fetch(API + '/api/upload-image', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + state.token },
              body: fd,
            });
            const data = await res.json();
            if (data && data.url) resolve(data.url);
            else reject(new Error(data?.error || 'Upload failed'));
          } catch (err) { reject(err); }
        }, 'image/jpeg', 0.85);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatMessageText(v) {
  return esc(v).replace(/\r\n|\r|\n/g, '<br>');
}

const MESSAGE_EDIT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.63L7 19.66a2 2 0 0 0 .83-.5Z"/><path d="m15 5 4 4"/></svg>';
const MESSAGE_COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('copy_failed');
}

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

const CHAT_DATE_MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
let chatFloatingDateTimer = null;
let suppressChatFloatingDate = false;

function chatDateKey(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function chatDateLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (chatDateKey(d.toISOString()) === chatDateKey(today.toISOString())) return 'Сегодня';
  if (chatDateKey(d.toISOString()) === chatDateKey(yesterday.toISOString())) return 'Вчера';
  const year = d.getFullYear() === today.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${CHAT_DATE_MONTHS_GEN[d.getMonth()]}${year}`;
}

function ensureChatFloatingDate() {
  if (!els.messages?.parentElement) return null;
  let el = els.messages.parentElement.querySelector('.chat-floating-date');
  if (!el) {
    el = document.createElement('div');
    el.className = 'chat-floating-date';
    els.messages.parentElement.appendChild(el);
  }
  return el;
}

function currentVisibleChatDateLabel() {
  if (!els.messages) return '';
  const items = Array.from(els.messages.querySelectorAll('[data-message-date]'));
  if (!items.length) return '';
  const boxTop = els.messages.getBoundingClientRect().top;
  let label = items[0].dataset.messageDate || '';
  for (const item of items) {
    if (item.getBoundingClientRect().top <= boxTop + 34) {
      label = item.dataset.messageDate || label;
    } else {
      break;
    }
  }
  return label;
}

function showChatFloatingDate() {
  if (suppressChatFloatingDate) return;
  const el = ensureChatFloatingDate();
  const label = currentVisibleChatDateLabel();
  if (!el || !label) return;
  const boxRect = els.messages.getBoundingClientRect();
  const parentRect = el.parentElement.getBoundingClientRect();
  el.style.top = `${Math.max(8, boxRect.top - parentRect.top + 8)}px`;
  el.textContent = label;
  el.classList.add('is-visible');
  clearTimeout(chatFloatingDateTimer);
  chatFloatingDateTimer = setTimeout(() => {
    el.classList.remove('is-visible');
  }, 850);
}

function bindChatDateScroll() {
  if (!els.messages || els.messages.dataset.dateScrollBound === '1') return;
  els.messages.dataset.dateScrollBound = '1';
  els.messages.addEventListener('scroll', showChatFloatingDate, { passive: true });
}

function nowDT() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2,'0');
  return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : String(name||'?').slice(0,2).toUpperCase();
}

const AVATAR_COLORS = ['#f20b5d','#1166ff','#56c46f','#ff8200','#7360e8','#ff5b46'];
function avatarColor(name) { let h=0; for(const c of String(name)) h=(h*31+c.charCodeAt(0))&0xffff; return AVATAR_COLORS[h%AVATAR_COLORS.length]; }

// Туристам (clientType === 'olduser') показываем фото-аватарку (фон убран), остальным — инициалы.
const TOURIST_AVATAR_URL = 'data:image/png;base64,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';
function avatarHtml(c) {
  const name = (c && (c.nombre || c.email)) || 'Cliente';
  if (c && c.clientType === 'olduser') {
    return `<div class="avatar" style="overflow:hidden;background:#1a2a40"><img src="${TOURIST_AVATAR_URL}" alt="" style="width:86%;height:86%;object-fit:contain" /></div>`;
  }
  return `<div class="avatar" style="background:${avatarColor(name)}">${esc(initials(name))}</div>`;
}

// ─── API ─────────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function tryLogin(login, password) {
  els.loginBtn.disabled = true;
  els.loginErr.textContent = '';
  try {
    const data = await fetch(API + '/api/chat-op/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password }),
    }).then((r) => r.json());
    if (data.token) {
      state.token = data.token;
      localStorage.setItem(TOKEN_KEY, data.token);
      showWorkspace();
    } else {
      els.loginErr.textContent = data.error || 'Ошибка входа';
    }
  } catch {
    els.loginErr.textContent = 'Сервер недоступен';
  }
  els.loginBtn.disabled = false;
}

function showLogin() {
  els.loginWrap.style.display = 'flex';
  els.workspace.style.display = 'none';
}

function showWorkspace() {
  els.loginWrap.style.display = 'none';
  els.workspace.style.display = '';
  loadClients();
  loadScenarioTexts();
  startClientPoll();
}

// ─── Звук нового сообщения от лида ────────────────────────────────────────────
// Синтезируем короткий «динь-динь» через Web Audio API — без внешних файлов.
const SOUND_MUTED_KEY = 'chatOpSoundMuted';
let audioCtx = null;
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* нет Web Audio — тихо игнорируем */ }
  return audioCtx;
}
function playNewMessageSound() {
  if (localStorage.getItem(SOUND_MUTED_KEY) === '1') return;
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = 0.16;
    master.connect(ctx.destination);
    // Две мягкие ноты подряд — как уведомление о сообщении.
    [{ f: 880, t: 0 }, { f: 1244, t: 0.11 }].forEach(({ f, t }) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const start = now + t;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(1, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.19);
      osc.connect(g); g.connect(master);
      osc.start(start); osc.stop(start + 0.22);
    });
  } catch (e) { /* non-fatal */ }
}
// Разблокируем аудио на первом действии оператора (политика автоплея браузера).
['pointerdown', 'keydown'].forEach((ev) =>
  window.addEventListener(ev, ensureAudio, { once: true }));

// Кнопка вкл/выкл звука
const soundToggleBtn = $('#soundToggle');
function refreshSoundToggle() {
  if (!soundToggleBtn) return;
  const muted = localStorage.getItem(SOUND_MUTED_KEY) === '1';
  soundToggleBtn.textContent = muted ? '🔕' : '🔔';
  soundToggleBtn.classList.toggle('is-muted', muted);
  soundToggleBtn.title = muted ? 'Звук выключен' : 'Звук новых сообщений';
}
if (soundToggleBtn) {
  refreshSoundToggle();
  soundToggleBtn.addEventListener('click', () => {
    const muted = localStorage.getItem(SOUND_MUTED_KEY) === '1';
    localStorage.setItem(SOUND_MUTED_KEY, muted ? '0' : '1');
    refreshSoundToggle();
    if (muted) { ensureAudio(); playNewMessageSound(); } // включили — сразу проиграть образец
  });
}

// ─── Перевод входящих сообщений (ИИ, на русский) ──────────────────────────────
// Перевод делается на сервере в фоне и хранится в БД (message.translation).
// Кнопка только переключает, что показывать: оригинал или готовый перевод.
const TRANSLATE_ON_KEY = 'chatOpTranslateOn';
const translateToggleBtn = $('#translateToggle');
function translateOn() { return localStorage.getItem(TRANSLATE_ON_KEY) === '1'; }
function refreshTranslateToggle() {
  if (!translateToggleBtn) return;
  const on = translateOn();
  translateToggleBtn.classList.toggle('is-active', on);
  translateToggleBtn.title = on ? 'Перевод входящих включён' : 'Перевод входящих на русский';
}
if (translateToggleBtn) {
  refreshTranslateToggle();
  translateToggleBtn.addEventListener('click', () => {
    localStorage.setItem(TRANSLATE_ON_KEY, translateOn() ? '0' : '1');
    refreshTranslateToggle();
    renderMessages(state.activeMessages, state.activeClient?.callerNote);
    renderConversations();
  });
}

// ─── Clients ─────────────────────────────────────────────────────────────────
async function loadClients() {
  try {
    const data = await api('/api/chat-op/clients');
    if (data.error === 'unauthorized') { showLogin(); return; }
    state.clients = data.clients || [];

    // Звук, если у кого-то из лидов прибавилось непрочитанных (клиент написал).
    const nextUnread = {};
    let hasNewClientMsg = false;
    for (const c of state.clients) {
      const u = c.unreadCount || 0;
      nextUnread[c.flowSessionId] = u;
      if (u > (state.unreadBySession[c.flowSessionId] || 0)) hasNewClientMsg = true;
    }
    state.unreadBySession = nextUnread;
    if (state.soundReady && hasNewClientMsg) playNewMessageSound();
    state.soundReady = true; // первый проход — только база, без звука

    renderConversations();
    // Обновляем активного клиента из свежего списка
    if (state.activeSessionId) {
      const fresh = state.clients.find((x) => x.flowSessionId === state.activeSessionId);
      if (fresh) {
        state.activeClient = { ...state.activeClient, ...fresh };
      }
    }
  } catch {}
}

function startClientPoll() {
  clearInterval(state.clientPollTimer);
  state.clientPollTimer = setInterval(loadClients, POLL_CLIENTS_MS);
}

function startMsgPoll() {
  clearInterval(state.msgPollTimer);
  if (!state.activeSessionId) return;
  state.msgPollTimer = setInterval(async () => {
    try {
      const data = await api('/api/chat-op/messages/' + encodeURIComponent(state.activeSessionId));
      const newReadAt = data.chatLastReadAt || null;
      const readChanged = newReadAt !== state.chatLastReadAt;
      const nextPaymentStatuses = paymentStatusesFrom(data);
      const psChanged = nextPaymentStatuses.insurance !== state.activePaymentStatuses.insurance
        || nextPaymentStatuses.return !== state.activePaymentStatuses.return
        || nextPaymentStatuses.creditcard !== state.activePaymentStatuses.creditcard;
      // Перевод дописывается в фоне позже самого сообщения — ловим его появление отдельно
      const trCount = (arr) => (arr || []).reduce((n, m) => n + (m.translation ? 1 : 0), 0);
      const trChanged = trCount(data.messages) !== trCount(state.activeMessages);
      // Структурные изменения: появление id у только что отправленного (→ canEdit/карандаш)
      // и правки (editedAt) — в т.ч. от других операторов.
      const sig = (arr) => (arr || []).map((m) => (m.id || '') + ':' + (m.editedAt || '')).join('|');
      const structChanged = sig(data.messages) !== sig(state.activeMessages);
      if (data.messages && (data.messages.length > state.activeMessages.length || readChanged || psChanged || trChanged || structChanged)) {
        state.chatLastReadAt = newReadAt;
        state.activeMessages = data.messages;
        state.activePaymentStatus = nextPaymentStatuses.insurance;
        state.activePaymentStatuses = nextPaymentStatuses;
        renderMessages(state.activeMessages, state.activeClient?.callerNote);
        updateConversationIndicator(state.activeSessionId, state.activeMessages);
        // Чек-лист зависит и от статуса оплаты, и от текстов сообщений
        // (ручную отправку он засчитывает как шаг) — перерисовываем всегда.
        renderStages(state.activeClient);
      }
    } catch {}
  }, POLL_MESSAGES_MS);
}

// ─── Indicator ───────────────────────────────────────────────────────────────
function getIndicator(lastMsg) {
  if (!lastMsg) return 'gray';
  if (lastMsg.role === 'user') return 'green';
  return 'yellow';
}

// Сколько сообщений клиента (user) после последнего сообщения оператора — непрочитанные.
function countUnread(messages) {
  if (!messages || !messages.length) return 0;
  let lastOpIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'operator') { lastOpIdx = i; break; }
  }
  let cnt = 0;
  for (let i = lastOpIdx + 1; i < messages.length; i++) {
    if (messages[i].role === 'user') cnt++;
  }
  return cnt;
}

function updateConversationIndicator(sessionId, messages) {
  const c = state.clients.find((x) => x.flowSessionId === sessionId);
  const unread = countUnread(messages);
  if (c) c.unreadCount = unread;
  const row = document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`);
  if (!row) return;
  const meta = row.querySelector('.conversation-meta');
  if (!meta) return;

  // Remove all existing indicators
  meta.querySelectorAll('.reply-needed, .coin-indicator, .unread-badge').forEach((el) => el.remove());

  if (c?.paymentPending) {
    const coin = document.createElement('span');
    coin.className = 'coin-indicator';
    coin.textContent = '💰';
    meta.appendChild(coin);
  } else if (unread > 0) {
    const b = document.createElement('span');
    b.className = 'unread-badge';
    b.setAttribute('aria-label', 'Непрочитанных: ' + unread);
    b.textContent = unread > 99 ? '99+' : String(unread);
    meta.appendChild(b);
  }
}

// ─── Render conversations ─────────────────────────────────────────────────────
function getVisibleClients() {
  const q = state.search.trim().toLowerCase();
  return state.clients.filter((c) => {
    const matchFilter = state.filter === 'all'
      || (state.filter === 'new' && c.status === STATUS_NEW)
      || (state.filter === 'unanswered' && (c.unreadCount || 0) > 0)
      || (state.filter === 'payment' && c.paymentPending === true)
      || (state.filter === 'photo' && c.hasPhoto === true)
      || (state.filter === 'requisite-snowflake' && c.requisiteStatus === 'snowflake')
      || (state.filter === 'requisite-sun' && c.requisiteStatus === 'sun')
      || (state.filter === 'requisite-cloud' && c.requisiteStatus === 'cloud');
    const matchSearch = !q || `${c.nombre||''} ${c.email||''}`.toLowerCase().includes(q);
    return matchFilter && matchSearch;
  });
}

function renderConversations() {
  const focusedNoteInput = document.activeElement?.matches?.('[data-chat-note-input]')
    ? {
        sessionId: document.activeElement.dataset.noteSessionId,
        start: document.activeElement.selectionStart,
        end: document.activeElement.selectionEnd,
      }
    : null;
  const visible = getVisibleClients();
  const total = visible.length;
  const totalPages = Math.max(1, Math.ceil(total / CHATS_PER_PAGE));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * CHATS_PER_PAGE;
  const page = visible.slice(start, start + CHATS_PER_PAGE);

  els.totalCount.textContent = total;
  els.searchClear.hidden = !state.search;

  els.conversations.innerHTML = page.map((c) => {
    const name = c.nombre || c.email || 'Cliente';
    const requisiteIcon = c.requisiteStatus === 'snowflake'
      ? '<span class="requisite-chat-status requisite-chat-status--snowflake" title="Оплата после обновления реквизитов" aria-label="Снежинка">❄️</span>'
      : c.requisiteStatus === 'sun'
        ? '<span class="requisite-chat-status requisite-chat-status--sun" title="Срок после обновления реквизитов: до 24 часов" aria-label="Солнышко">☀️</span>'
        : c.requisiteStatus === 'cloud'
          ? '<span class="requisite-chat-status requisite-chat-status--cloud" title="Срок после обновления реквизитов: 24–72 часа" aria-label="Солнышко с тучкой">⛅️</span>'
          : '';
    const ind = getIndicator(c.lastMsg);
    const isNew = c.status === STATUS_NEW;
    const unread = c.unreadCount || 0;
    // Вместо зелёного/жёлтого кружка — счётчик непрочитанных сообщений клиента (как в TG).
    const dot = c.paymentPending
      ? '<span class="coin-indicator" aria-label="Ожидает оплаты">💰</span>'
      : isNew
        ? '<span class="new-badge">NEW</span>'
        : unread > 0
          ? `<span class="unread-badge" aria-label="Непрочитанных: ${unread}">${unread > 99 ? '99+' : unread}</span>`
          : '';
    const active = c.flowSessionId === state.activeSessionId ? ' active' : '';
    const preview = c.lastMsg
      ? (isPaymentScreenshot(c.lastMsg.content) ? '📎 Скриншот оплаты'
        : isImg(c.lastMsg.content) ? '📷 Изображение'
        : esc(((translateOn() && c.lastMsg.role === 'user' && c.lastMsg.translation) ? c.lastMsg.translation : c.lastMsg.content).slice(0, 40)))
      : '&nbsp;';
    const timeStr = fmtTime(c.lastMsg?.createdAt || c.calledAt || c.createdAt);
    const statusClass = isNew ? '' : ind === 'green' ? 'online' : ind === 'yellow' ? 'hold' : 'pending';
    const statusText = isNew ? '' : ind === 'green' ? '● Нужен ответ' : ind === 'yellow' ? '⏱ Ответил' : '⌛ Ожидает';
    const noteOriginal = c.callerNote || '';
    const hasDraft = Object.prototype.hasOwnProperty.call(state.noteDrafts, c.flowSessionId);
    const noteValue = hasDraft ? state.noteDrafts[c.flowSessionId] : noteOriginal;
    const noteDirty = noteValue.trim() !== noteOriginal.trim();
    const noteSaving = !!state.noteSaving[c.flowSessionId];
    return `<article class="conversation${active}" data-session-id="${esc(c.flowSessionId)}" tabindex="0">
      ${avatarHtml(c)}
      <div class="conversation-main">
        <strong><span class="conversation-name">${esc(name)}</span>${requisiteIcon}</strong>
        <p style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${preview}</p>
        <small class="${statusClass}">${statusText}</small>
      </div>
      <div class="conversation-meta"><time>${timeStr}</time>${dot}</div>
      <div class="conversation-note">
        <textarea class="conversation-note__input" data-chat-note-input data-note-session-id="${esc(c.flowSessionId)}" rows="2" maxlength="500" aria-label="Комментарий к чату" autocomplete="off">${esc(noteValue)}</textarea>
        <button class="conversation-note__save${noteDirty ? ' is-dirty' : ''}" data-chat-note-save data-note-session-id="${esc(c.flowSessionId)}" type="button" ${(!noteDirty || noteSaving) ? 'disabled' : ''} title="Сохранить комментарий">✓</button>
        <span class="conversation-note__status" data-chat-note-status></span>
      </div>
    </article>`;
  }).join('');

  if (focusedNoteInput?.sessionId) {
    const nextInput = Array.from(els.conversations.querySelectorAll('[data-chat-note-input]'))
      .find((input) => input.dataset.noteSessionId === focusedNoteInput.sessionId);
    if (nextInput) {
      nextInput.focus();
      const pos = Math.min(nextInput.value.length, focusedNoteInput.start ?? nextInput.value.length);
      const end = Math.min(nextInput.value.length, focusedNoteInput.end ?? pos);
      nextInput.setSelectionRange(pos, end);
    }
  }

  renderPagination(totalPages);
  updatePaymentBell();
}

function updatePaymentBell() {
  const bell = document.getElementById('paymentBell');
  if (!bell) return;
  const hasPending = state.clients.some((c) => c.paymentPending);
  bell.classList.toggle('payment-bell--active', hasPending);
}

function renderPagination(totalPages) {
  if (totalPages <= 1) { els.pagination.innerHTML = ''; return; }
  const windowSize = 5;
  const halfWindow = Math.floor(windowSize / 2);
  let groupStart = Math.max(1, state.page - halfWindow);
  let groupEnd = Math.min(totalPages, groupStart + windowSize - 1);
  groupStart = Math.max(1, groupEnd - windowSize + 1);
  const pages = Array.from({ length: groupEnd - groupStart + 1 }, (_, i) => groupStart + i);
  const prevDis = state.page === 1 ? ' disabled' : '';
  const nextDis = state.page === totalPages ? ' disabled' : '';
  els.pagination.innerHTML =
    `<button type="button" class="page-arrow"${prevDis} data-page-shift="-1" aria-label="Назад">‹</button>` +
    pages.map((p) => `<button type="button" class="${p === state.page ? 'active' : ''}" data-page="${p}"${p === state.page ? ' aria-current="page"' : ''}>${p}</button>`).join('') +
    `<button type="button" class="page-arrow"${nextDis} data-page-shift="1" aria-label="Вперёд">›</button>`;
}

// ─── Start bar (NEW chats) ────────────────────────────────────────────────────
function renderStartBar() {
  const c = state.activeClient;
  const isNew = c && c.status === STATUS_NEW;
  const hasOperatorMsg = state.activeMessages.some((m) => m.role === 'operator' || m.role === 'system');
  const show = isNew && !hasOperatorMsg;
  if (els.startChatBar) els.startChatBar.style.display = show ? 'flex' : 'none';
  if (els.messageForm) els.messageForm.style.display = show ? 'none' : '';
}

// ─── Select client ────────────────────────────────────────────────────────────
async function selectClient(sessionId) {
  state.activeSessionId = sessionId;
  clearInterval(state.msgPollTimer);

  const c = state.clients.find((x) => x.flowSessionId === sessionId);
  state.activeClient = c || null;
  // Сбрасываем до загрузки — иначе чек-лист на миг посчитает шаги по данным
  // прошлого клиента (его оплате, сообщениям и СМС).
  state.activePaymentStatuses = { insurance: 'none', return: 'none', loantransfer: 'none', creditcard: 'none' };
  state.activePaymentStatus = 'none';
  state.activeMessages = [];
  state.smsEntries = [];

  renderConversations();
  renderProfile(c);
  renderDetails(c);

  renderStartBar();
  try {
    const data = await api('/api/chat-op/messages/' + encodeURIComponent(sessionId));
    // Оператор мог за время запроса переключиться на другого клиента: медленный
    // ответ не должен затирать уже открытый чат — иначе на экране один клиент,
    // а сообщение уходит другому.
    if (sessionId !== state.activeSessionId) return;
    state.activeMessages = data.messages || [];
    state.chatLastReadAt = data.chatLastReadAt || null;
    state.activePaymentStatuses = paymentStatusesFrom(data);
    state.activePaymentStatus = state.activePaymentStatuses.insurance;
    if (data.client) state.activeClient = { ...c, ...data.client, callerNote: data.callerNote };
    renderMessages(state.activeMessages, data.callerNote);
    renderDetails(state.activeClient);
    renderStartBar();
  } catch {}

  if (sessionId !== state.activeSessionId) return;
  startMsgPoll();
  loadSmsHistory(sessionId);
  refreshBanButton(sessionId);
  updateCommissionGate();
}

// ─── Render profile ───────────────────────────────────────────────────────────
function renderProfile(c) {
  if (!c) { els.profile.innerHTML = '<span style="color:var(--muted);font-size:13px">Выберите клиента</span>'; return; }
  const name = c.nombre || c.email || 'Cliente';
  els.profile.innerHTML = `
    ${avatarHtml(c)}
    <div><strong>${esc(name)}</strong><p>${esc(c.bank || c.ip || '—')}</p></div>`;
}


// ─── Render messages ──────────────────────────────────────────────────────────
function renderMessages(messages, callerNote) {
  let html = '';
  if (callerNote) {
    html += `<div style="align-self:center;background:#1a2a40;border-radius:8px;padding:8px 14px;font-size:12px;color:var(--interface-accent);text-align:center;max-width:80%;margin-bottom:8px">
      <strong style="color:#94a5bd;font-size:11px;display:block;margin-bottom:2px">📞 Комментарий прозвонщика</strong>
      ${formatMessageText(callerNote)}</div>`;
  }
  const readAt = state.chatLastReadAt ? new Date(state.chatLastReadAt) : null;
  let lastDateKey = '';
  html += messages.map((m) => {
    const isOut = m.role === 'operator';
    const isAi = m.role === 'assistant';
    const cls = isOut ? 'outgoing' : 'incoming';
    const imageContent = isImg(m.content);
    const prefix = isAi ? '<span style="font-size:10px;color:#94a5bd;display:block;margin-bottom:3px">🤖 ИИ-ассистент</span>' : '';
    const msgDateKey = chatDateKey(m.createdAt);
    const msgDateLabel = chatDateLabel(m.createdAt);
    const dateAttrs = msgDateLabel ? ` data-message-date="${esc(msgDateLabel)}" data-message-date-key="${esc(msgDateKey)}"` : '';
    let dateSeparator = '';
    if (msgDateKey && msgDateKey !== lastDateKey) {
      lastDateKey = msgDateKey;
      dateSeparator = `<div class="chat-date-separator" data-chat-date-separator="${esc(msgDateKey)}">${esc(msgDateLabel)}</div>`;
    }
    let tick = '';
    if (isOut) {
      const msgAt = m.createdAt ? new Date(m.createdAt) : null;
      const isRead = readAt && msgAt && msgAt <= readAt;
      tick = isRead
        ? '<span class="msg-tick msg-tick--read">✓✓</span>'
        : '<span class="msg-tick">✓</span>';
    }
    const markerLabels = {
      CALLER_ACTION_BUTTONS: '📩 Отправлены кнопки действий',
      OFFER_BUTTONS: '🎁 Отправлены кнопки офферов',
      '[[RETURN_PAY]]': '💳 Отправлена кнопка оплаты RD',
      '[[LOAN_TRANSFER_PAY]]': '💳 Отправлена кнопка оплаты RD2',
      '[[COMMISSION_PAY]]': '💳 Отправлена кнопка оплаты RD3',
    };
    if (markerLabels[m.content]) {
      return `${dateSeparator}<div class="bubble ${cls}"${dateAttrs}><em style="opacity:.8">${markerLabels[m.content]}</em><time>${fmtTime(m.createdAt)}${tick}</time></div>`;
    }
    const payment = getPaymentScreenshot(m.content);
    if (payment) {
      const imgUrl = esc(payment.url);
      const sid = esc(state.activeSessionId || '');
      const paymentType = esc(payment.type);
      const ps = state.activePaymentStatuses[payment.type] || 'none';
      let actionBtns;
      if (ps === 'confirmed') {
        actionBtns = `<button class="payment-card__btn payment-card__btn--view" data-img-preview="${imgUrl}">Посмотреть</button>
          <button class="payment-card__btn payment-card__btn--confirm" disabled style="opacity:.65;cursor:default">Подтверждено ✓</button>`;
      } else if (ps === 'rejected') {
        actionBtns = `<button class="payment-card__btn payment-card__btn--view" data-img-preview="${imgUrl}">Посмотреть</button>
          <button class="payment-card__btn payment-card__btn--reject" disabled style="opacity:.65;cursor:default">Отказано ✗</button>`;
      } else {
        actionBtns = `<button class="payment-card__btn payment-card__btn--view" data-img-preview="${imgUrl}">Посмотреть</button>
          <button class="payment-card__btn payment-card__btn--confirm" data-payment-confirm="${sid}" data-payment-type="${paymentType}" data-screenshot="${imgUrl}">Подтвердить</button>
          <button class="payment-card__btn payment-card__btn--reject" data-payment-reject="${sid}" data-payment-type="${paymentType}">Отказать</button>`;
      }
      return `${dateSeparator}<div class="payment-card"${dateAttrs}>
        <div class="payment-card__header">
          <span class="payment-card__icon">💰</span>
          <span class="payment-card__title">${esc(payment.title)}</span>
          <time class="payment-card__time">${fmtTime(m.createdAt)}</time>
        </div>
        <div class="payment-card__actions">${actionBtns}</div>
      </div>`;
    }
    if (imageContent) {
      const imgSrc = esc(m.content);
      let statusMenu = '';
      // На скриншоте, присланном клиентом прямо в чат, даём оператору выставить
        // Статус оплаты FD/RD1/RD2/RD3 — та же цепочка, что и кнопка «Подтвердить» на payment-card.
      if (m.role === 'user') {
        const st = state.activePaymentStatuses || {};
        const mkItem = (type, label) => {
          const done = st[type] === 'confirmed';
          return `<button type="button" class="img-status-menu__item${done ? ' is-done' : ''}" data-set-payment-status="${type}" data-screenshot="${imgSrc}">`
            + `<span>${label}</span>${done ? '<span class="img-status-menu__check">✓</span>' : ''}</button>`;
        };
        statusMenu = `<div class="img-status">
          <button type="button" class="img-status__toggle" data-img-status-toggle aria-label="Изменить статус оплаты" title="Статус оплаты">⋮</button>
          <div class="img-status-menu" role="menu">
            <div class="img-status-menu__title">Статус оплаты</div>
            ${mkItem('insurance', 'FD')}
            ${mkItem('return', 'RD1')}
            ${mkItem('loantransfer', 'RD2')}
            ${mkItem('creditcard', 'RD3')}
            <button type="button" class="img-status-menu__item img-status-menu__item--cancel" data-cancel-payment-status>Отменить</button>
          </div>
        </div>`;
      }
      return `${dateSeparator}<div class="bubble bubble--image ${cls}"${dateAttrs}>${prefix}<img src="${imgSrc}" alt="" data-img-preview="${imgSrc}" />${statusMenu}<time>${fmtTime(m.createdAt)}${tick}</time></div>`;
    }
    let body = formatMessageText(m.content);
    if (m.role === 'user' && translateOn() && m.translation) {
      body = `<span class="msg-translated-label">🌐 перевод</span>${formatMessageText(m.translation)}`
        + `<span class="msg-original">${formatMessageText(m.content)}</span>`;
    }
    let editedBadge = '';
    if (m.editedAt) {
      const hist = Array.isArray(m.history) ? m.history : [];
      const tip = hist.length
        ? hist.map((h, i) => `<div class="msg-edited__ver"><b>${i + 1}.</b> ${formatMessageText(h.content)}</div>`).join('')
        : '<div class="msg-edited__ver" style="opacity:.7">версии недоступны</div>';
      editedBadge = `<span class="msg-edited" tabindex="0">изменено<span class="msg-edited__tip"><div class="msg-edited__tiptitle">Прежние версии:</div>${tip}</span></span>`;
    }
    const editBtn = (m.canEdit && m.id)
      ? `<button type="button" class="msg-action-btn msg-edit-btn" data-edit-msg="${esc(m.id)}" data-edit-text="${esc(m.content)}" title="Редактировать" aria-label="Редактировать сообщение">${MESSAGE_EDIT_ICON}</button>`
      : '';
    const copyBtn = `<button type="button" class="msg-action-btn msg-copy-btn" data-copy-msg="${esc(m.content)}" title="Копировать" aria-label="Копировать сообщение">${MESSAGE_COPY_ICON}</button>`;
    const messageActions = `<span class="msg-actions" role="group" aria-label="Действия сообщения">${editBtn}${copyBtn}</span>`;
    return `${dateSeparator}<div class="bubble bubble--text-actions ${cls}"${dateAttrs}>${prefix}${body}${messageActions}<time>${fmtTime(m.createdAt)}${editedBadge}${tick}</time></div>`;
  }).join('');
  els.messages.innerHTML = html;
  bindChatDateScroll();
  const floatingDate = ensureChatFloatingDate();
  if (floatingDate) floatingDate.classList.remove('is-visible');
  suppressChatFloatingDate = true;
  els.messages.scrollTop = els.messages.scrollHeight;
  setTimeout(() => { suppressChatFloatingDate = false; }, 120);
  if (els.chatDate) els.chatDate.textContent = messages.length ? fmt(messages[0].createdAt).split(' ')[0] : nowDT().split(' ')[0];
}

// ─── Render details ───────────────────────────────────────────────────────────
function renderDetails(c) {
  renderChatNote(c);
  if (!c) {
    els.mainInfo.innerHTML = ''; els.clientData.innerHTML = '';
    if (els.stages) els.stages.innerHTML = '<div class="stages__empty">Выберите клиента</div>';
    return;
  }
  const name = c.nombre || '—';
  const sub = (c.submissionData && typeof c.submissionData === 'object') ? c.submissionData : {};

  els.mainInfo.innerHTML = [
    ['Имя', esc(name)],
    ['Email', esc(c.email || '—')],
    ['Банк', esc(c.bank || '—')],
    ['IP', esc(c.ip || '—')],
    ['Регистрация', esc(fmt(c.createdAt))],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  const clientRows = [
    sub.dni ? ['DNI/NIE', esc(sub.dni)] : null,
    sub.iban ? ['IBAN', esc(sub.iban)] : null,
    sub.calle ? ['Адрес', esc([sub.calle, sub.ciudad, sub.cp].filter(Boolean).join(', '))] : null,
    sub.phone ? ['Телефон', esc(sub.phone)] : null,
    sub.chatOpNote ? ['Заметка чат-оп.', esc(sub.chatOpNote)] : null,
  ].filter(Boolean);
  els.clientData.innerHTML = clientRows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') || '<dt style="color:var(--muted)">Нет данных</dt>';

  renderStages(c);

  renderBalance(c);
  if (els.chargeAmount) els.chargeAmount.value = '';
  if (els.chargeDesc) els.chargeDesc.value = '';
  if (els.chargeResult) els.chargeResult.textContent = '';
  updateChargeBtn();
}

// ─── Этапы обработки (сценарий FD / RD; оплаты RD2/RD3 ведутся отдельно) ─────
// Чек-лист, который ведёт оператора по сценарию: слева галочка (серая/зелёная),
// справа кнопка одного действия. Тексты сообщений и СМС правятся в админке
// (вкладка «Сценарий»), сюда приходят через /api/chat-op/scenario.
const STAGE_GROUPS = [
  {
    key: 'fd',
    name: 'ФД',
    steps: [
      { id: 'fdWelcomeMsg', label: 'Приветственное сообщение',  action: 'chat', textKey: 'scenarioFdWelcomeMsg' },
      { id: 'fdWelcomeSms', label: 'Приветственное смс',        action: 'sms',  textKey: 'scenarioFdWelcomeSms' },
      { id: 'fdPaid',       label: 'Получил оплату ФД',         action: 'auto', paymentType: 'insurance' },
      { id: 'fdPaidMsg',    label: 'Подтвердил оплату',         action: 'chat', textKey: 'scenarioFdPaidMsg' },
      { id: 'fdPaidSms',    label: 'Подтвердил оплату смс',     action: 'sms',  textKey: 'scenarioFdPaidSms' },
    ],
  },
  {
    key: 'rd',
    name: 'РД1',
    steps: [
      // Тот же документ, что и «Страховка» в меню скрепки.
      { id: 'rdDoc',        label: 'Отправил страховку',      action: 'chat',   text: '[[SEGURO]]' },
      { id: 'rdIbanReq',    label: 'Запросил iban',           action: 'chat',   textKey: 'scenarioRdIbanReq' },
      { id: 'rdCharge',     label: 'Списал 5000€ с баланса',  action: 'charge', amount: 5000, divider: 'Получил IBAN клиента' },
      { id: 'rdChargeSms',  label: 'Отправил смс-списание',   action: 'sms',    textKey: 'scenarioRdChargeSms' },
      { id: 'rdPaymentSet', label: 'Сформировал платеж',      action: 'chat',   textKey: 'scenarioRdPaymentSet' },
      { id: 'rdPayReq',     label: 'Запросил оплату',         action: 'chat',   textKey: 'scenarioRdPayReq', divider: 'Пропал на 15 минут' },
      { id: 'rdPaid',       label: 'Получил оплату',          action: 'auto',   paymentType: 'return', divider: 'Скинь кнопку RD1' },
      { id: 'rdThanks',     label: 'Поблагодарил за оплату',  action: 'chat',   textKey: 'scenarioRdThanks' },
    ],
  },
  {
    key: 'rd2',
    name: 'РД2',
    steps: [
      { id: 'rd2StartMsg',   label: 'Стартовое сообщение',    action: 'chat', textKey: 'scenarioRd2StartMsg' },
      { id: 'rd2StartMsg2',  label: 'Стартовое сообщение 2',  action: 'chat', textKey: 'scenarioRd2StartMsg2' },
      // Заводит клиенту debet-карту и зачисляет на неё компенсацию —
      // то же, что вручную через «Баланс» → «Карта».
      { id: 'rd2Comp',       label: 'Выплатил компенсацию',   action: 'compensation', amount: 600 },
      { id: 'rd2PaidNotify', label: 'Уведомил о выплате',     action: 'chat', textKey: 'scenarioRd2PaidNotify' },
      { id: 'rd2Sms',        label: 'Уведомил клиента СМС',   action: 'sms',  textKey: 'scenarioRd2Sms', divider: 'Выбери банк', requiresRd2Bank: true },
      { id: 'rd2PayReq',     label: 'Запросил оплату',        action: 'chat', textKey: 'scenarioRd2PayReq', requiresRd2Bank: true },
      { id: 'rd2Paid',       label: 'Получил оплату РД2',     action: 'auto', paymentType: 'loantransfer', divider: 'Скинь кнопку RD2' },
    ],
  },
];

// Текст шага: либо фиксированный (служебные токены вроде [[NOTIF_PDF]]),
// либо настраиваемый в админке.
function stageStepText(step) {
  return step.text || state.scenarioTexts?.[step.textKey] || '';
}

async function loadScenarioTexts() {
  try { state.scenarioTexts = await api('/api/chat-op/scenario') || {}; }
  catch { state.scenarioTexts = {}; }
  if (state.activeClient) renderStages(state.activeClient);
}

function scenarioStepsOf(c) {
  const sub = (c?.submissionData && typeof c.submissionData === 'object') ? c.submissionData : {};
  return (sub.scenarioSteps && typeof sub.scenarioSteps === 'object') ? sub.scenarioSteps : {};
}

function rd2BankSelected(c) {
  const sub = (c?.submissionData && typeof c.submissionData === 'object') ? c.submissionData : {};
  return !!(sub.rd2Bank && sub.rd2Bank.key);
}

// Сравниваем тексты «на глаз оператора»: лишние пробелы, переносы и регистр
// не должны мешать засчитать шаг.
function normStageText(v) {
  return String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Шаг «получил оплату» ведём не по галочке оператора, а по реальному статусу
// платежа — тому же, что красит статистику в админке. Остальные шаги считаем
// выполненными и тогда, когда оператор отправил тот же текст вручную.
function stageStepDone(step, c) {
  if (step.action === 'auto') return state.activePaymentStatuses?.[step.paymentType] === 'confirmed';
  // Списание видим по самой транзакции — не важно, кнопкой этапа его сделали
  // или вручную через «Баланс».
  if (step.action === 'charge') {
    const txs = Array.isArray(c?.transactions) ? c.transactions : [];
    return txs.some((t) => t?.type === 'debit' && Math.round(Number(t.amount)) === step.amount);
  }
  // Компенсация — зачисление на debet-карту, тоже видим по транзакции.
  if (step.action === 'compensation') {
    const txs = Array.isArray(c?.transactions) ? c.transactions : [];
    return txs.some((t) => t?.type === 'card_credit' && Math.round(Number(t.amount)) === step.amount);
  }
  if (scenarioStepsOf(c)[step.id]) return true;

  const want = normStageText(stageStepText(step));
  if (!want) return false;
  if (step.action === 'sms') {
    return (state.smsEntries || []).some((e) => e.ok !== false && normStageText(e.text) === want);
  }
  return (state.activeMessages || []).some((m) => m.role === 'operator' && normStageText(m.content) === want);
}

// Сценарий идёт только вперёд: если оператор перескочил через шаг, вернуться
// к нему уже нельзя — кнопка гаснет. Считаем по сквозному порядку всех групп,
// чтобы правило работало и когда добавятся РД и РД2.
function stageStepStates(c) {
  const all = STAGE_GROUPS.flatMap((g) => g.steps);
  const done = all.map((s) => stageStepDone(s, c));
  let lastDone = -1;
  done.forEach((d, i) => { if (d) lastDone = i; });
  const byId = {};
  all.forEach((step, i) => {
    // Авто-шаг («получил оплату») не пропускают — оплата может прийти и позже,
    // поэтому пропущенными помечаем только действия оператора.
    const locked = !done[i] && i < lastDone && step.action !== 'auto';
    byId[step.id] = { done: done[i], locked };
  });
  return byId;
}

// Сервер списания возвращает только новый баланс, поэтому транзакцию
// дописываем локально — иначе галочка шага «Списал» ждала бы опроса списка.
function applyLocalCharge(sessionId, amount, newBalance) {
  const tx = { id: 'local-' + Date.now(), type: 'debit', amount, description: 'Transferencia al IBAN', date: new Date().toISOString() };
  const apply = (client) => {
    if (!client) return;
    client.transactions = [...(Array.isArray(client.transactions) ? client.transactions : []), tx];
    if (newBalance != null) client.balance = newBalance;
  };
  apply(state.activeClient);
  apply(state.clients.find((x) => x.flowSessionId === sessionId));
  renderBalance(state.activeClient);
}

// Кнопка шага: подпись зависит от типа действия.
// Зачисление на карту — как и списание, сервер отдаёт только результат,
// поэтому транзакцию дописываем локально, чтобы галочка встала сразу.
function applyLocalCardCredit(sessionId, amount) {
  const tx = { id: 'local-' + Date.now(), type: 'card_credit', amount, description: 'Recarga de tarjeta', date: new Date().toISOString() };
  const apply = (client) => {
    if (!client) return;
    client.transactions = [...(Array.isArray(client.transactions) ? client.transactions : []), tx];
  };
  apply(state.activeClient);
  apply(state.clients.find((x) => x.flowSessionId === sessionId));
}

function stageBtnLabel(step) {
  return 'Выполнить';
}

function renderStages(c) {
  if (!els.stages) return;
  if (!c) { els.stages.innerHTML = '<div class="stages__empty">Выберите клиента</div>'; return; }

  const states = stageStepStates(c);
  const stepNumbers = new Map(STAGE_GROUPS.flatMap((g) => g.steps).map((step, i) => [step.id, i + 1]));
  const allSteps = STAGE_GROUPS.flatMap((g) => g.steps);
  const totalDone = allSteps.filter((s) => states[s.id].done).length;
  els.stages.innerHTML = STAGE_GROUPS.map((group, groupIndex) => {
    const doneCount = group.steps.filter((s) => states[s.id].done).length;
    const rows = group.steps.map((step) => {
      const { done, locked } = states[step.id];
      const bankBlocked = !!step.requiresRd2Bank && !rd2BankSelected(c);
      let action;
      if (step.action === 'auto') {
        action = done
          ? '<button type="button" class="stage-step__btn stage-step__btn--done" disabled>Выполнено</button>'
          : '<span class="stage-step__auto">Ждём</span>';
      } else if (done) {
        action = '<button type="button" class="stage-step__btn stage-step__btn--done" disabled>Выполнено</button>';
      } else if (locked) {
        action = '<button type="button" class="stage-step__btn stage-step__btn--locked" disabled title="Этап пропущен — вернуться к нему нельзя">Пропущено</button>';
      } else if (bankBlocked) {
        action = '<button type="button" class="stage-step__btn stage-step__btn--blocked" disabled title="Сначала выберите банк-получатель для РД2">Выполнить</button>';
      } else {
        action = `<button type="button" class="stage-step__btn" data-stage-step="${step.id}">${stageBtnLabel(step)}</button>`;
      }
      // Разделитель — просто веха сценария, в прогресс и блокировку не входит.
      const divider = step.divider
        ? `<div class="stage-divider"><span>${esc(step.divider)}</span></div>`
        : '';
      return `${divider}<div class="stage-step${done ? ' is-done' : ''}${locked ? ' is-locked' : ''}${bankBlocked ? ' is-bank-blocked' : ''}">
        <span class="stage-step__marker">${done ? '+' : (locked ? '−' : stepNumbers.get(step.id))}</span>
        <span class="stage-step__label">${esc(step.label)}</span>
        ${action}
      </div>`;
    }).join('');
    const complete = doneCount === group.steps.length;
    return `<div class="stage-group${groupIndex === STAGE_GROUPS.length - 1 ? ' stage-group--last' : ''}">
      <div class="stage-group__head">
        <span class="stage-group__name">${esc(group.name)}</span>
        <span class="stage-group__progress${complete ? ' is-complete' : ''}">${doneCount}/${group.steps.length}</span>
      </div>
      ${rows}
    </div>`;
  }).join('') + `<div class="stages__total">${totalDone}/${allSteps.length}</div><div class="stages__error" data-stages-error></div>`;
}

function stageError(msg) {
  const box = els.stages?.querySelector('[data-stages-error]');
  if (!box) return;
  box.textContent = msg || '';
  if (msg) setTimeout(() => { if (box.textContent === msg) box.textContent = ''; }, 5000);
}

// Отмечаем шаг выполненным на сервере — галочка переживает перезаход
// и видна другому оператору, если клиента передали.
async function markStageStepDone(sessionId, stepId) {
  const data = await api('/api/chat-op/scenario-step', { method: 'POST', body: { sessionId, step: stepId, done: true } });
  const steps = data?.scenarioSteps || {};
  const apply = (client) => {
    if (!client) return;
    const sub = (client.submissionData && typeof client.submissionData === 'object') ? client.submissionData : {};
    client.submissionData = { ...sub, scenarioSteps: steps };
  };
  apply(state.activeClient);
  apply(state.clients.find((x) => x.flowSessionId === sessionId));
}

async function runStageStep(stepId, btn) {
  const step = STAGE_GROUPS.flatMap((g) => g.steps).find((s) => s.id === stepId);
  const sid = state.activeSessionId;
  if (!step || !sid) return;

  // Кнопка пропущенного шага и так disabled — это страховка от гонки рендера.
  const st = stageStepStates(state.activeClient)[step.id];
  if (st?.locked) { stageError('Этап пропущен — вернуться к нему нельзя.'); return; }
  if (st?.done) return;
  if (step.requiresRd2Bank && !rd2BankSelected(state.activeClient)) {
    stageError('Сначала выберите банк-получатель для РД2.');
    return;
  }

  const text = stageStepText(step).trim();
  const needsText = step.action !== 'charge' && step.action !== 'compensation';
  if (needsText && !text) {
    stageError('Текст не задан — заполните его в админке, вкладка «Сценарий».');
    return;
  }

  const sub = (state.activeClient?.submissionData && typeof state.activeClient.submissionData === 'object')
    ? state.activeClient.submissionData : {};
  const phone = String(sub.phone || '').trim();
  if (step.action === 'sms' && !phone) { stageError('У клиента не указан телефон — СМС отправить нельзя.'); return; }

  if (step.action === 'charge'
    && !window.confirm(`Списать ${fmtEur(step.amount)} с баланса клиента?`)) return;

  if (step.action === 'compensation'
    && !window.confirm(`Выплатить компенсацию ${fmtEur(step.amount)}?\nКлиенту будет добавлен debet-счёт и зачислена эта сумма.`)) return;

  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⌛';
  stageError('');
  try {
    if (step.action === 'sms') {
      const res = await api('/api/chat-op/send-sms', { method: 'POST', body: { phone, text, sessionId: sid } });
      if (!res?.ok) throw new Error(res?.error || 'СМС не отправлено');
      loadSmsHistory(sid);
    } else if (step.action === 'charge') {
      const res = await api('/api/chat-op/charge', { method: 'POST', body: { sessionId: sid, amount: step.amount } });
      if (!res?.ok) throw new Error(res?.error || 'Списание не прошло');
      applyLocalCharge(sid, step.amount, res.balance);
    } else if (step.action === 'compensation') {
      // Сначала счёт (повторный вызов безопасен — сервер вернёт существующий),
      // затем зачисление: без карты пополнение отдало бы no_card.
      const acc = await api('/api/chat-op/add-account', { method: 'POST', body: { sessionId: sid } });
      if (!acc?.ok) throw new Error(acc?.error || 'Не удалось добавить debet-счёт');
      const res = await api('/api/chat-op/card-refund', { method: 'POST', body: { sessionId: sid, amount: step.amount } });
      if (!res?.ok) throw new Error(res?.error || 'Компенсация не прошла');
      applyLocalCardCredit(sid, step.amount);
      if (balanceTarget === 'demo') { await loadCardState(); updateBalanceModeUi(); }
    } else {
      await sendOperatorMsg(text, sid);
    }
    // Списание и компенсацию отслеживаем по транзакциям — отметка им не нужна.
    if (needsText) await markStageStepDone(sid, step.id);
    renderStages(state.activeClient);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = orig;
    stageError('✗ ' + (err?.message || 'Ошибка'));
  }
}

if (els.stages) els.stages.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-stage-step]');
  if (btn) runStageStep(btn.dataset.stageStep, btn);
});

// ─── Balance display ─────────────────────────────────────────────────────────
function fmtEur(v) {
  // Панель оператора: целое число, точки как разделители тысяч (€5.000)
  return '€' + Math.round(Number(v)).toLocaleString('es-ES', { maximumFractionDigits: 0 });
}

function renderBalance(c) {
  if (!els.balanceDisp) return;
  if (balanceTarget === 'demo') {
    els.balanceDisp.textContent = fmtEur(cardState.balance || 0);
    return;
  }
  const txt = c && c.balance != null ? fmtEur(c.balance) : (c ? '...' : '—');
  els.balanceDisp.textContent = txt;
}


// ─── Заметка по чату (per-chat, хранится в callerNote) ────────────────────────
function renderChatNote(c) {
  if (!els.chatNoteInput) return;
  const has = !!c;
  els.chatNoteInput.value = (c && c.callerNote) ? c.callerNote : '';
  els.chatNoteInput.disabled = !has;
  els.chatNoteSave.disabled = !has;
  els.chatNoteDelete.disabled = !has || !(c && c.callerNote);
  els.chatNoteStatus.textContent = '';
}

function setClientNote(sessionId, note) {
  const val = note || null;
  const c = state.clients.find((x) => x.flowSessionId === sessionId);
  if (c) c.callerNote = val;
  if (state.activeSessionId === sessionId && state.activeClient) {
    state.activeClient.callerNote = val;
  }
  return val;
}

async function saveNoteForSession(sessionId, note) {
  if (!sessionId) return null;
  await api('/api/chat-op/note', { method: 'PUT', body: { sessionId, note } });
  delete state.noteDrafts[sessionId];
  return setClientNote(sessionId, note);
}

async function saveChatNote(note) {
  if (!state.activeSessionId) return;
  els.chatNoteStatus.textContent = 'Сохраняю…';
  els.chatNoteSave.disabled = true;
  try {
    const val = await saveNoteForSession(state.activeSessionId, note);
    els.chatNoteStatus.textContent = note ? '✓ Сохранено' : '✓ Удалено';
    els.chatNoteDelete.disabled = !note;
    renderMessages(state.activeMessages, val); // обновляем плашку заметки в переписке
    renderConversations();
    setTimeout(() => { if (els.chatNoteStatus) els.chatNoteStatus.textContent = ''; }, 2000);
  } catch {
    els.chatNoteStatus.textContent = '✗ Ошибка';
  } finally {
    els.chatNoteSave.disabled = !state.activeSessionId;
  }
}

function updateConversationNoteState(input) {
  const sessionId = input?.dataset?.noteSessionId;
  if (!sessionId) return;
  const c = state.clients.find((x) => x.flowSessionId === sessionId);
  const original = (c && c.callerNote) ? c.callerNote : '';
  const value = input.value;
  const dirty = value.trim() !== original.trim();
  if (dirty) state.noteDrafts[sessionId] = value;
  else delete state.noteDrafts[sessionId];

  const wrap = input.closest('.conversation-note');
  const btn = wrap?.querySelector('[data-chat-note-save]');
  const status = wrap?.querySelector('[data-chat-note-status]');
  if (btn) {
    btn.disabled = !dirty || !!state.noteSaving[sessionId];
    btn.classList.toggle('is-dirty', dirty);
  }
  if (status) {
    status.textContent = '';
    status.classList.remove('is-error');
  }
}

async function saveConversationNote(input) {
  const sessionId = input?.dataset?.noteSessionId;
  if (!sessionId || state.noteSaving[sessionId]) return;
  const note = input.value.trim();
  const wrap = input.closest('.conversation-note');
  const btn = wrap?.querySelector('[data-chat-note-save]');
  const status = wrap?.querySelector('[data-chat-note-status]');
  state.noteSaving[sessionId] = true;
  if (btn) btn.disabled = true;
  if (status) {
    status.textContent = '...';
    status.classList.remove('is-error');
  }
  let saved = false;
  try {
    const val = await saveNoteForSession(sessionId, note);
    saved = true;
    input.value = val || '';
    if (btn) btn.classList.remove('is-dirty');
    if (status) status.textContent = 'OK';
    if (state.activeSessionId === sessionId) {
      if (els.chatNoteInput) els.chatNoteInput.value = val || '';
      if (els.chatNoteDelete) els.chatNoteDelete.disabled = !val;
      renderMessages(state.activeMessages, val);
      renderChatNote(state.activeClient);
    }
    setTimeout(() => {
      if (status && status.textContent === 'OK') status.textContent = '';
    }, 1400);
  } catch {
    if (status) {
      status.textContent = 'ERR';
      status.classList.add('is-error');
    }
  } finally {
    delete state.noteSaving[sessionId];
    if (saved) {
      if (btn) {
        btn.disabled = true;
        btn.classList.remove('is-dirty');
      }
    } else {
      updateConversationNoteState(input);
    }
  }
}

// ─── Общие заметки операторов (на сервере) ────────────────────────────────────
function fmtNoteTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const PROMISE_MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const PROMISE_MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
let promiseCalendarMonthDate = null;
let promiseSelectedDate = null;

function padDatePart(n) {
  return String(n).padStart(2, '0');
}
function dateKeyFromDate(d) {
  return `${d.getFullYear()}-${padDatePart(d.getMonth() + 1)}-${padDatePart(d.getDate())}`;
}
function parseDateKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return null;
  const parts = key.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return Number.isNaN(d.getTime()) ? null : d;
}
function promiseDateForNote(note) {
  if (note && /^\d{4}-\d{2}-\d{2}$/.test(String(note.promiseDate || ''))) return note.promiseDate;
  if (note?.createdAt) {
    const d = new Date(note.createdAt);
    if (!Number.isNaN(d.getTime())) return dateKeyFromDate(d);
  }
  return dateKeyFromDate(new Date());
}
function validDateKey(key) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(key || '')) ? String(key) : '';
}
function setPromiseSelectedDate(key) {
  const valid = validDateKey(key) || dateKeyFromDate(new Date());
  promiseSelectedDate = valid;
  if (promiseCalendarModal) promiseCalendarModal.dataset.selectedDate = valid;
  if (promiseCalendarGrid) promiseCalendarGrid.dataset.selectedDate = valid;
  if (promiseNoteInput) promiseNoteInput.dataset.promiseDate = valid;
  if (promiseNoteAdd) promiseNoteAdd.dataset.promiseDate = valid;
  return valid;
}
function getSelectedPromiseDate() {
  ensurePromiseCalendarDate();
  return validDateKey(promiseCalendarModal?.dataset.selectedDate)
    || validDateKey(promiseCalendarGrid?.dataset.selectedDate)
    || validDateKey(promiseNoteInput?.dataset.promiseDate)
    || validDateKey(promiseNoteAdd?.dataset.promiseDate)
    || validDateKey(promiseSelectedDate)
    || setPromiseSelectedDate(dateKeyFromDate(new Date()));
}
function formatPromiseDateLabel(key) {
  const d = parseDateKey(key) || new Date();
  return `${d.getDate()} ${PROMISE_MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
}

async function loadNotes() {
  try {
    const data = await api('/api/chat-op/notes');
    state.notes = (data && data.notes) || [];
  } catch { state.notes = []; }
  renderNotesModal();
  renderPromiseCalendar();
}

function renderNotesModal() {
  if (!els.notesModalList) return;
  if (!state.notes.length) {
    els.notesModalList.innerHTML = '<div style="color:var(--muted,#7a90aa);font-size:13px;text-align:center;padding:14px 0">Заметок пока нет</div>';
    return;
  }
  els.notesModalList.innerHTML = state.notes.map((n) => {
    const edited = n.updatedAt && n.updatedAt !== n.createdAt;
    const time = edited ? ('изм. ' + fmtNoteTime(n.updatedAt)) : fmtNoteTime(n.createdAt);
    const link = n.sessionId
      ? `<a href="#" class="note-card__chat" data-note-chat="${esc(n.sessionId)}">💬 ${esc(n.clientName || 'Открыть чат')}</a>`
      : '';
    return `<div class="note-card" data-note-id="${esc(n.id)}">
      <div class="note-card__text" data-note-text>${esc(n.text)}</div>
      <textarea class="note-card__edit" data-note-edit rows="2" style="display:none"></textarea>
      ${link}
      <div class="note-card__foot">
        <span class="note-card__time">🕒 ${esc(time)}</span>
        <div class="note-card__actions">
          <button type="button" data-note-action="edit">✎ Изменить</button>
          <button type="button" class="note-del" data-note-action="delete">🗑 Удалить</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

async function addNote(text, promiseDate) {
  const t = (text || '').trim();
  if (!t) return;
  // Привязываем к открытому сейчас чату, чтобы из заметки можно было к нему вернуться
  const c = state.activeClient;
  const body = { text: t };
  if (state.activeSessionId) {
    body.sessionId = state.activeSessionId;
    body.clientName = (c && (c.nombre || c.email)) || '';
  }
  const selectedPromiseDate = validDateKey(promiseDate);
  if (selectedPromiseDate) body.promiseDate = selectedPromiseDate;
  try {
    const data = await api('/api/chat-op/notes', { method: 'POST', body });
    state.notes = (data && data.notes) || state.notes;
    renderNotesModal();
    renderPromiseCalendar();
  } catch {}
}

async function updateNote(id, text, promiseDate) {
  const t = (text || '').trim();
  if (!t) return;
  const body = { text: t };
  const selectedPromiseDate = validDateKey(promiseDate);
  if (selectedPromiseDate) body.promiseDate = selectedPromiseDate;
  try {
    const data = await api('/api/chat-op/notes/' + encodeURIComponent(id), { method: 'PUT', body });
    state.notes = (data && data.notes) || state.notes;
    renderNotesModal();
    renderPromiseCalendar();
  } catch {}
}

async function deleteNote(id) {
  try {
    const data = await api('/api/chat-op/notes/' + encodeURIComponent(id), { method: 'DELETE' });
    state.notes = (data && data.notes) || state.notes;
    renderNotesModal();
    renderPromiseCalendar();
  } catch {}
}

function openNotesModal() {
  if (!els.notesModal) return;
  els.notesModal.style.display = 'flex';
  loadNotes();
  if (els.notesModalInput) els.notesModalInput.focus();
}
function closeNotesModal() {
  if (els.notesModal) els.notesModal.style.display = 'none';
}

// ─── Events ───────────────────────────────────────────────────────────────────
// Login
els.loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  tryLogin(els.loginUser.value.trim(), els.loginPass.value);
});

// Filter
els.filter.addEventListener('change', () => {
  state.filter = els.filter.value;
  state.page = 1;
  renderConversations();
});

// Search
els.search.addEventListener('input', () => {
  state.search = els.search.value;
  state.page = 1;
  renderConversations();
});

els.searchClear.addEventListener('click', () => {
  els.search.value = '';
  state.search = '';
  state.page = 1;
  renderConversations();
  els.search.focus();
});

// Conversations
els.conversations.addEventListener('click', (e) => {
  const saveBtn = e.target.closest('[data-chat-note-save]');
  if (saveBtn) {
    e.preventDefault();
    e.stopPropagation();
    const wrap = saveBtn.closest('.conversation-note');
    const input = wrap?.querySelector('[data-chat-note-input]');
    saveConversationNote(input);
    return;
  }
  if (e.target.closest('[data-chat-note-input]')) return;
  const item = e.target.closest('[data-session-id]');
  if (!item) return;
  selectClient(item.dataset.sessionId);
});

els.conversations.addEventListener('keydown', (e) => {
  const noteInput = e.target.closest('[data-chat-note-input]');
  if (noteInput) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveConversationNote(noteInput);
    } else if (e.key === 'Escape') {
      const sessionId = noteInput.dataset.noteSessionId;
      const c = state.clients.find((x) => x.flowSessionId === sessionId);
      noteInput.value = (c && c.callerNote) ? c.callerNote : '';
      delete state.noteDrafts[sessionId];
      updateConversationNoteState(noteInput);
      noteInput.blur();
    }
    return;
  }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const item = e.target.closest('[data-session-id]');
  if (!item) return;
  e.preventDefault();
  selectClient(item.dataset.sessionId);
});

els.conversations.addEventListener('input', (e) => {
  const input = e.target.closest('[data-chat-note-input]');
  if (!input) return;
  updateConversationNoteState(input);
});

els.conversations.addEventListener('focusout', (e) => {
  const input = e.target.closest('[data-chat-note-input]');
  if (!input) return;
  updateConversationNoteState(input);
});

// ── Общие заметки: шапка + модалка ──
if (els.opNoteAddBtn) {
  els.opNoteAddBtn.addEventListener('click', function () {
    addNote(els.opNoteInput.value);
    els.opNoteInput.value = '';
  });
}
if (els.opNoteInput) {
  els.opNoteInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addNote(els.opNoteInput.value); els.opNoteInput.value = ''; }
  });
}
if (els.opNoteOpenBtn) els.opNoteOpenBtn.addEventListener('click', openNotesModal);
if (els.notesModalClose) els.notesModalClose.addEventListener('click', closeNotesModal);
if (els.notesModal) {
  els.notesModal.addEventListener('click', function (e) { if (e.target === els.notesModal) closeNotesModal(); });
}
if (els.notesModalAdd) {
  els.notesModalAdd.addEventListener('click', function () {
    addNote(els.notesModalInput.value);
    els.notesModalInput.value = '';
  });
}
if (els.notesModalInput) {
  els.notesModalInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addNote(els.notesModalInput.value); els.notesModalInput.value = ''; }
  });
}
if (els.notesModalList) {
  els.notesModalList.addEventListener('click', function (e) {
    // Ссылка на чат — открыть тот чат, где писали заметку
    const chatLink = e.target.closest('[data-note-chat]');
    if (chatLink) {
      e.preventDefault();
      const sid = chatLink.dataset.noteChat;
      closeNotesModal();
      selectClient(sid);
      return;
    }
    const card = e.target.closest('[data-note-id]');
    if (!card) return;
    const id = card.dataset.noteId;
    const action = e.target.closest('[data-note-action]')?.dataset.noteAction;
    if (action === 'delete') {
      deleteNote(id);
    } else if (action === 'edit') {
      const textEl = card.querySelector('[data-note-text]');
      const editEl = card.querySelector('[data-note-edit]');
      const note = state.notes.find((n) => n.id === id);
      editEl.value = note ? note.text : textEl.textContent;
      textEl.style.display = 'none';
      editEl.style.display = 'block';
      editEl.focus();
    }
  });
  els.notesModalList.addEventListener('keydown', function (e) {
    const editEl = e.target.closest('[data-note-edit]');
    if (!editEl) return;
    const card = editEl.closest('[data-note-id]');
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      updateNote(card.dataset.noteId, editEl.value);
    } else if (e.key === 'Escape') {
      renderNotesModal();
    }
  });
}

// ── Календарь Обещунов: только открытие/закрытие макета ───────────────────────
const promiseCalendarBtn = document.getElementById('promiseCalendarBtn');
const promiseCalendarModal = document.getElementById('promiseCalendarModal');
const promiseCalendarClose = document.getElementById('promiseCalendarClose');
const promiseCalendarGrid = document.getElementById('promiseCalendarGrid');
const promiseCalendarMonth = document.getElementById('promiseCalendarMonth');
const promiseCalendarPrev = document.getElementById('promiseCalendarPrev');
const promiseCalendarNext = document.getElementById('promiseCalendarNext');
const promiseSelectedDateEl = document.getElementById('promiseSelectedDate');
const promiseNoteInput = document.getElementById('promiseNoteInput');
const promiseNoteAdd = document.getElementById('promiseNoteAdd');
const promiseNotesList = document.getElementById('promiseNotesList');

function ensurePromiseCalendarDate() {
  setPromiseSelectedDate(promiseSelectedDate);
  if (!promiseCalendarMonthDate) {
    const d = parseDateKey(promiseSelectedDate) || new Date();
    promiseCalendarMonthDate = new Date(d.getFullYear(), d.getMonth(), 1);
  }
}

function renderPromiseCalendar() {
  if (!promiseCalendarGrid || !promiseCalendarMonth || !promiseSelectedDateEl || !promiseNotesList) return;
  ensurePromiseCalendarDate();
  const selectedDate = getSelectedPromiseDate();

  const year = promiseCalendarMonthDate.getFullYear();
  const month = promiseCalendarMonthDate.getMonth();
  promiseCalendarMonth.textContent = `${PROMISE_MONTHS[month]} ${year}`;

  const noteDates = new Set((state.notes || []).map(promiseDateForNote));
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - startOffset);
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = dateKeyFromDate(d);
    const muted = d.getMonth() !== month ? ' is-muted' : '';
    const hasNote = noteDates.has(key) ? ' has-note' : '';
    const selected = key === selectedDate ? ' is-selected' : '';
    cells.push(`<button class="${(muted + hasNote + selected).trim()}" type="button" data-promise-date="${esc(key)}">${d.getDate()}</button>`);
  }
  promiseCalendarGrid.innerHTML = cells.join('');

  promiseSelectedDateEl.textContent = formatPromiseDateLabel(selectedDate);
  if (promiseNoteInput) promiseNoteInput.placeholder = 'Новая заметка на ' + formatPromiseDateLabel(selectedDate);

  const dayNotes = (state.notes || [])
    .filter((n) => promiseDateForNote(n) === selectedDate)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));

  if (!dayNotes.length) {
    promiseNotesList.innerHTML = '<div class="promise-notes__empty">На эту дату заметок пока нет</div>';
    return;
  }

  promiseNotesList.innerHTML = dayNotes.map((n) => {
    const edited = n.updatedAt && n.updatedAt !== n.createdAt;
    const time = edited ? ('изм. ' + fmtNoteTime(n.updatedAt)) : fmtNoteTime(n.createdAt);
    const noteDate = promiseDateForNote(n);
    const client = n.sessionId
      ? `<a href="#" class="promise-note-card__client" data-promise-chat="${esc(n.sessionId)}">💬 ${esc(n.clientName || 'Открыть чат')}</a>`
      : `<span class="promise-note-card__client">💬 Без клиента</span>`;
    return `<article class="promise-note-card" data-promise-note-id="${esc(n.id)}">
      <p data-promise-note-text>${esc(n.text)}</p>
      <textarea class="promise-note-card__edit" data-promise-note-edit rows="3" style="display:none">${esc(n.text)}</textarea>
      <input class="promise-note-card__date" data-promise-note-date type="date" value="${esc(noteDate)}" style="display:none" />
      ${client}
      <div class="promise-note-card__foot">
        <time>🕐 ${esc(time)}</time>
        <div>
          <button type="button" data-promise-action="edit">✎ Изменить</button>
          <button type="button" data-promise-action="save" style="display:none">✓ Сохранить</button>
          <button type="button" data-promise-action="cancel" style="display:none">Отмена</button>
          <button class="is-danger" type="button" data-promise-action="delete">🗑 Удалить</button>
        </div>
      </div>
    </article>`;
  }).join('');
}

function setPromiseEditMode(card, enabled) {
  if (!card) return;
  const text = card.querySelector('[data-promise-note-text]');
  const edit = card.querySelector('[data-promise-note-edit]');
  const date = card.querySelector('[data-promise-note-date]');
  const editBtn = card.querySelector('[data-promise-action="edit"]');
  const saveBtn = card.querySelector('[data-promise-action="save"]');
  const cancelBtn = card.querySelector('[data-promise-action="cancel"]');
  if (text) text.style.display = enabled ? 'none' : '';
  if (edit) edit.style.display = enabled ? 'block' : 'none';
  if (date) date.style.display = enabled ? 'block' : 'none';
  if (editBtn) editBtn.style.display = enabled ? 'none' : '';
  if (saveBtn) saveBtn.style.display = enabled ? '' : 'none';
  if (cancelBtn) cancelBtn.style.display = enabled ? '' : 'none';
  if (enabled && edit) edit.focus();
}

function openPromiseCalendar() {
  if (!promiseCalendarModal) return;
  ensurePromiseCalendarDate();
  promiseCalendarModal.classList.add('is-open');
  promiseCalendarModal.setAttribute('aria-hidden', 'false');
  loadNotes();
}
function closePromiseCalendar() {
  if (!promiseCalendarModal) return;
  promiseCalendarModal.classList.remove('is-open');
  promiseCalendarModal.setAttribute('aria-hidden', 'true');
}

if (promiseCalendarBtn) promiseCalendarBtn.addEventListener('click', openPromiseCalendar);
if (promiseCalendarClose) promiseCalendarClose.addEventListener('click', closePromiseCalendar);
if (promiseCalendarPrev) {
  promiseCalendarPrev.addEventListener('click', function () {
    ensurePromiseCalendarDate();
    promiseCalendarMonthDate = new Date(promiseCalendarMonthDate.getFullYear(), promiseCalendarMonthDate.getMonth() - 1, 1);
    renderPromiseCalendar();
  });
}
if (promiseCalendarNext) {
  promiseCalendarNext.addEventListener('click', function () {
    ensurePromiseCalendarDate();
    promiseCalendarMonthDate = new Date(promiseCalendarMonthDate.getFullYear(), promiseCalendarMonthDate.getMonth() + 1, 1);
    renderPromiseCalendar();
  });
}
if (promiseCalendarGrid) {
  promiseCalendarGrid.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-promise-date]');
    if (!btn) return;
    const selectedDate = setPromiseSelectedDate(btn.dataset.promiseDate);
    const d = parseDateKey(selectedDate);
    if (d) promiseCalendarMonthDate = new Date(d.getFullYear(), d.getMonth(), 1);
    renderPromiseCalendar();
  });
}
if (promiseNoteAdd) {
  promiseNoteAdd.addEventListener('click', function () {
    addNote(promiseNoteInput?.value || '', getSelectedPromiseDate());
    if (promiseNoteInput) promiseNoteInput.value = '';
  });
}
if (promiseNoteInput) {
  promiseNoteInput.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addNote(promiseNoteInput.value, getSelectedPromiseDate());
    promiseNoteInput.value = '';
  });
}
if (promiseNotesList) {
  promiseNotesList.addEventListener('click', function (e) {
    const chatLink = e.target.closest('[data-promise-chat]');
    if (chatLink) {
      e.preventDefault();
      closePromiseCalendar();
      selectClient(chatLink.dataset.promiseChat);
      return;
    }

    const card = e.target.closest('[data-promise-note-id]');
    if (!card) return;
    const action = e.target.closest('[data-promise-action]')?.dataset.promiseAction;
    const id = card.dataset.promiseNoteId;
    if (action === 'edit') {
      setPromiseEditMode(card, true);
    } else if (action === 'cancel') {
      renderPromiseCalendar();
    } else if (action === 'save') {
      const text = card.querySelector('[data-promise-note-edit]')?.value || '';
      const date = card.querySelector('[data-promise-note-date]')?.value || promiseSelectedDate;
      updateNote(id, text, date);
    } else if (action === 'delete') {
      deleteNote(id);
    }
  });
}
if (promiseCalendarModal) {
  promiseCalendarModal.addEventListener('click', function (e) {
    if (e.target === promiseCalendarModal) closePromiseCalendar();
  });
}
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && promiseCalendarModal?.classList.contains('is-open')) closePromiseCalendar();
});

// Pagination
els.pagination.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-page],[data-page-shift]');
  if (!btn || btn.disabled) return;
  if (btn.dataset.pageShift) {
    const vis = getVisibleClients();
    const total = Math.max(1, Math.ceil(vis.length / CHATS_PER_PAGE));
    state.page = Math.min(total, Math.max(1, state.page + Number(btn.dataset.pageShift)));
  } else {
    state.page = Number(btn.dataset.page);
  }
  renderConversations();
});

// ─── Pending attachment ───────────────────────────────────────────────────────
let pendingAttachToken = null;
const pendingAttachEl    = document.getElementById('pendingAttach');
const pendingAttachLabel = document.getElementById('pendingAttachLabel');
const pendingAttachRemove = document.getElementById('pendingAttachRemove');

const ATTACH_LABELS = {
  '[[CONTRATO]]':      '📄 Договор',
  '[[NOTIF_PDF]]':     '📄 Письмо банка',
  '[[INSURANCE_PAY]]': '💳 Оплата FD',
  '[[RETURN_PAY]]':    '💳 Оплата RD',
  '[[LOAN_TRANSFER_PAY]]': '💳 Оплата RD2',
  '[[COMMISSION_PAY]]':'💳 Оплата кредитки',
  '[[CREDITC]]':       '📄 Оплата RD3',
  '[[SEGURO]]':        '📄 Сертификат страховки',
};

function setPendingAttach(token) {
  pendingAttachToken = token;
  if (pendingAttachEl && pendingAttachLabel) {
    pendingAttachLabel.textContent = ATTACH_LABELS[token] || token;
    pendingAttachEl.style.display = 'flex';
  }
}
function clearPendingAttach() {
  pendingAttachToken = null;
  if (pendingAttachEl) pendingAttachEl.style.display = 'none';
}

if (pendingAttachRemove) pendingAttachRemove.addEventListener('click', clearPendingAttach);

function fitMessageInput() {
  if (!els.messageInput) return;
  els.messageInput.style.height = 'auto';
  els.messageInput.style.height = `${Math.min(116, els.messageInput.scrollHeight)}px`;
}

// Send message
els.messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.messageInput.value.trim();
  const token = pendingAttachToken;
  if (!text && !token) return;
  // Адресата фиксируем до отправки: пока уходит первое сообщение, оператор
  // может переключить чат — оба должны уйти тому, кому набирали.
  const sid = state.activeSessionId;
  if (!sid) return;
  els.messageInput.value = '';
  fitMessageInput();
  clearPendingAttach();
  if (text) await sendOperatorMsg(text, sid);
  if (token) await sendOperatorMsg(token, sid);
});

els.messageInput.addEventListener('input', fitMessageInput);

els.messageInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.shiftKey) return;
  e.preventDefault();
  els.messageForm.requestSubmit();
});

// ─── Attach menu ──────────────────────────────────────────────────────────────
const attachMenu = document.getElementById('attachMenu');

const ATTACH_MESSAGES = {
  'contract':       '[[CONTRATO]]',
  'insurance-req':  '[[NOTIF_PDF]]',
  'insurance-pay':  '[[INSURANCE_PAY]]',
  'insurance-done': '[[SEGURO]]',
  'return-pay':     '[[RETURN_PAY]]',
  'loan-transfer-pay': '[[LOAN_TRANSFER_PAY]]',
  'commission-pay': '[[COMMISSION_PAY]]',
  'credit-card-contract': '[[CREDITC]]',
};

function openAttachMenu() {
  if (!attachMenu) return;
  attachMenu.classList.add('is-open');
  els.imageBtn.classList.add('is-open');
  els.imageBtn.setAttribute('aria-expanded', 'true');
}
function closeAttachMenu() {
  if (!attachMenu) return;
  attachMenu.classList.remove('is-open');
  els.imageBtn.classList.remove('is-open');
  els.imageBtn.setAttribute('aria-expanded', 'false');
}

// forSessionId фиксирует адресата на момент вызова: между двумя отправками
// подряд оператор может переключить чат, и второе сообщение ушло бы не тому.
async function sendOperatorMsg(text, forSessionId) {
  const sid = forSessionId || state.activeSessionId;
  if (!sid) return;
  const tmpMsg = { role: 'operator', content: text, createdAt: new Date().toISOString() };
  // Дорисовываем в ленту только если этот чат сейчас открыт.
  if (sid === state.activeSessionId) {
    state.activeMessages = [...state.activeMessages, tmpMsg];
    renderMessages(state.activeMessages, state.activeClient?.callerNote);
    // Оператор мог отправить текст этапа руками — сразу засчитываем шаг.
    renderStages(state.activeClient);
  }
  try {
    await api('/api/chat-op/send', { method: 'POST', body: { sessionId: sid, message: text } });
    const c = state.clients.find((x) => x.flowSessionId === sid);
    if (c) { c.lastMsg = tmpMsg; c.unreadCount = 0; } // ответил оператор — непрочитанных нет
    renderConversations();
    // Подтягиваем реальное сообщение (с id/canEdit), чтобы карандаш появился сразу,
    // не дожидаясь прочтения клиентом.
    if (sid === state.activeSessionId) {
      const fresh = await api('/api/chat-op/messages/' + encodeURIComponent(sid));
      if (fresh && fresh.messages && sid === state.activeSessionId) {
        state.activeMessages = fresh.messages;
        if (fresh.chatLastReadAt !== undefined) state.chatLastReadAt = fresh.chatLastReadAt;
        renderMessages(state.activeMessages, state.activeClient?.callerNote);
      }
    }
  } catch {}
}

// Start button for new chats
if (els.startChatBtn) {
  els.startChatBtn.addEventListener('click', async () => {
    if (!state.activeSessionId) return;
    await sendOperatorMsg('CALLER_ACTION_BUTTONS');
    const c = state.clients.find((x) => x.flowSessionId === state.activeSessionId);
    if (c) c.status = 'ЧАТ: АКТИВЕН';
    if (state.activeClient) state.activeClient.status = 'ЧАТ: АКТИВЕН';
    renderStartBar();
    renderConversations();
  });
}

// Toggle menu on paperclip click
els.imageBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!state.activeSessionId) return;
  attachMenu?.classList.contains('is-open') ? closeAttachMenu() : openAttachMenu();
});

// Menu item clicks
if (attachMenu) {
  attachMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-attach]');
    if (!btn) return;
    const action = btn.dataset.attach;
    // Оплата RD3 заблокирована, пока конверт не подтверждён.
    if (action === 'commission-pay' && !isEnvelopeApproved()) {
      alert('Сначала загрузите конверт с ПК (📮 Конверт) и подтвердите его.');
      return;
    }
    closeAttachMenu();
    if (action === 'photo') {
      els.imageInput.click();
    } else if (ATTACH_MESSAGES[action]) {
      setPendingAttach(ATTACH_MESSAGES[action]);
      els.messageInput.focus();
    }
  });
}

// Close menu on outside click
document.addEventListener('click', (e) => {
  if (attachMenu?.classList.contains('is-open') && !e.target.closest('.attach-wrap')) {
    closeAttachMenu();
  }
});

// Image upload via file input
els.imageInput.addEventListener('change', async () => {
  const file = els.imageInput.files[0];
  // Загрузка небыстрая — адресата фиксируем до неё.
  const sid = state.activeSessionId;
  if (!file || !sid) return;
  els.imageInput.value = '';
  els.imageBtn.disabled = true;
  try {
    const url = await uploadImage(file);
    await sendOperatorMsg(url, sid);
  } catch {
    // upload failed silently
  } finally {
    els.imageBtn.disabled = false;
  }
});

// Заметка по чату
if (els.chatNoteSave) {
  els.chatNoteSave.addEventListener('click', () => saveChatNote(els.chatNoteInput.value.trim()));
}
if (els.chatNoteDelete) {
  els.chatNoteDelete.addEventListener('click', () => {
    els.chatNoteInput.value = '';
    saveChatNote('');
  });
}
if (els.chatNoteInput) {
  // Enter — сохранить, Shift+Enter — перенос строки
  els.chatNoteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveChatNote(els.chatNoteInput.value.trim());
    }
  });
}

// ─── Баланс / Debet-карта ─────────────────────────────────────────────────────
let balanceTarget = 'real';                       // real | demo (карта)
let cardState = { exists: false, balance: 0, last4: '' };

// Конкретная операция по текущему таргету/режиму/состоянию карты.
function resolveBalanceOp() {
  if (balanceTarget === 'demo') {
    if (!cardState.exists) {
      return { endpoint: '/api/chat-op/add-account', success: 'Debet-счёт добавлен', error: 'Ошибка добавления счёта', descField: 'note', btnLabel: 'Добавить debet-счёт', needsAmount: false, affectsMain: false };
    }
    if (balanceMode === 'refund') {
      return { endpoint: '/api/chat-op/card-refund', success: 'Карта пополнена', error: 'Ошибка пополнения карты', descField: 'note', btnLabel: 'Пополнить карту', needsAmount: true, affectsMain: false };
    }
    return { endpoint: '/api/chat-op/card-charge', success: 'Списано с карты', error: 'Ошибка списания с карты', descField: 'note', btnLabel: 'Списать с карты', needsAmount: true, affectsMain: false };
  }
  if (balanceMode === 'refund') {
    return { endpoint: '/api/chat-op/refund', success: 'Пополнено', error: 'Ошибка пополнения', descField: 'description', btnLabel: 'Изменить баланс', needsAmount: true, affectsMain: true };
  }
  return { endpoint: '/api/chat-op/charge', success: 'Списано', error: 'Ошибка списания', descField: 'description', btnLabel: 'Изменить баланс', needsAmount: true, affectsMain: true };
}

async function loadCardState() {
  if (!state.activeSessionId) { cardState = { exists: false, balance: 0, last4: '' }; return; }
  try {
    const d = await api('/api/chat-op/card?sessionId=' + encodeURIComponent(state.activeSessionId));
    cardState = { exists: !!(d && d.exists), balance: Number(d && d.balance) || 0, last4: (d && d.last4) || '' };
  } catch { cardState = { exists: false, balance: 0, last4: '' }; }
}

function updateBalanceTargetUi() {
  if (!els.balanceTargetBtns) return;
  els.balanceTargetBtns.forEach((btn) => {
    const active = btn.dataset.balanceTarget === balanceTarget;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

if (els.balanceTargetBtns) {
  els.balanceTargetBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.balanceTarget;
      if (next !== 'real' && next !== 'demo') return;
      balanceTarget = next;
      balanceMode = 'charge';
      if (els.chargeResult) els.chargeResult.textContent = '';
      updateBalanceTargetUi();
      if (next === 'demo') await loadCardState();
      updateBalanceModeUi();
      renderBalance(state.activeClient);
      updateChargeBtn();
    });
  });
}

function updateBalanceModeUi() {
  if (els.balanceModeBtns) {
    els.balanceModeBtns.forEach((btn) => {
      const active = btn.dataset.balanceMode === balanceMode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  const demo = balanceTarget === 'demo';
  const addingAccount = demo && !cardState.exists;
  const showModes = !addingAccount;               // при создании карты тумблер прячем
  if (els.balanceModeGroup) els.balanceModeGroup.style.display = showModes ? 'grid' : 'none';
  if (els.balanceOperationFields) els.balanceOperationFields.style.display = addingAccount ? 'none' : 'flex';
  const op = resolveBalanceOp();
  if (els.chargeDesc) els.chargeDesc.placeholder = demo ? 'Se ha abonado una compensación por los gastos' : 'Описание (необязательно)';
  if (els.chargeBtn) els.chargeBtn.textContent = op.btnLabel;
  if (els.addAccountNotice) els.addAccountNotice.style.display = addingAccount ? 'block' : 'none';
  if (addingAccount) {
    if (els.chargeAmount) els.chargeAmount.value = '';
    if (els.chargeDesc) els.chargeDesc.value = '';
  }
}

if (els.balanceModeBtns) {
  els.balanceModeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextMode = btn.dataset.balanceMode;
      if (nextMode !== 'charge' && nextMode !== 'refund') return;
      balanceMode = nextMode;
      if (els.chargeResult) els.chargeResult.textContent = '';
      updateBalanceModeUi();
      updateChargeBtn();
    });
  });
}

function updateChargeBtn() {
  if (!els.chargeBtn) return;
  const op = resolveBalanceOp();
  const hasSession = !!state.activeSessionId;
  const hasAmount = parseFloat(els.chargeAmount?.value) > 0;
  els.chargeBtn.disabled = !hasSession || (op.needsAmount && !hasAmount);
}

if (els.chargeAmount) els.chargeAmount.addEventListener('input', updateChargeBtn);

if (els.chargeBtn) {
  els.chargeBtn.addEventListener('click', async () => {
    if (!state.activeSessionId) return;
    const op = resolveBalanceOp();
    const amount = parseFloat(els.chargeAmount.value);
    if (op.needsAmount && (!isFinite(amount) || amount <= 0)) return;
    const desc = els.chargeDesc.value.trim();
    els.chargeBtn.disabled = true;
    els.chargeResult.textContent = '';
    try {
      const body = { sessionId: state.activeSessionId };
      if (op.needsAmount) body.amount = amount;
      body[op.descField] = desc;
      const data = await api(op.endpoint, { method: 'POST', body });
      if (data.ok) {
        if (op.affectsMain) {
          const newBal = data.balance;
          if (state.activeClient) state.activeClient.balance = newBal;
          const c = state.clients.find((x) => x.flowSessionId === state.activeSessionId);
          if (c) c.balance = newBal;
          // Ручное списание — тот же шаг сценария, что и кнопка «Списать».
          if (op.endpoint === '/api/chat-op/charge') {
            applyLocalCharge(state.activeSessionId, amount, newBal);
            renderStages(state.activeClient);
          }
        } else {
          await loadCardState();
          updateBalanceModeUi();
          // Ручное пополнение карты — тот же шаг, что и кнопка «Компенсация».
          if (op.endpoint === '/api/chat-op/card-refund') {
            applyLocalCardCredit(state.activeSessionId, amount);
            renderStages(state.activeClient);
          }
        }
        renderBalance(state.activeClient);
        els.chargeAmount.value = '';
        els.chargeDesc.value = '';
        const amtLabel = op.needsAmount ? ' ' + fmtEur(amount) : '';
        showToast(`✓ ${op.success}${amtLabel}`, 'success');
        setTimeout(closeDebitoModal, 1200);
      } else {
        showToast(`✗ ${op.error}`, 'error');
        els.chargeResult.style.color = '#f20b5d';
        els.chargeResult.textContent = `✗ ${op.error}`;
      }
    } catch {
      showToast('✗ Ошибка сети', 'error');
      els.chargeResult.style.color = '#f20b5d';
      els.chargeResult.textContent = '✗ Ошибка сети';
    }
    updateChargeBtn();
    setTimeout(() => { if (els.chargeResult) els.chargeResult.textContent = ''; }, 3000);
  });
}
// ─── Toast notifications ──────────────────────────────────────────────────────
function showToast(msg, type) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const t = document.createElement('div');
  const bg = type === 'success' ? '#16a34a' : '#dc2626';
  t.style.cssText = `background:${bg};color:#fff;padding:12px 18px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.4);pointer-events:auto;opacity:0;transition:opacity .2s;max-width:280px;`;
  t.textContent = msg;
  container.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; });
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
  }, 3000);
}

// ─── Демо-предупреждение о панели (один раз за сессию вкладки) ──────────────
(function showDemoNoticeOnce() {
  try {
    if (sessionStorage.getItem('chatOpDemoNoticeSeen') === '1') return;
  } catch (e) {}
  if (!els.demoNoticeModal) return;
  els.demoNoticeModal.style.display = 'flex';
  if (els.demoNoticeOk) {
    els.demoNoticeOk.addEventListener('click', () => {
      els.demoNoticeModal.style.display = 'none';
      try { sessionStorage.setItem('chatOpDemoNoticeSeen', '1'); } catch (e) {}
    });
  }
})();

// ─── Débito modal ─────────────────────────────────────────────────────────────
function openDebitoModal() {
  if (!els.debitoModal) return;
  els.debitoModal.style.display = 'flex';
  balanceTarget = 'real';
  balanceMode = 'charge';
  cardState = { exists: false, balance: 0, last4: '' };
  renderBalance(state.activeClient);
  updateBalanceTargetUi();
  updateBalanceModeUi();
  updateChargeBtn();
}
function closeDebitoModal() {
  if (!els.debitoModal) return;
  els.debitoModal.style.display = 'none';
}
if (els.debitoBtn) {
  els.debitoBtn.addEventListener('click', openDebitoModal);
}

// ─── «Данные» — сводная карточка клиента ─────────────────────────────────────
// Открывает client-data.html в новой вкладке. Данные передаём через
// sessionStorage: страница читает их синхронно при загрузке.
const clientDataBtn = $('#clientDataBtn');
if (clientDataBtn) {
  clientDataBtn.addEventListener('click', () => {
    const c = state.activeClient;
    if (!c) return;
    try {
      localStorage.setItem('clientDataView', JSON.stringify({
        nombre: c.nombre || '',
        email: c.email || '',
        ip: c.ip || '',
        status: c.status || '',
        balance: c.balance,
        submissionData: c.submissionData || {}
      }));
    } catch {}
    window.open('client-data.html', '_blank', 'noopener');
  });
}
if (els.debitoClose) {
  els.debitoClose.addEventListener('click', closeDebitoModal);
}
if (els.debitoModal) {
  els.debitoModal.addEventListener('click', (e) => {
    if (e.target === els.debitoModal) closeDebitoModal();
  });
}

// ─── Manual push ──────────────────────────────────────────────────────────────
const pushBtn = $('[data-send-push]');
if (pushBtn) {
  pushBtn.addEventListener('click', async () => {
    if (!state.activeSessionId) return;
    pushBtn.disabled = true;
    const orig = pushBtn.textContent;
    pushBtn.textContent = '⌛';
    try {
      const data = await api('/api/chat-op/send-push', { method: 'POST', body: { sessionId: state.activeSessionId } });
      pushBtn.textContent = data.ok ? '✓ Отправлен' : '✗ Нет токена';
    } catch {
      pushBtn.textContent = '✗ Ошибка';
    }
    setTimeout(() => { pushBtn.textContent = orig; pushBtn.disabled = false; }, 2000);
  });
}

// ─── «Заблокировать» (ban) ────────────────────────────────────────────────────
// Блокирует клиента: данные сохраняются, но все его страницы редиректят
// на страницу ожидания. Повторное нажатие — вернуть из блокировки.
const banBtn = $('[data-ban]');

function setBanButtonState(banned) {
  if (!banBtn) return;
  banBtn.dataset.banned = banned ? '1' : '0';
  banBtn.textContent = banned ? '↩️ Вернуть' : '🔒 Заблокировать';
  banBtn.title = banned
    ? 'Вернуть клиента из блокировки (снять редирект)'
    : 'Заблокировать клиента (редирект на страницу ожидания)';
  banBtn.classList.toggle('is-banned', !!banned);
}

async function refreshBanButton(sessionId) {
  if (!banBtn || !sessionId) return;
  setBanButtonState(false);
  try {
    const res = await fetch(API + '/api/client/state?flowSessionId=' + encodeURIComponent(sessionId));
    const d = await res.json();
    setBanButtonState(!!(d && d.banned));
  } catch {}
}

if (banBtn) {
  banBtn.addEventListener('click', async () => {
    if (!state.activeSessionId) return;
    const currentlyBanned = banBtn.dataset.banned === '1';
    const nextBanned = !currentlyBanned;
    const msg = nextBanned
      ? 'Заблокировать клиента? Все его страницы будут перекидывать на страницу ожидания (данные и переписка сохранятся).'
      : 'Вернуть клиента из блокировки? Редирект будет снят.';
    if (!window.confirm(msg)) return;
    banBtn.disabled = true;
    const orig = banBtn.textContent;
    banBtn.textContent = '⌛';
    try {
      const data = await api('/api/chat-op/ban', { method: 'POST', body: { sessionId: state.activeSessionId, banned: nextBanned } });
      if (data && data.ok) {
        setBanButtonState(nextBanned);
        if (state.activeClient) state.activeClient.banned = nextBanned;
      } else {
        banBtn.textContent = data && data.error === 'migration_required' ? '✗ Нужна миграция' : '✗ Ошибка';
        setTimeout(() => setBanButtonState(currentlyBanned), 2500);
      }
    } catch {
      banBtn.textContent = '✗ Ошибка';
      setTimeout(() => setBanButtonState(currentlyBanned), 2500);
    }
    banBtn.disabled = false;
  });
}

// ─── SMS history ──────────────────────────────────────────────────────────────
function renderSmsHistory(entries) {
  const box = document.getElementById('smsHistoryList');
  if (!box) return;
  if (!entries || !entries.length) {
    box.innerHTML = '<div class="sms-history-empty">Нет отправленных SMS</div>';
    return;
  }
  box.innerHTML = entries.map(e => {
    const d = new Date(e.sentAt);
    const dateStr = d.toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'2-digit' })
      + ' ' + d.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });
    const statusClass = e.ok ? 'sms-history__status--ok' : 'sms-history__status--fail';
    const statusText  = e.ok ? '✓' : '✗';
    return `<article class="sms-history__item">
      <div class="sms-history__top">
        <span class="sms-history__phone">${esc(e.phone)}</span>
        <span class="sms-history__meta">
          <time class="sms-history__date">${dateStr}</time>
          <span class="sms-history__status ${statusClass}">${statusText}</span>
        </span>
      </div>
      <div class="sms-history__text">${esc(e.text)}</div>
    </article>`;
  }).join('');
}

async function loadSmsHistory(sessionId) {
  if (!sessionId) return;
  try {
    const data = await api('/api/chat-op/sms-history/' + encodeURIComponent(sessionId));
    const entries = data.entries || [];
    if (sessionId !== state.activeSessionId) return; // клиента успели переключить
    state.smsEntries = entries;
    renderSmsHistory(entries);
  } catch {
    if (sessionId === state.activeSessionId) state.smsEntries = [];
    renderSmsHistory([]);
  }
  // Ручную отправку СМС с текстом из админки чек-лист засчитывает как шаг.
  if (sessionId === state.activeSessionId) renderStages(state.activeClient);
}

// ─── SMS modal ────────────────────────────────────────────────────────────────
const smsModal    = document.getElementById('smsModal');
const smsPhone    = document.getElementById('smsPhone');
const smsText     = document.getElementById('smsText');
const smsCharCount = document.getElementById('smsCharCount');
const smsSendBtn  = document.getElementById('smsSendBtn');
const smsResult   = document.getElementById('smsResultMsg');
const smsClose    = document.getElementById('smsModalClose');
const smsBtn      = document.getElementById('sendSmsBtn');

function openSmsModal() {
  if (!smsModal) return;
  const sub = (state.activeClient?.submissionData && typeof state.activeClient.submissionData === 'object')
    ? state.activeClient.submissionData : {};
  smsPhone.value = sub.phone || '';
  smsText.value  = '';
  smsCharCount.textContent = '0 / 640';
  smsResult.textContent = '';
  smsSendBtn.disabled = false;
  smsModal.style.display = 'flex';
  (smsPhone.value ? smsText : smsPhone).focus();
}

function closeSmsModal() {
  if (smsModal) smsModal.style.display = 'none';
}

if (smsBtn) smsBtn.addEventListener('click', () => { if (state.activeSessionId) openSmsModal(); });
if (smsClose) smsClose.addEventListener('click', closeSmsModal);
if (smsModal) smsModal.addEventListener('click', (e) => { if (e.target === smsModal) closeSmsModal(); });

if (smsText) {
  smsText.addEventListener('input', () => {
    smsCharCount.textContent = smsText.value.length + ' / 640';
  });
}

if (smsSendBtn) {
  smsSendBtn.addEventListener('click', async () => {
    const phone = smsPhone.value.trim();
    const text  = smsText.value.trim();
    if (!phone) { smsPhone.focus(); return; }
    if (!text)  { smsText.focus();  return; }
    smsSendBtn.disabled = true;
    smsSendBtn.textContent = '⌛ Отправка...';
    smsResult.textContent = '';
    try {
      const data = await api('/api/chat-op/send-sms', { method: 'POST', body: { phone, text, sessionId: state.activeSessionId } });
      if (data.ok) {
        smsResult.style.color = '#2DB97B';
        smsResult.textContent = '✓ SMS отправлен';
        setTimeout(() => { closeSmsModal(); loadSmsHistory(state.activeSessionId); }, 1200);
      } else {
        smsResult.style.color = '#f20b5d';
        smsResult.textContent = '✗ ' + (data.error || 'Ошибка');
        smsSendBtn.disabled = false;
        smsSendBtn.textContent = 'Отправить';
      }
    } catch {
      smsResult.style.color = '#f20b5d';
      smsResult.textContent = '✗ Ошибка сети';
      smsSendBtn.disabled = false;
      smsSendBtn.textContent = 'Отправить';
    }
  });
}

// ─── Envelope (загрузка готового конверта с ПК) ────────────────────────────────
const envModal   = document.getElementById('envModal');
const envResult  = document.getElementById('envResultMsg');
const envPrevLink = document.getElementById('envPreviewLink');
const envPrev    = document.getElementById('envPreview');
const envBtn     = document.getElementById('envelopeBtn');
const envClose   = document.getElementById('envModalClose');
const envConfirmBtn  = document.getElementById('envConfirmBtn');
const envConfirmHint = document.getElementById('envConfirmHint');

let envSavedUrl = null;

// ─── Гейт кнопки «Оплата RD3» ─────────────────────────────────────────────────
// Отправить оплату RD3 можно только после того, как оператор
// загрузил готовый конверт и подтвердил его.
function isEnvelopeApproved() {
  const sub = state.activeClient?.submissionData;
  return !!(sub && typeof sub === 'object' && sub.envelopeApproved);
}
function updateCommissionGate() {
  const item = document.querySelector('[data-attach="commission-pay"]');
  if (!item) return;
  const ok = isEnvelopeApproved();
  item.disabled = !ok;
  item.style.opacity = ok ? '' : '0.45';
  item.style.cursor = ok ? '' : 'not-allowed';
  item.title = ok ? '' : 'Сначала загрузите и подтвердите конверт (кнопка 📮 Конверт)';
}

function setEnvClientPatch(patch) {
  if (!state.activeClient) return;
  const sub = (state.activeClient.submissionData && typeof state.activeClient.submissionData === 'object')
    ? state.activeClient.submissionData : {};
  state.activeClient.submissionData = { ...sub, ...patch };
}

function openEnvModal() {
  if (!envModal) return;
  const sub = (state.activeClient?.submissionData && typeof state.activeClient.submissionData === 'object')
    ? state.activeClient.submissionData : {};
  envResult.textContent = '';
  envPrevLink.style.display = 'none';
  envSavedUrl = null;
  if (envConfirmBtn) envConfirmBtn.style.display = 'none';
  if (envConfirmHint) envConfirmHint.style.display = 'none';
  // Если для клиента уже есть картинка — покажем её и статус.
  if (sub.envelopeUrl) {
    envSavedUrl = sub.envelopeUrl;
    envPrev.src = API + sub.envelopeUrl;
    envPrevLink.href = API + sub.envelopeUrl;
    envPrevLink.style.display = 'block';
    if (sub.envelopeApproved) {
      envResult.style.color = '#2DB97B';
      envResult.textContent = '✓ Подтверждено';
    } else if (envConfirmBtn) {
      envConfirmBtn.style.display = 'block';
      if (envConfirmHint) envConfirmHint.style.display = 'block';
    }
  }
  envModal.style.display = 'flex';
  envUploadBtn?.focus();
}

function closeEnvModal() { if (envModal) envModal.style.display = 'none'; }

async function confirmEnvelope() {
  if (!state.activeSessionId || !envSavedUrl) return;
  envConfirmBtn.disabled = true;
  const orig = envConfirmBtn.textContent;
  envConfirmBtn.textContent = '⌛...';
  try {
    const data = await api('/api/chat-op/envelope/confirm', { method: 'POST', body: { sessionId: state.activeSessionId } });
    if (!data || !data.ok) throw new Error(data?.error || 'ошибка подтверждения');
    setEnvClientPatch({ envelopeApproved: true });
    updateCommissionGate();
    envResult.style.color = '#2DB97B';
    envResult.textContent = '✓ Подтверждено — возвратный платёж разблокирован';
    envConfirmBtn.style.display = 'none';
    if (envConfirmHint) envConfirmHint.style.display = 'none';
    setTimeout(closeEnvModal, 1200);
  } catch (err) {
    envResult.style.color = '#f20b5d';
    envResult.textContent = '✗ ' + (err?.message || 'Ошибка');
  } finally {
    envConfirmBtn.disabled = false;
    envConfirmBtn.textContent = orig;
  }
}

// Загрузка готовой картинки конверта с ПК.
const envUploadInput = document.getElementById('envUploadInput');
const envUploadBtn   = document.getElementById('envUploadBtn');

async function uploadEnvelopeFromPc(file) {
  if (!file || !state.activeSessionId) return;
  if (envConfirmBtn) envConfirmBtn.style.display = 'none';
  if (envConfirmHint) envConfirmHint.style.display = 'none';
  envUploadBtn.disabled = true;
  envResult.style.color = '#7a90aa';
  envResult.textContent = '⌛ Загрузка...';
  try {
    const url = await uploadImage(file);
    const data = await api('/api/chat-op/envelope/set-image', { method: 'POST', body: { sessionId: state.activeSessionId, url } });
    if (!data || !data.ok) throw new Error(data?.error || 'ошибка сохранения');
    envSavedUrl = url;
    envPrev.src = API + url + '?t=' + Date.now();
    envPrevLink.href = API + url;
    envPrevLink.style.display = 'block';
    setEnvClientPatch({ envelopeUrl: url, envelopeApproved: false });
    updateCommissionGate();
    envResult.style.color = '#7a90aa';
    envResult.textContent = 'Показано клиенту. Проверьте и подтвердите.';
    if (envConfirmBtn) envConfirmBtn.style.display = 'block';
    if (envConfirmHint) envConfirmHint.style.display = 'block';
  } catch (err) {
    envResult.style.color = '#f20b5d';
    envResult.textContent = '✗ ' + (err?.message || 'Ошибка загрузки');
  } finally {
    envUploadBtn.disabled = false;
  }
}

if (envBtn) envBtn.addEventListener('click', () => { if (state.activeSessionId) openEnvModal(); });
if (envClose) envClose.addEventListener('click', closeEnvModal);
if (envModal) envModal.addEventListener('click', (e) => { if (e.target === envModal) closeEnvModal(); });
if (envConfirmBtn) envConfirmBtn.addEventListener('click', confirmEnvelope);
if (envUploadBtn) envUploadBtn.addEventListener('click', () => { if (state.activeSessionId) envUploadInput.click(); });
if (envUploadInput) envUploadInput.addEventListener('change', () => {
  const f = envUploadInput.files[0];
  envUploadInput.value = '';
  if (f) uploadEnvelopeFromPc(f);
});

// ─── Банк-получатель для RD2 ──────────────────────────────────────────────────
// Оператор выбирает, какому банку «переходит» кредит. Клиент видит этот банк
// на странице переноса как нового кредитора; EBN Banco (текущий) не меняется.
const bankModal   = document.getElementById('bankModal');
const bankBtn     = document.getElementById('bankBtn');
const bankClose   = document.getElementById('bankModalClose');
const bankListEl  = document.getElementById('bankList');
const bankClearBtn = document.getElementById('bankClearBtn');
const bankResult  = document.getElementById('bankResultMsg');

let bankOptions = [];

function currentRd2BankKey() {
  const sub = (state.activeClient?.submissionData && typeof state.activeClient.submissionData === 'object')
    ? state.activeClient.submissionData : {};
  return sub.rd2Bank?.key || '';
}

function renderBankList() {
  if (!bankListEl) return;
  const active = currentRd2BankKey();
  bankListEl.innerHTML = bankOptions.map((b) => {
    const on = b.key === active;
    return `<button type="button" data-bank-key="${esc(b.key)}" style="display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border-radius:10px;cursor:pointer;text-align:left;
      background:${on ? '#12341f' : '#0f1c2e'};border:1px solid ${on ? '#1ea86a' : '#1e2e45'};color:${on ? '#7ee2a8' : '#cfe0f7'};font-size:13px;font-weight:600">
      <img src="${esc(API + b.icon)}" alt="" style="width:26px;height:26px;border-radius:6px;background:#fff;flex:none;object-fit:contain" />
      <span style="flex:1">${esc(b.name)}</span>
      ${on ? '<span style="color:#4ade80">✓</span>' : ''}
    </button>`;
  }).join('');
  if (bankClearBtn) bankClearBtn.style.display = active ? 'block' : 'none';
}

async function openBankModal() {
  if (!bankModal) return;
  bankResult.textContent = '';
  if (!bankOptions.length) {
    try { bankOptions = (await api('/api/banks'))?.banks || []; }
    catch { bankOptions = []; }
  }
  renderBankList();
  bankModal.style.display = 'flex';
}

function closeBankModal() { if (bankModal) bankModal.style.display = 'none'; }

async function setRd2Bank(bankKey) {
  const sid = state.activeSessionId;
  if (!sid) return;
  bankResult.style.color = '#7a90aa';
  bankResult.textContent = '⌛ Сохраняю...';
  try {
    const data = await api('/api/chat-op/rd2-bank', { method: 'POST', body: { sessionId: sid, bankKey } });
    if (!data?.ok) throw new Error(data?.error || 'не сохранилось');
    const patch = { rd2Bank: data.bank || null };
    const apply = (c) => {
      if (!c) return;
      const sub = (c.submissionData && typeof c.submissionData === 'object') ? c.submissionData : {};
      c.submissionData = { ...sub, ...patch };
    };
    apply(state.activeClient);
    apply(state.clients.find((x) => x.flowSessionId === sid));
    renderBankList();
    renderStages(state.activeClient);
    bankResult.style.color = '#2DB97B';
    bankResult.textContent = data.bank ? `✓ ${data.bank.name}` : '✓ Выбор сброшен';
    if (data.bank) setTimeout(closeBankModal, 900);
  } catch (err) {
    bankResult.style.color = '#f20b5d';
    bankResult.textContent = '✗ ' + (err?.message || 'Ошибка');
  }
}

if (bankBtn) bankBtn.addEventListener('click', () => { if (state.activeSessionId) openBankModal(); });
if (bankClose) bankClose.addEventListener('click', closeBankModal);
if (bankModal) bankModal.addEventListener('click', (e) => { if (e.target === bankModal) closeBankModal(); });
if (bankListEl) bankListEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bank-key]');
  if (btn) setRd2Bank(btn.dataset.bankKey);
});
if (bankClearBtn) bankClearBtn.addEventListener('click', () => setRd2Bank(''));

// ─── Картинка из буфера обмена ────────────────────────────────────────────────
// Ctrl+V в поле сообщения сначала показывает превью с подтверждением,
// чтобы в чат не отправилась случайная картинка.
const pasteModal   = document.getElementById('pasteImgModal');
const pastePreview = document.getElementById('pasteImgPreview');
const pasteTitle   = document.getElementById('pasteImgTitle');
const pasteError   = document.getElementById('pasteImgError');
const pasteConfirm = document.getElementById('pasteImgConfirm');
const pasteCancel  = document.getElementById('pasteImgCancel');
const pasteClose   = document.getElementById('pasteImgClose');

let pasteFile = null;       // File из буфера, ждущий подтверждения
let pastePreviewUrl = null; // objectURL превью — обязательно освобождаем
let pasteHandler = null;    // что делать по «Отправить»

function closePasteModal() {
  if (!pasteModal) return;
  pasteModal.style.display = 'none';
  if (pastePreviewUrl) { URL.revokeObjectURL(pastePreviewUrl); pastePreviewUrl = null; }
  pastePreview.src = '';
  pasteFile = null;
  pasteHandler = null;
  pasteConfirm.disabled = false;
  pasteConfirm.textContent = 'Отправить';
}

function openPasteModal(file, { title, confirmLabel, onConfirm }) {
  if (!pasteModal || !file) return;
  if (pastePreviewUrl) URL.revokeObjectURL(pastePreviewUrl);
  pasteFile = file;
  pasteHandler = onConfirm;
  pastePreviewUrl = URL.createObjectURL(file);
  pastePreview.src = pastePreviewUrl;
  pasteTitle.textContent = title;
  pasteConfirm.textContent = confirmLabel;
  pasteConfirm.disabled = false;
  pasteError.textContent = '';
  pasteModal.style.display = 'flex';
}

// Достаёт картинку из события paste (Ctrl+V).
function imageFromClipboardEvent(e) {
  const items = e.clipboardData?.items;
  if (!items) return null;
  // DataTransferItemList — не везде итерируется через for..of, идём по индексу.
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

if (pasteClose)  pasteClose.addEventListener('click', closePasteModal);
if (pasteCancel) pasteCancel.addEventListener('click', closePasteModal);
if (pasteModal)  pasteModal.addEventListener('click', (e) => { if (e.target === pasteModal) closePasteModal(); });

if (pasteConfirm) pasteConfirm.addEventListener('click', async () => {
  if (!pasteFile || !pasteHandler) return;
  const file = pasteFile;
  const handler = pasteHandler;
  pasteConfirm.disabled = true;
  pasteConfirm.textContent = '⌛...';
  pasteError.textContent = '';
  try {
    await handler(file);
    closePasteModal();
  } catch (err) {
    pasteError.textContent = '✗ ' + (err?.message || 'Не удалось отправить');
    pasteConfirm.disabled = false;
    pasteConfirm.textContent = 'Отправить';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pasteModal?.style.display === 'flex') closePasteModal();
});

// Ctrl+V в поле сообщения — предложить отправить картинку клиенту.
if (els.messageInput) els.messageInput.addEventListener('paste', (e) => {
  const file = imageFromClipboardEvent(e);
  if (!file) return;                 // обычный текст — вставляем как всегда
  e.preventDefault();
  const sid = state.activeSessionId;
  if (!sid) return;
  openPasteModal(file, {
    title: '📋 Отправить картинку клиенту?',
    confirmLabel: 'Отправить',
    onConfirm: async (f) => {
      const url = await uploadImage(f);
      await sendOperatorMsg(url, sid);
    },
  });
});

// ─── Автопуш (запланированное сообщение клиенту + опц. SMS) ────────────────────
const autopushModal   = document.getElementById('autopushModal');
const autopushOpenBtn = document.getElementById('autopushBtn');
const autopushDate    = document.getElementById('autopushDate');
const autopushTime    = document.getElementById('autopushTime');
const autopushMessage = document.getElementById('autopushMessage');
const autopushSmsToggle = document.getElementById('autopushSmsToggle');
const autopushSmsText = document.getElementById('autopushSmsText');
const autopushSmsCount = document.getElementById('autopushSmsCount');
const autopushSubmit  = document.getElementById('autopushSubmit');
const autopushResult  = document.getElementById('autopushResult');
const autopushClose   = document.getElementById('autopushClose');
const autopushCancel  = document.getElementById('autopushCancel');
const autopushCalendarGrid = document.getElementById('autopushCalendarGrid');
const autopushCalendarMonth = document.getElementById('autopushCalendarMonth');
const autopushCalendarPrev = document.getElementById('autopushCalendarPrev');
const autopushCalendarNext = document.getElementById('autopushCalendarNext');
const autopushSelectedDateEl = document.getElementById('autopushSelectedDate');
const autopushTasksList = document.getElementById('autopushTasksList');

let autopushTasks = [];
let autopushCalendarMonthDate = null;
let autopushSelectedDate = null;

function pad2(n) { return String(n).padStart(2, '0'); }

function autopushDateForTask(task) {
  const d = new Date(Number(task?.sendAt || 0));
  return Number.isNaN(d.getTime()) ? dateKeyFromDate(new Date()) : dateKeyFromDate(d);
}

function autopushTimeForTask(task) {
  const d = new Date(Number(task?.sendAt || 0));
  return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function ensureAutopushCalendarDate() {
  if (!autopushSelectedDate) autopushSelectedDate = dateKeyFromDate(new Date());
  if (!autopushCalendarMonthDate) {
    const d = parseDateKey(autopushSelectedDate) || new Date();
    autopushCalendarMonthDate = new Date(d.getFullYear(), d.getMonth(), 1);
  }
}

function setAutopushSelectedDate(key) {
  const d = parseDateKey(key) || new Date();
  autopushSelectedDate = dateKeyFromDate(d);
  autopushCalendarMonthDate = new Date(d.getFullYear(), d.getMonth(), 1);
  if (autopushDate) autopushDate.value = autopushSelectedDate;
  renderAutopushCalendar();
}

function renderAutopushCalendar() {
  if (!autopushCalendarGrid || !autopushCalendarMonth || !autopushSelectedDateEl || !autopushTasksList) return;
  ensureAutopushCalendarDate();

  const year = autopushCalendarMonthDate.getFullYear();
  const month = autopushCalendarMonthDate.getMonth();
  autopushCalendarMonth.textContent = `${PROMISE_MONTHS[month]} ${year}`;

  const taskDates = new Set((autopushTasks || []).map(autopushDateForTask));
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - startOffset);
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = dateKeyFromDate(d);
    const muted = d.getMonth() !== month ? ' is-muted' : '';
    const hasTask = taskDates.has(key) ? ' has-note' : '';
    const selected = key === autopushSelectedDate ? ' is-selected' : '';
    cells.push(`<button class="${(muted + hasTask + selected).trim()}" type="button" data-autopush-date="${esc(key)}">${d.getDate()}</button>`);
  }
  autopushCalendarGrid.innerHTML = cells.join('');

  autopushSelectedDateEl.textContent = formatPromiseDateLabel(autopushSelectedDate);
  const dayTasks = (autopushTasks || [])
    .filter((task) => autopushDateForTask(task) === autopushSelectedDate)
    .sort((a, b) => Number(a.sendAt || 0) - Number(b.sendAt || 0));

  if (!dayTasks.length) {
    autopushTasksList.innerHTML = '<div class="promise-notes__empty">На эту дату автопушей пока нет</div>';
    return;
  }

  autopushTasksList.innerHTML = dayTasks.map((task) => {
    const status = String(task.status || 'pending');
    const statusClass = status === 'sent' ? ' is-sent' : (status === 'failed' ? ' is-failed' : '');
    const client = task.sessionId
      ? `<a href="#" class="autopush-task-card__client" data-autopush-chat="${esc(task.sessionId)}">💬 ${esc(task.clientName || 'Открыть чат')}</a>`
      : '';
    const sms = task.smsText ? `<p class="autopush-task-card__sms">SMS: ${esc(task.smsText)}</p>` : '';
    return `<article class="autopush-task-card" data-autopush-task-id="${esc(task.id)}">
      <div class="autopush-task-card__top">
        <span class="autopush-task-card__time">🕐 ${esc(autopushTimeForTask(task))}</span>
        <span class="autopush-task-card__status${statusClass}">${esc(status)}</span>
      </div>
      <p class="autopush-task-card__message">${esc(task.message || '')}</p>
      ${sms}
      <div class="autopush-task-card__foot">
        ${client}
        <button class="autopush-task-card__delete" type="button" data-autopush-delete="${esc(task.id)}">🗑 Удалить</button>
      </div>
    </article>`;
  }).join('');
}

async function loadAutopushTasks() {
  try {
    const data = await api('/api/chat-op/scheduled-pushes');
    autopushTasks = (data && data.pushes) || [];
  } catch {
    autopushTasks = [];
  }
  renderAutopushCalendar();
}

async function deleteAutopushTask(id) {
  if (!id) return;
  if (!confirm('Удалить задачу автопуша?')) return;
  if (autopushResult) {
    autopushResult.style.color = '#7a90aa';
    autopushResult.textContent = 'Удаляю...';
  }
  try {
    const data = await api('/api/chat-op/scheduled-pushes/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!data || data.error) throw new Error(data?.error || 'Ошибка удаления');
    autopushTasks = autopushTasks.filter((task) => task.id !== id);
    renderAutopushCalendar();
    if (autopushResult) {
      autopushResult.style.color = '#2DB97B';
      autopushResult.textContent = '✓ Задача удалена';
    }
    await loadAutopushTasks();
  } catch (err) {
    if (autopushResult) {
      autopushResult.style.color = '#f20b5d';
      autopushResult.textContent = '✗ ' + (err?.message || 'Ошибка удаления');
    }
  }
}

function openAutopush() {
  if (!autopushModal) return;
  const d = new Date(Date.now() + 60 * 60 * 1000);
  autopushSelectedDate = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  autopushCalendarMonthDate = new Date(d.getFullYear(), d.getMonth(), 1);
  autopushDate.value = autopushSelectedDate;
  autopushTime.value = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  autopushMessage.value = '';
  autopushSmsToggle.checked = false;
  autopushSmsText.value = '';
  autopushSmsText.disabled = true;
  autopushSmsText.style.opacity = '.5';
  autopushSmsCount.textContent = '0 / 160';
  autopushResult.textContent = '';
  autopushModal.classList.add('is-open');
  autopushModal.setAttribute('aria-hidden', 'false');
  loadAutopushTasks();
}
function closeAutopush() {
  if (!autopushModal) return;
  autopushModal.classList.remove('is-open');
  autopushModal.setAttribute('aria-hidden', 'true');
}
if (autopushOpenBtn) autopushOpenBtn.addEventListener('click', () => {
  if (state.activeSessionId) openAutopush(); else alert('Сначала выберите клиента');
});
if (autopushClose) autopushClose.addEventListener('click', closeAutopush);
if (autopushCancel) autopushCancel.addEventListener('click', closeAutopush);
if (autopushModal) autopushModal.addEventListener('click', (e) => { if (e.target === autopushModal) closeAutopush(); });
if (autopushCalendarPrev) autopushCalendarPrev.addEventListener('click', () => {
  ensureAutopushCalendarDate();
  autopushCalendarMonthDate = new Date(autopushCalendarMonthDate.getFullYear(), autopushCalendarMonthDate.getMonth() - 1, 1);
  renderAutopushCalendar();
});
if (autopushCalendarNext) autopushCalendarNext.addEventListener('click', () => {
  ensureAutopushCalendarDate();
  autopushCalendarMonthDate = new Date(autopushCalendarMonthDate.getFullYear(), autopushCalendarMonthDate.getMonth() + 1, 1);
  renderAutopushCalendar();
});
if (autopushCalendarGrid) autopushCalendarGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-autopush-date]');
  if (!btn) return;
  setAutopushSelectedDate(btn.dataset.autopushDate);
});
if (autopushDate) autopushDate.addEventListener('change', () => {
  setAutopushSelectedDate(autopushDate.value);
});
if (autopushTasksList) autopushTasksList.addEventListener('click', (e) => {
  const deleteBtn = e.target.closest('[data-autopush-delete]');
  if (deleteBtn) {
    e.preventDefault();
    deleteAutopushTask(deleteBtn.dataset.autopushDelete);
    return;
  }
  const chatLink = e.target.closest('[data-autopush-chat]');
  if (!chatLink) return;
  e.preventDefault();
  closeAutopush();
  selectClient(chatLink.dataset.autopushChat);
});
if (autopushSmsToggle) autopushSmsToggle.addEventListener('change', () => {
  const on = autopushSmsToggle.checked;
  autopushSmsText.disabled = !on;
  autopushSmsText.style.opacity = on ? '1' : '.5';
  if (on) autopushSmsText.focus();
});
if (autopushSmsText) autopushSmsText.addEventListener('input', () => {
  autopushSmsCount.textContent = autopushSmsText.value.length + ' / 160';
});
if (autopushSubmit) autopushSubmit.addEventListener('click', async () => {
  if (!state.activeSessionId) return;
  const date = autopushDate.value, time = autopushTime.value;
  const message = autopushMessage.value.trim();
  if (!date || !time) { autopushResult.style.color = '#f20b5d'; autopushResult.textContent = 'Укажите дату и время'; return; }
  if (!message) { autopushResult.style.color = '#f20b5d'; autopushResult.textContent = 'Введите сообщение'; return; }
  const when = new Date(date + 'T' + time);
  if (isNaN(when.getTime())) { autopushResult.style.color = '#f20b5d'; autopushResult.textContent = 'Неверная дата/время'; return; }
  const smsText = autopushSmsToggle.checked ? autopushSmsText.value.trim() : '';
  autopushSubmit.disabled = true;
  autopushResult.style.color = '#7a90aa';
  autopushResult.textContent = 'Планирую...';
  try {
    const data = await api('/api/chat-op/schedule-push', { method: 'POST', body: { sessionId: state.activeSessionId, sendAt: when.toISOString(), message, smsText } });
    if (!data || !data.ok) throw new Error(data?.error || 'ошибка');
    autopushSelectedDate = date;
    autopushCalendarMonthDate = new Date(when.getFullYear(), when.getMonth(), 1);
    autopushResult.style.color = '#2DB97B';
    autopushResult.textContent = '✓ Запланировано на ' + date + ' ' + time;
    autopushMessage.value = '';
    autopushSmsToggle.checked = false;
    autopushSmsText.value = '';
    autopushSmsText.disabled = true;
    autopushSmsText.style.opacity = '.5';
    autopushSmsCount.textContent = '0 / 160';
    await loadAutopushTasks();
  } catch (err) {
    autopushResult.style.color = '#f20b5d';
    autopushResult.textContent = '✗ ' + (err?.message || 'Ошибка');
  } finally {
    autopushSubmit.disabled = false;
  }
});
// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  renderChatNote(null);
  renderStages(null);
  if (state.token) {
    showWorkspace();
  } else {
    showLogin();
  }
}

init();

// ─── Image preview modal ───────────────────────────────────────────────────────
const imgModal     = document.getElementById('imgModal');
const imgModalImg  = document.getElementById('imgModalImg');
const imgModalClose = document.getElementById('imgModalClose');

function openImgModal(url) {
  imgModalImg.src = url;
  imgModal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function closeImgModal() {
  imgModal.style.display = 'none';
  imgModalImg.src = '';
  document.body.style.overflow = '';
}

imgModalClose.addEventListener('click', closeImgModal);
imgModal.addEventListener('click', (e) => { if (e.target === imgModal) closeImgModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeImgModal(); });

// ─── Редактирование сообщения оператора ───────────────────────────────────────
const msgEditModal  = document.getElementById('msgEditModal');
const msgEditText   = document.getElementById('msgEditText');
const msgEditSave   = document.getElementById('msgEditSave');
const msgEditClose  = document.getElementById('msgEditClose');
const msgEditCancel = document.getElementById('msgEditCancel');
const msgEditStatus = document.getElementById('msgEditStatus');
let editingMsgId = null;

function openMsgEditModal(id, text) {
  if (!msgEditModal || !id) return;
  editingMsgId = id;
  msgEditText.value = text || '';
  msgEditStatus.textContent = '';
  msgEditModal.style.display = 'flex';
  msgEditText.focus();
}
function closeMsgEditModal() { if (msgEditModal) msgEditModal.style.display = 'none'; editingMsgId = null; }

async function saveMsgEdit() {
  if (!editingMsgId) return;
  const content = msgEditText.value.trim();
  if (!content) { msgEditStatus.style.color = '#f20b5d'; msgEditStatus.textContent = 'Пустое сообщение'; return; }
  msgEditSave.disabled = true;
  msgEditStatus.style.color = '#7a90aa';
  msgEditStatus.textContent = 'Сохраняю…';
  try {
    const data = await api('/api/chat-op/message/' + encodeURIComponent(editingMsgId), { method: 'PUT', body: { content } });
    if (!data || !data.ok) throw new Error(data?.error || 'ошибка');
    const idx = state.activeMessages.findIndex((m) => m.id === editingMsgId);
    if (idx >= 0) {
      state.activeMessages[idx] = { ...state.activeMessages[idx], content: data.content, editedAt: data.editedAt, history: data.history || [] };
      renderMessages(state.activeMessages, state.activeClient?.callerNote);
    }
    closeMsgEditModal();
  } catch (err) {
    msgEditStatus.style.color = '#f20b5d';
    const msg = err?.message;
    msgEditStatus.textContent = '✗ ' + (msg === 'forbidden' ? 'Можно править только свои сообщения' : (msg || 'Ошибка'));
  } finally {
    msgEditSave.disabled = false;
  }
}

if (msgEditSave) msgEditSave.addEventListener('click', saveMsgEdit);
if (msgEditClose) msgEditClose.addEventListener('click', closeMsgEditModal);
if (msgEditCancel) msgEditCancel.addEventListener('click', closeMsgEditModal);
if (msgEditModal) msgEditModal.addEventListener('click', (e) => { if (e.target === msgEditModal) closeMsgEditModal(); });

// Закрываем меню статуса оплаты при клике вне него.
function closeImgStatusMenus() {
  document.querySelectorAll('.img-status-menu.is-open').forEach((m) => m.classList.remove('is-open'));
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.img-status')) closeImgStatusMenus();
});
// Меню fixed — при скролле/ресайзе оно бы «отклеилось» от кнопки, проще закрыть.
if (els.messages) els.messages.addEventListener('scroll', closeImgStatusMenus);
window.addEventListener('resize', closeImgStatusMenus);

// Ставим меню рядом с кнопкой: по умолчанию правым краем к ней и вниз,
// но если не влезает в окно — разворачиваем влево/вверх.
function positionImgStatusMenu(toggle, menu) {
  const r = toggle.getBoundingClientRect();
  const pad = 8;
  menu.style.visibility = 'hidden';
  menu.classList.add('is-open');
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;

  let left = r.right - mw;
  if (left < pad) left = r.left;                                 // влево не влезло — открываем вправо
  left = Math.max(pad, Math.min(left, window.innerWidth - mw - pad));

  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - pad) top = r.top - mh - 6; // вниз не влезло — открываем вверх
  top = Math.max(pad, top);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = '';
}

els.messages.addEventListener('click', async (e) => {
  const imgBtn = e.target.closest('[data-img-preview]');
  if (imgBtn) { openImgModal(imgBtn.dataset.imgPreview); return; }

  const copyBtn = e.target.closest('[data-copy-msg]');
  if (copyBtn) {
    try {
      await copyTextToClipboard(copyBtn.dataset.copyMsg || '');
      copyBtn.classList.add('is-copied');
      showToast('Скопировано', 'success');
      setTimeout(() => copyBtn.classList.remove('is-copied'), 1200);
    } catch {
      showToast('Не удалось скопировать', 'error');
    }
    return;
  }

  const editBtn = e.target.closest('[data-edit-msg]');
  if (editBtn) { openMsgEditModal(editBtn.dataset.editMsg, editBtn.dataset.editText || ''); return; }

  // ── Меню статуса оплаты на скриншоте из чата (три точки) ──────────────────
  const statusToggle = e.target.closest('[data-img-status-toggle]');
  if (statusToggle) {
    e.stopPropagation();
    const menu = statusToggle.parentElement.querySelector('.img-status-menu');
    const willOpen = menu && !menu.classList.contains('is-open');
    closeImgStatusMenus();
    if (willOpen) positionImgStatusMenu(statusToggle, menu);
    return;
  }

  const setStatusBtn = e.target.closest('[data-set-payment-status]');
  if (setStatusBtn) {
    const type = setStatusBtn.dataset.setPaymentStatus;
    const labels = { insurance: 'FD', return: 'RD1', loantransfer: 'RD2', creditcard: 'RD3' };
    const sid = state.activeSessionId;
    const menu = setStatusBtn.closest('.img-status-menu');
    if (menu) menu.classList.remove('is-open');
    if (!sid) return;
    if (state.activePaymentStatuses[type] === 'confirmed') return; // уже подтверждён
    if (!window.confirm(`Отметить оплату как ${labels[type]}?\nЭто запишет депозит в статистику и поставит снежок ❄️.`)) return;
    const screenshotUrl = setStatusBtn.dataset.screenshot || '';
    state.activePaymentStatuses[type] = 'confirmed';
    state.activePaymentStatus = state.activePaymentStatuses.insurance;
    const ci = state.clients.findIndex((c) => c.flowSessionId === sid);
    if (ci >= 0) state.clients[ci] = { ...state.clients[ci], paymentPending: hasPendingPaymentStatus(state.activePaymentStatuses) };
    renderMessages(state.activeMessages, state.activeClient?.callerNote);
    renderConversations();
    renderStages(state.activeClient);
    try {
      await api('/api/chat-op/payment/confirm', { method: 'POST', body: { sessionId: sid, type, screenshotUrl } });
    } catch {
      state.activePaymentStatuses[type] = 'none';
      state.activePaymentStatus = state.activePaymentStatuses.insurance;
      if (ci >= 0) state.clients[ci] = { ...state.clients[ci], paymentPending: hasPendingPaymentStatus(state.activePaymentStatuses) };
      renderMessages(state.activeMessages, state.activeClient?.callerNote);
      renderConversations();
      renderStages(state.activeClient);
    }
    return;
  }

  const cancelStatusBtn = e.target.closest('[data-cancel-payment-status]');
  if (cancelStatusBtn) {
    const sid = state.activeSessionId;
    const labels = { insurance: 'FD', return: 'RD1', loantransfer: 'RD2', creditcard: 'RD3' };
    const menu = cancelStatusBtn.closest('.img-status-menu');
    if (menu) menu.classList.remove('is-open');
    if (!sid) return;
    const confirmedTypes = ['insurance', 'return', 'loantransfer', 'creditcard'].filter((t) => state.activePaymentStatuses[t] === 'confirmed');
    if (!confirmedTypes.length) { alert('Нет подтверждённых статусов для отмены.'); return; }
    if (!window.confirm(`Сбросить статус оплаты (${confirmedTypes.map((t) => labels[t]).join(', ')})?\nДепозит в статистике при этом не удаляется.`)) return;
    const prev = { ...state.activePaymentStatuses };
    confirmedTypes.forEach((t) => { state.activePaymentStatuses[t] = 'rejected'; });
    state.activePaymentStatus = state.activePaymentStatuses.insurance;
    const ci = state.clients.findIndex((c) => c.flowSessionId === sid);
    if (ci >= 0) state.clients[ci] = { ...state.clients[ci], paymentPending: hasPendingPaymentStatus(state.activePaymentStatuses) };
    renderMessages(state.activeMessages, state.activeClient?.callerNote);
    renderConversations();
    renderStages(state.activeClient);
    try {
      for (const t of confirmedTypes) {
        await api('/api/chat-op/payment/reject', { method: 'POST', body: { sessionId: sid, type: t } });
      }
    } catch {
      state.activePaymentStatuses = prev;
      state.activePaymentStatus = state.activePaymentStatuses.insurance;
      renderMessages(state.activeMessages, state.activeClient?.callerNote);
      renderConversations();
      renderStages(state.activeClient);
    }
    return;
  }

  const confirmBtn = e.target.closest('[data-payment-confirm]');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    const sid = confirmBtn.dataset.paymentConfirm;
    const type = confirmBtn.dataset.paymentType || 'insurance';
    const screenshotUrl = confirmBtn.dataset.screenshot || '';
    state.activePaymentStatuses[type] = 'confirmed';
    state.activePaymentStatus = state.activePaymentStatuses.insurance;
    const ci = state.clients.findIndex((c) => c.flowSessionId === sid);
    if (ci >= 0) state.clients[ci] = { ...state.clients[ci], paymentPending: hasPendingPaymentStatus(state.activePaymentStatuses) };
    renderMessages(state.activeMessages, state.activeClient?.callerNote);
    renderConversations();
    renderStages(state.activeClient);
    try {
      await api('/api/chat-op/payment/confirm', { method: 'POST', body: { sessionId: sid, type, screenshotUrl } });
    } catch {
      state.activePaymentStatuses[type] = 'none';
      state.activePaymentStatus = state.activePaymentStatuses.insurance;
      if (ci >= 0) state.clients[ci] = { ...state.clients[ci], paymentPending: true };
      renderMessages(state.activeMessages, state.activeClient?.callerNote);
      renderConversations();
      renderStages(state.activeClient);
    }
    return;
  }

  const rejectBtn = e.target.closest('[data-payment-reject]');
  if (rejectBtn) {
    rejectBtn.disabled = true;
    const sid = rejectBtn.dataset.paymentReject;
    const type = rejectBtn.dataset.paymentType || 'insurance';
    state.activePaymentStatuses[type] = 'rejected';
    state.activePaymentStatus = state.activePaymentStatuses.insurance;
    const ci = state.clients.findIndex((c) => c.flowSessionId === sid);
    if (ci >= 0) state.clients[ci] = { ...state.clients[ci], paymentPending: hasPendingPaymentStatus(state.activePaymentStatuses) };
    renderMessages(state.activeMessages, state.activeClient?.callerNote);
    renderConversations();
    renderStages(state.activeClient);
    try {
      await api('/api/chat-op/payment/reject', { method: 'POST', body: { sessionId: sid, type } });
    } catch {
      state.activePaymentStatuses[type] = 'none';
      state.activePaymentStatus = state.activePaymentStatuses.insurance;
      if (ci >= 0) state.clients[ci] = { ...state.clients[ci], paymentPending: true };
      renderMessages(state.activeMessages, state.activeClient?.callerNote);
      renderConversations();
      renderStages(state.activeClient);
    }
    return;
  }
});
