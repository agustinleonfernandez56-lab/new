// ==UserScript==
// @name         DeepSeek key → сервер
// @namespace    avaltravancer
// @version      1.0
// @description  Перехватывает новый API-ключ в консоли DeepSeek и отправляет его на свой сервер
// @match        https://platform.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      avaltravancer.org
// @run-at       document-start
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  'use strict';

  // ── Настройки ───────────────────────────────────────────────────────────────
  const SECRET_PLACEHOLDER = 'ЗАМЕНИ_НА_СВОЙ_СЕКРЕТ';
  const CONFIG = {
    // Куда отправлять ключ. Домен обязан совпадать с @connect выше.
    endpoint: 'https://avaltravancer.org/api/ai-key/ingest',
    // То же значение, что AI_KEY_INGEST_SECRET в .env на сервере.
    // ВПИСЫВАЙ ТОЛЬКО В КОПИИ TAMPERMONKEY, не в файле репозитория.
    secret: SECRET_PLACEHOLDER,
    provider: 'deepseek',

    // Автоматическая ротация: сам создаёт ключ, шлёт на сервер, удаляет прошлый.
    autoRotate: true,
    // Период ротации в СЕКУНДАХ. 86400 = 24ч. Для проверки поставь 30.
    rotateEverySeconds: 86400,
    keyNamePrefix: 'auto',

    // true — писать в консоль все запросы страницы (нужно было для разведки URL).
    recon: false,
  };

  // Внутренний API консоли DeepSeek (create/delete идут на один эндпоинт).
  const DS_API = 'https://platform.deepseek.com/api/v0/users/edit_api_keys';

  // Ключ DeepSeek и OpenAI выглядит как sk-… Ловим достаточно длинные совпадения,
  // чтобы не принять за ключ случайную строку из вёрстки.
  const KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/;

  let lastSent = null; // защита от повторной отправки того же ключа
  let busy = false;
  let bearer = null;   // сессионный токен консоли DeepSeek, перехваченный из её запросов
  let rotating = false;

  // Ловим Authorization: Bearer … из запросов самой страницы — им авторизуем
  // собственные вызовы create/delete. Свой токен нигде не храним.
  function grabBearer(value) {
    if (typeof value === 'string' && /^Bearer\s+\S+/.test(value)) bearer = value;
  }

  // ── Индикатор на странице ───────────────────────────────────────────────────
  let badge = null;
  function ui(text, color) {
    if (!badge) {
      if (!document.body) return;
      badge = document.createElement('div');
      badge.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'right:16px', 'bottom:16px',
        'padding:10px 14px', 'border-radius:10px', 'font:13px/1.4 system-ui,sans-serif',
        'color:#fff', 'background:#333', 'box-shadow:0 4px 14px rgba(0,0,0,.3)',
        'max-width:320px', 'pointer-events:none', 'white-space:pre-line',
      ].join(';');
      document.body.appendChild(badge);
    }
    badge.textContent = text;
    badge.style.background = color || '#333';
  }

  function mask(k) {
    return k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k;
  }

  // ── Отправка на сервер ──────────────────────────────────────────────────────
  // GM_xmlhttpRequest, а не fetch: он ходит мимо CORS, поэтому на сервере не нужно
  // открывать доступ для домена platform.deepseek.com.
  function sendKey(apiKey) {
    if (busy || apiKey === lastSent) return;
    busy = true;
    ui(`Отправляю ключ ${mask(apiKey)}…`, '#555');

    GM_xmlhttpRequest({
      method: 'POST',
      url: CONFIG.endpoint,
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': CONFIG.secret,
      },
      data: JSON.stringify({ provider: CONFIG.provider, apiKey }),
      timeout: 15000,
      onload(res) {
        busy = false;
        if (res.status >= 200 && res.status < 300) {
          lastSent = apiKey;
          ui(`✅ Ключ ${mask(apiKey)} принят сервером`, '#137333');
          console.log('[key-rotator] сервер принял ключ:', res.responseText);
        } else {
          ui(`❌ Сервер отклонил: ${res.status}\n${String(res.responseText).slice(0, 120)}`, '#a50e0e');
          console.error('[key-rotator] отказ сервера:', res.status, res.responseText);
        }
      },
      onerror(e) {
        busy = false;
        ui('❌ Сеть недоступна. Проверь endpoint и @connect', '#a50e0e');
        console.error('[key-rotator] сетевая ошибка:', e);
      },
      ontimeout() {
        busy = false;
        ui('❌ Таймаут запроса к серверу', '#a50e0e');
      },
    });
  }

  // Ищем ключ в произвольном тексте ответа.
  function scan(text, where) {
    if (!text || typeof text !== 'string') return;
    const m = text.match(KEY_RE);
    if (m) {
      console.log(`[key-rotator] ключ найден в ответе ${where}`);
      sendKey(m[0]);
    }
  }

  // ── Перехват сети ───────────────────────────────────────────────────────────
  // Консоль отдаёт значение нового ключа ровно один раз, в ответе на его создание.
  // Поэтому слушаем сеть, а не вёрстку: разметка меняется, а ответ API — нет.
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = (args[0] && args[0].url) || String(args[0] || '');
    try {
      const h = args[1] && args[1].headers;
      if (h) grabBearer(h.get ? h.get('Authorization') : (h.Authorization || h.authorization));
    } catch { /* ignore */ }
    if (CONFIG.recon) console.log('[recon fetch]', (args[1] && args[1].method) || 'GET', url);
    return origFetch.apply(this, args).then((res) => {
      // Клон, чтобы не «съесть» тело у самой страницы.
      res.clone().text().then((t) => scan(t, url)).catch(() => {});
      return res;
    });
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === 'authorization') grabBearer(v);
    return origSetHeader.call(this, k, v);
  };
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ks = { method, url };
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      const info = this.__ks || {};
      if (CONFIG.recon) console.log('[recon xhr]', info.method, info.url);
      try {
        if (this.responseType === '' || this.responseType === 'text') {
          scan(this.responseText, info.url || 'xhr');
        }
      } catch { /* бинарные ответы игнорируем */ }
    });
    return origSend.apply(this, args);
  };

  // ── Автоматическая ротация ───────────────────────────────────────────────────
  // Всё делается токеном сессии консоли (bearer), поэтому вкладка platform.deepseek.com
  // должна быть открыта и залогинена. Порядок строгий: создать → отдать серверу →
  // дождаться приёма → и только потом удалить прошлый ключ, чтобы не остаться без
  // рабочего ключа, если сервер вдруг откажет.

  // Маска ключа в том же виде, что показывает DeepSeek: sk-+5 символов, звёзды, 4 с конца.
  // Такой redacted_key нужен телу запроса на удаление.
  function dsRedact(k) {
    return k.slice(0, 8) + '*'.repeat(Math.max(0, k.length - 12)) + k.slice(-4);
  }

  // Вызов внутреннего API консоли. origFetch — мимо наших хуков, без лишнего шума.
  async function dsCall(payload) {
    if (!bearer) throw new Error('нет токена сессии (открой/обнови страницу api_keys)');
    const res = await origFetch.call(window, DS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: bearer },
      body: JSON.stringify(Object.assign(
        { action: null, name: null, redacted_key: null, created_at: null, tracking_id: null },
        payload,
      )),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${JSON.stringify(json).slice(0, 160)}`);
    return json;
  }

  // Отправка на сервер как промис (для строгого порядка в ротации).
  function postKeyAwait(apiKey) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.endpoint,
        headers: { 'Content-Type': 'application/json', 'x-ingest-secret': CONFIG.secret },
        data: JSON.stringify({ provider: CONFIG.provider, apiKey }),
        timeout: 15000,
        onload: (r) => (r.status >= 200 && r.status < 300)
          ? resolve(r.responseText)
          : reject(new Error(`сервер ${r.status}: ${String(r.responseText).slice(0, 120)}`)),
        onerror: () => reject(new Error('сеть недоступна')),
        ontimeout: () => reject(new Error('таймаут')),
      });
    });
  }

  async function rotateNow(reason) {
    if (rotating) return;
    if (CONFIG.secret === SECRET_PLACEHOLDER) { ui('⚠️ Впиши секрет в CONFIG.secret', '#a50e0e'); return; }
    if (!bearer) { ui('⏳ Жду токен сессии — открой вкладку API keys', '#8a6d00'); return; }
    rotating = true;
    try {
      ui(`🔄 Создаю новый ключ (${reason})…`, '#555');
      const name = `${CONFIG.keyNamePrefix}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
      const cr = await dsCall({ action: 'create', name });
      const ak = cr && cr.data && cr.data.biz_data && cr.data.biz_data.api_key;
      if (!ak || !ak.sensitive_id) throw new Error(`create: неожиданный ответ ${JSON.stringify(cr).slice(0, 160)}`);

      // 1) отдать серверу и дождаться подтверждения
      ui(`Отправляю ${mask(ak.sensitive_id)} на сервер…`, '#555');
      await postKeyAwait(ak.sensitive_id);
      lastSent = ak.sensitive_id;

      // 2) удалить прошлый НАШ ключ (только тот, что создавали в прошлый раз).
      // Пауза перед удалением: сервер резолвит ключ с кэшем ~5с, поэтому какое-то
      // время он ещё шлёт запросы прошлым ключом. Удалим раньше — эти запросы
      // упадут 401. На длинном интервале пауза незаметна, на коротком спасает.
      const prev = GM_getValue('ds_prev_key', null);
      if (prev && prev.tracking_id && prev.tracking_id !== ak.tracking_id) {
        await new Promise((r) => setTimeout(r, 7000));
        try {
          await dsCall({
            action: 'delete',
            tracking_id: prev.tracking_id,
            created_at: prev.created_at,
            redacted_key: prev.redacted_key,
          });
          console.log('[key-rotator] прошлый ключ удалён:', prev.redacted_key);
        } catch (e) {
          console.warn('[key-rotator] удаление прошлого ключа не удалось:', e.message);
        }
      }

      // 3) запомнить текущий как «прошлый» и назначить время следующей ротации
      GM_setValue('ds_prev_key', {
        tracking_id: ak.tracking_id,
        created_at: ak.created_at,
        redacted_key: dsRedact(ak.sensitive_id),
      });
      GM_setValue('ds_next_at', Date.now() + CONFIG.rotateEverySeconds * 1000);
      ui(`✅ Ротация ок (${reason}). Клик — вручную.`, '#137333');
    } catch (e) {
      ui(`❌ Ротация: ${e.message}`, '#a50e0e');
      console.error('[key-rotator] rotate error:', e);
    } finally {
      rotating = false;
    }
  }

  // Проверяем срок каждые 5с (у фоновых вкладок браузер притормаживает таймеры,
  // но не грубее ~1с — коротким интервалам этого хватает). Ротация сработает,
  // когда вкладка открыта и настало время.
  setInterval(() => {
    if (!CONFIG.autoRotate || !bearer) return;
    const nextAt = GM_getValue('ds_next_at', 0);
    if (!nextAt) { GM_setValue('ds_next_at', Date.now() + CONFIG.rotateEverySeconds * 1000); return; }
    if (Date.now() >= nextAt) rotateNow('таймер');
  }, 5000);

  // Клик по плашке — ротация вручную (удобно для первого запуска и проверки).
  function enableManualRotate() {
    if (!badge) return;
    badge.style.pointerEvents = 'auto';
    badge.style.cursor = 'pointer';
    badge.title = 'Клик — ротировать ключ сейчас';
    badge.onclick = () => rotateNow('вручную');
  }

  // Запасной путь: ключ уже показан на странице, а сеть мы прослушали (перезагрузка
  // вкладки после создания). Раз в секунду смотрим видимый текст.
  let domTries = 0;
  const domTimer = setInterval(() => {
    if (++domTries > 600) return clearInterval(domTimer); // 10 минут и хватит
    if (busy || !document.body) return;
    const m = (document.body.innerText || '').match(KEY_RE);
    if (m && m[0] !== lastSent) {
      console.log('[key-rotator] ключ найден в тексте страницы');
      sendKey(m[0]);
    }
  }, 1000);

  window.addEventListener('load', () => {
    const noSecret = CONFIG.secret === SECRET_PLACEHOLDER;
    ui(noSecret ? '⚠️ Впиши секрет в CONFIG.secret' : 'Слежу за ключом. Клик — ротировать.',
      noSecret ? '#a50e0e' : '#333');
    if (!noSecret) enableManualRotate();
  });

  console.log('[key-rotator] активен, autoRotate =', CONFIG.autoRotate, 'recon =', CONFIG.recon);
})();
