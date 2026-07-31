// Проверка подключения DeepL: показывает ключ, лимит и живой перевод.
// Запуск на сервере из корня проекта:  node scripts/deepl-test.mjs
//
// Читает тот же config, что и приложение, — если тут работает, работает и в панели.
import { config } from '../src/config.js';

const key = config.deepl.apiKey;

console.log('═══ КЛЮЧ ═══');
if (!key) {
  console.log('  DEEPL_API_KEY: НЕ ЗАДАН');
  console.log('\n  Перевод отключён — приложение даже не обращается к DeepL.');
  console.log('  Добавь в .env и перезапусти сервер (config читается один раз при старте):');
  console.log('    DEEPL_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx');
  process.exit(1);
}
console.log(`  DEEPL_API_KEY: задан — ${key.slice(0, 4)}…${key.slice(-3)} (${key.length} симв.)`);

const base = (config.deepl.baseUrl
  || (key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com')).replace(/\/+$/, '');
console.log(`  тип: ${key.endsWith(':fx') ? 'Free (:fx)' : 'Pro'} | хост: ${base}`);
if (config.deepl.baseUrl) console.log('  (хост задан вручную через DEEPL_BASE_URL)');

const auth = { Authorization: `DeepL-Auth-Key ${key}` };

console.log('\n═══ ЛИМИТ (/v2/usage) ═══');
try {
  const res = await fetch(`${base}/v2/usage`, { headers: auth });
  const raw = await res.text();
  console.log(`  HTTP ${res.status}: ${raw}`);
  if (res.status === 403) console.log('  ← 403 = ключ неверный или не от этого типа аккаунта (Free/Pro перепутан)');
} catch (e) {
  console.log('  сеть недоступна:', e.message);
}

console.log('\n═══ ТЕСТОВЫЙ ПЕРЕВОД (es → ru) ═══');
try {
  const params = new URLSearchParams();
  params.append('text', 'Hola, quiero completar mi crédito');
  params.append('target_lang', 'RU');
  const res = await fetch(`${base}/v2/translate`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const raw = await res.text();
  console.log(`  HTTP ${res.status}`);
  console.log(`  ответ: ${raw}`);
  if (res.ok) {
    console.log('\n  ✓ DeepL работает. Если в панели перевода нет — сервер не перезапускали после правки .env.');
  }
} catch (e) {
  console.log('  ошибка:', e.message);
}
