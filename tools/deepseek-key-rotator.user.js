// ==UserScript==
// @name         DeepSeek key → сервер
// @namespace    avaltravancer
// @version      1.0
// @description  Перехватывает новый API-ключ в консоли DeepSeek и отправляет его на свой сервер
// @match        https://platform.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @connect      avaltravancer.org
// @run-at       document-start
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  'use strict';

  // ── Настройки ───────────────────────────────────────────────────────────────
  const CONFIG = {
    // Куда отправлять ключ. Домен обязан совпадать с @connect выше.
    endpoint: 'https://avaltravancer.org/api/ai-key/ingest',
    // То же значение, что AI_KEY_INGEST_SECRET в .env на сервере.
    secret: 'ЗАМЕНИ_НА_СВОЙ_СЕКРЕТ',
    provider: 'deepseek',
    // true — писать в консоль браузера все запросы страницы. Нужно один раз,
    // чтобы вытащить внутренние URL создания и удаления ключа (см. README ниже).
    recon: false,
  };

  // Ключ DeepSeek и OpenAI выглядит как sk-… Ловим достаточно длинные совпадения,
  // чтобы не принять за ключ случайную строку из вёрстки.
  const KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/;

  let lastSent = null; // защита от повторной отправки того же ключа
  let busy = false;

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
    if (CONFIG.recon) console.log('[recon fetch]', (args[1] && args[1].method) || 'GET', url);
    return origFetch.apply(this, args).then((res) => {
      // Клон, чтобы не «съесть» тело у самой страницы.
      res.clone().text().then((t) => scan(t, url)).catch(() => {});
      return res;
    });
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
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
    ui(CONFIG.secret === 'ЗАМЕНИ_НА_СВОЙ_СЕКРЕТ'
      ? '⚠️ Впиши секрет в CONFIG.secret'
      : 'Слежу за новым ключом…', CONFIG.secret === 'ЗАМЕНИ_НА_СВОЙ_СЕКРЕТ' ? '#a50e0e' : '#333');
  });

  console.log('[key-rotator] активен, recon =', CONFIG.recon);
})();
