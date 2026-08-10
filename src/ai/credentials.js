import { prisma } from '../db.js';
import { config } from '../config.js';

// Ключи провайдеров ИИ с двумя источниками:
//   1) таблица ApiCredential — приоритетный, меняется из админки и userscript'ом;
//   2) .env — фоллбэк, работает пока в таблице нет записи.
// Такой порядок позволяет ротировать ключ без ssh и без перезапуска процесса.

const CACHE_TTL_MS = 5000; // короткий кэш: подмена ключа подхватывается почти сразу

// Провайдеры, у которых вообще есть ключ в .env.
const ENV_KEY = {
  deepseek: () => config.deepseek.apiKey,
  openai: () => config.openai.apiKey,
};

export const CREDENTIAL_PROVIDERS = Object.keys(ENV_KEY);

let cache = null; // Map<provider, {apiKey, note, updatedAt}>
let cachedAt = 0;

export function invalidateCredentialsCache() {
  cache = null;
  cachedAt = 0;
}

async function loadFromDb() {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_TTL_MS) return cache;
  const map = new Map();
  try {
    const rows = await prisma.apiCredential.findMany({
      select: { provider: true, apiKey: true, note: true, updatedAt: true },
    });
    for (const r of rows) map.set(r.provider, r);
  } catch (e) {
    // Таблицы может не быть (миграция не накатана) — тихо работаем на .env.
    console.warn('[credentials] чтение из БД не удалось, работаем на .env:', e?.message || e);
  }
  cache = map;
  cachedAt = now;
  return cache;
}

// Итоговый ключ провайдера: из БД, иначе из .env.
export async function resolveApiKey(provider) {
  const db = await loadFromDb();
  const row = db.get(provider);
  if (row?.apiKey) return row.apiKey;
  return ENV_KEY[provider] ? ENV_KEY[provider]() : '';
}

export async function setApiKey(provider, apiKey, note = 'admin') {
  if (!ENV_KEY[provider]) throw new Error(`неизвестный провайдер: ${provider}`);
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('пустой ключ');
  await prisma.apiCredential.upsert({
    where: { provider },
    create: { provider, apiKey: key, note },
    update: { apiKey: key, note },
  });
  invalidateCredentialsCache();
}

// Убирает ключ из БД — провайдер возвращается на значение из .env.
export async function clearApiKey(provider) {
  await prisma.apiCredential.deleteMany({ where: { provider } });
  invalidateCredentialsCache();
}

// Ключ целиком наружу не отдаём никогда — только хвост для опознания.
export function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 12) return `${k.slice(0, 2)}…${k.slice(-2)}`;
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

// Состояние для админки: что задано, откуда взято, когда обновлено.
export async function listCredentials() {
  const db = await loadFromDb();
  return CREDENTIAL_PROVIDERS.map((provider) => {
    const row = db.get(provider);
    const envKey = ENV_KEY[provider]();
    const active = row?.apiKey || envKey || '';
    return {
      provider,
      source: row?.apiKey ? 'db' : (envKey ? 'env' : 'none'),
      hasKey: !!active,
      masked: maskKey(active),
      note: row?.note || null,
      updatedAt: row?.updatedAt || null,
      envAvailable: !!envKey, // есть ли куда откатиться при сбросе
    };
  });
}
