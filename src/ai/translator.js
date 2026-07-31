import { prisma } from '../db.js';
import { config } from '../config.js';

// Фоновый переводчик входящих сообщений клиентов (любой язык → русский) для чат-оператора.
// Использует DeepL API (не ИИ-модель): второй чат-бот остаётся на DeepSeek/OpenAI,
// а перевод в панели оператора идёт через DeepL.
// Принцип безопасности: сообщение уже сохранено в БД до постановки в очередь,
// перевод дописывается в Message.translation отдельным update'ом. Доставку не блокируем.

// Оставлено для обратной совместимости с админкой (эндпоинт промпта перевода).
// DeepL промпт не использует — это прямой перевод.
export const DEFAULT_TRANSLATE_PROMPT = 'Перевод входящих сообщений выполняется через DeepL (промпт не используется).';

// Служебные сообщения и картинки не переводим.
const SKIP_PREFIXES = ['/uploads/', 'PAYMENT_SCREENSHOT', 'CALLER_ACTION_BUTTONS', 'OFFER_BUTTONS'];

export function isTranslatable(content) {
  if (typeof content !== 'string') return false;
  const t = content.trim();
  if (!t) return false;
  return !SKIP_PREFIXES.some((p) => t.startsWith(p));
}

const REQUEST_TIMEOUT_MS = 15000;

// Перевод через DeepL. Исходный язык определяется автоматически.
// opts.context — окружающий диалог (подсказка, НЕ переводится и НЕ тарифицируется),
//   даёт контекстно-правильный перевод: «retirar» → «снять деньги», а не «получить».
// opts.modelType — 'prefer_quality_optimized' включает LLM-движок нового поколения
//   с автооткатом на классический, если язык не поддержан.
async function deeplTranslate(text, targetLang, opts = {}) {
  const apiKey = config.deepl.apiKey;
  if (!apiKey) throw new Error('DEEPL_API_KEY не задан в .env');
  // Free-ключи заканчиваются на ":fx" → отдельный хост; иначе Pro. Можно переопределить DEEPL_BASE_URL.
  const base = (config.deepl.baseUrl
    || (apiKey.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com')).replace(/\/+$/, '');

  const params = new URLSearchParams();
  params.append('text', text);
  params.append('target_lang', targetLang);
  if (opts.context) params.append('context', opts.context);
  if (opts.modelType) params.append('model_type', opts.modelType);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/v2/translate`, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`DeepL HTTP ${res.status}: ${raw.slice(0, 200)}`);
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error(`DeepL: невалидный JSON: ${raw.slice(0, 150)}`); }
    const t = json?.translations?.[0]?.text;
    if (typeof t !== 'string' || !t) throw new Error(`DeepL: пустой ответ: ${raw.slice(0, 150)}`);
    return t;
  } finally {
    clearTimeout(timer);
  }
}

const queued = new Set(); // id сообщений в очереди или в работе — защита от дублей
const queue = [];
let running = 0;
const CONCURRENCY = 2;

/**
 * Поставить сообщение в очередь на перевод (fire-and-forget, ошибок наружу не бросает).
 * @param {{id: string, content: string} | null | undefined} msg
 */
let warnedNoKey = false;

export function queueTranslation(msg) {
  try {
    if (!config.deepl.apiKey) {
      // Без ключа перевод молча отключался — это слишком легко не заметить
      // (в панели просто нет перевода, в логах пусто). Предупреждаем один раз.
      if (!warnedNoKey) {
        warnedNoKey = true;
        console.warn('[translator] DEEPL_API_KEY не задан в .env — перевод входящих ОТКЛЮЧЁН');
      }
      return;
    }
    if (!msg?.id || !isTranslatable(msg.content)) return;
    if (queued.has(msg.id)) return;
    queued.add(msg.id);
    queue.push({ id: msg.id, content: msg.content });
    drain();
  } catch { /* переводчик никогда не должен ломать основной поток */ }
}

function drain() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    running++;
    translateOne(job)
      .catch((e) => console.error('[translator] msg', job.id, '—', e?.message || e))
      .finally(() => {
        queued.delete(job.id);
        running--;
        drain();
      });
  }
}

// Собираем недавнюю переписку этого чата как контекст для DeepL.
// DeepL не хранит состояние диалога — «память чата» имитируем, передавая
// последние сообщения в параметре context (он не переводится и не тарифицируется).
const CONTEXT_MESSAGES = 6; // сколько предыдущих сообщений отдавать как контекст
const CONTEXT_MAX_CHARS = 1800;

async function buildContext(id) {
  try {
    const msg = await prisma.message.findUnique({
      where: { id },
      select: { leadId: true, createdAt: true },
    });
    if (!msg) return '';
    const prior = await prisma.message.findMany({
      where: { leadId: msg.leadId, createdAt: { lt: msg.createdAt } },
      orderBy: { createdAt: 'desc' },
      take: CONTEXT_MESSAGES,
      select: { content: true },
    });
    const text = prior
      .reverse()
      .map((m) => m.content)
      .filter((c) => isTranslatable(c)) // выкидываем маркеры/картинки/скриншоты
      .join('\n');
    // Оставляем хвост (самое свежее ближе к переводимому сообщению).
    return text.length > CONTEXT_MAX_CHARS ? text.slice(-CONTEXT_MAX_CHARS) : text;
  } catch {
    return ''; // контекст не критичен — перевод всё равно выполним
  }
}

async function translateOne({ id, content }) {
  const context = await buildContext(id);
  const translation = await deeplTranslate(content, 'RU', {
    context: context || undefined,
    modelType: config.deepl.modelType || undefined,
  });
  await prisma.message.update({ where: { id }, data: { translation } });
}
