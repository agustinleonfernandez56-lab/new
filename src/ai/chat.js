import { config } from '../config.js';
import { getBotConfig } from './botConfig.js';
import { sendPlainToTelegram } from '../telegram.js';

const REQUEST_TIMEOUT_MS = 60000;
// Нижняя граница бюджета для reasoning-моделей: у них в max_tokens входят
// и размышления, поэтому 1024 не хватает — ответ приходит пустым.
const REASONING_MIN_TOKENS = 4096;
const REQUEST_LOG_TEXT_LIMIT = 1000;

// Все провайдеры используют OpenAI-совместимый /chat/completions.
// Ключ и модель берём из .env (config.js). Модель у каждого — своя.
const PROVIDERS = {
  deepseek: () => ({
    label: 'DeepSeek',
    apiKey: config.deepseek.apiKey,
    baseUrl: config.deepseek.baseUrl,
    model: config.deepseek.model,
    envHint: 'DEEPSEEK_API_KEY',
  }),
  openai: () => ({
    label: 'OpenAI',
    apiKey: config.openai.apiKey,
    baseUrl: config.openai.baseUrl,
    model: config.openai.model,
    envHint: 'OPENAI_API_KEY',
  }),
  qwen: () => ({
    label: 'Qwen',
    apiKey: config.qwen.apiKey,
    baseUrl: config.qwen.baseUrl,
    model: config.qwen.model,
    envHint: 'QWEN_API_KEY',
  }),
};

export const AI_PROVIDER_IDS = Object.keys(PROVIDERS);

export function normalizeProvider(p) {
  return PROVIDERS[p] ? p : (PROVIDERS[config.aiProvider] ? config.aiProvider : 'deepseek');
}

// Есть ли ключ у провайдера (для индикации в админке).
export function providerHasKey(p) {
  const meta = PROVIDERS[normalizeProvider(p)]();
  return !!meta.apiKey;
}

// Модель для провайдера: берём запрошенную только если она подходит провайдеру,
// иначе — дефолтную для провайдера (страхует от «deepseek-chat» уехавшего в OpenAI).
function modelFor(providerId, requested) {
  const def = PROVIDERS[providerId]().model;
  if (!requested || typeof requested !== 'string') return def;
  const r = requested.trim().toLowerCase();
  if (!r) return def;
  if (providerId === 'openai') return /^(gpt|o\d|chatgpt|text-|ft:)/.test(r) ? requested.trim() : def;
  if (providerId === 'qwen') return /^(qwen|qwq|qvq)/.test(r) ? requested.trim() : def;
  return r.includes('deepseek') ? requested.trim() : def; // deepseek
}

// deepseek-v4-*, o-серия OpenAI и qwq/qvq у Qwen сначала «думают», и размышления
// тоже расходуют max_tokens.
function isReasoningModel(model) {
  const m = String(model || '').toLowerCase();
  return /deepseek-(v4|r1)/.test(m) || /^o\d/.test(m) || /^(qwq|qvq)/.test(m)
    || m.includes('reasoner') || m.includes('thinking');
}

// Возвращает активный провайдер: явный из opts, иначе из настроек бота, иначе дефолт.
async function resolveProvider(explicit) {
  if (explicit) return normalizeProvider(explicit);
  try {
    const cfg = await getBotConfig();
    return normalizeProvider(cfg.provider);
  } catch {
    return normalizeProvider();
  }
}

function shortenLogValue(value, limit = REQUEST_LOG_TEXT_LIMIT) {
  const text = String(value || '').trim();
  if (!text) return '—';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function sendAiRequestLog({ enabled, provider, model, messages, trace, durationMs, status }) {
  if (!enabled) return;

  const request = [...messages].reverse().find((message) => message?.role === 'user')?.content;
  const lines = [
    '🤖 AI-запрос',
    `Статус: ${status}`,
    `Провайдер: ${provider}`,
    `Модель: ${model}`,
    trace?.source ? `Источник: ${shortenLogValue(trace.source, 120)}` : '',
    trace?.sessionId ? `Session: ${shortenLogValue(trace.sessionId, 120)}` : '',
    trace?.leadId ? `Lead ID: ${shortenLogValue(trace.leadId, 120)}` : '',
    trace?.telegramUserId ? `Telegram user ID: ${shortenLogValue(trace.telegramUserId, 120)}` : '',
    trace?.telegramChatId ? `Telegram chat ID: ${shortenLogValue(trace.telegramChatId, 120)}` : '',
    trace?.clientName ? `Клиент: ${shortenLogValue(trace.clientName, 120)}` : '',
    `Запрос: ${shortenLogValue(request)}`,
    `Время: ${durationMs} мс`,
  ].filter(Boolean);

  sendPlainToTelegram(lines.join('\n'));
}

/**
 * Универсальный вызов чат-модели. DeepSeek, OpenAI и Qwen — OpenAI-совместимый
 * API, поэтому логика одна, различаются только endpoint, ключ и модель.
 * @param {Array<{role:string, content:string}>} messages
 * @param {{provider?:string, model?:string, temperature?:number, maxTokens?:number}} [opts]
 * @returns {Promise<string>} assistant reply text
 */
export async function aiChat(messages, opts = {}) {
  const providerId = await resolveProvider(opts.provider);
  const p = PROVIDERS[providerId]();
  if (!p.apiKey) {
    throw new Error(`${p.envHint} не задан в .env (провайдер ${p.label})`);
  }

  const model = modelFor(providerId, opts.model);
  const url = `${p.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  // У reasoning-моделей max_tokens покрывает и размышления, и сам ответ.
  // При тесном лимите модель успевает только «подумать» и возвращает
  // content: "" — поэтому держим для них запас побольше.
  const reasoning = isReasoningModel(model);
  const wanted = typeof opts.maxTokens === 'number' ? opts.maxTokens : 1024;
  const maxTokens = reasoning ? Math.max(wanted, REASONING_MIN_TOKENS) : wanted;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  async function ask(tokenBudget) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
        max_tokens: tokenBudget,
        stream: false,
      }),
      signal: controller.signal,
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`${p.label} HTTP ${res.status}: ${raw.slice(0, 300)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${p.label}: невалидный JSON: ${raw.slice(0, 200)}`);
    }
    const choice = parsed?.choices?.[0];
    return { raw, content: choice?.message?.content, finish: choice?.finish_reason || '' };
  }

  try {
    let out = await ask(maxTokens);

    // Бюджет кончился на размышлениях — даём один повтор с удвоенным лимитом.
    if ((typeof out.content !== 'string' || !out.content.trim()) && out.finish === 'length') {
      console.warn(`[ai] ${model}: пустой content (finish=length, budget=${maxTokens}) — повтор с ${maxTokens * 2}`);
      out = await ask(maxTokens * 2);
    }

    const text = out.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error(`${p.label}: пустой ответ (finish=${out.finish || '—'}): ${out.raw.slice(0, 200)}`);
    }
    sendAiRequestLog({
      enabled: opts.tgRequestLogging === true,
      provider: providerId,
      model,
      messages,
      trace: opts.trace,
      durationMs: Date.now() - startedAt,
      status: 'успешно',
    });
    return text.trim();
  } catch (error) {
    sendAiRequestLog({
      enabled: opts.tgRequestLogging === true,
      provider: providerId,
      model,
      messages,
      trace: opts.trace,
      durationMs: Date.now() - startedAt,
      status: 'ошибка',
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
