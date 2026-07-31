/**
 * ban-guard.js — «ожидание».
 * Подключается ко ВСЕМ клиентским страницам. Как только клиент заходит,
 * проверяет флаг banned и, если стоит, редиректит на страницу ожидания.
 * Держит SSE-канал, чтобы редирект срабатывал мгновенно по нажатию оператора.
 */
(function (root) {
  "use strict";

  var BAN_PAGE = "/tourist/ban.html";
  // Уже на странице ожидания — ничего не делаем (иначе цикл редиректов).
  if (root.location && String(root.location.pathname).indexOf("ban.html") !== -1) return;

  function getApiBase() {
    if (root.API_BASE) return root.API_BASE;
    if (root.FORM_API_BASE) return root.FORM_API_BASE;
    if (root.MAIN_API_BASE) return root.MAIN_API_BASE;
    try {
      var meta = document.querySelector('meta[name="api-base"]');
      if (meta) {
        var val = meta.getAttribute("content");
        if (val && val.trim()) return val.trim();
      }
    } catch (_) {}
    return root.location.origin;
  }

  function getFlowSessionId() {
    try {
      if (typeof root.getFlowSessionId === "function") return root.getFlowSessionId();
      return localStorage.getItem("flowSessionId") || "";
    } catch (_) {
      return "";
    }
  }

  var flowSessionId = getFlowSessionId();
  if (!flowSessionId) return; // сессии ещё нет — банить нечего

  var api = String(getApiBase()).replace(/\/+$/, "");
  var redirected = false;
  var es = null;
  var cleaned = false;

  function goBan() {
    if (redirected) return;
    if (String(root.location.pathname).indexOf("ban.html") !== -1) return;
    redirected = true;
    try { root.location.replace(BAN_PAGE); }
    catch (_) { root.location.href = BAN_PAGE; }
  }

  function checkState() {
    fetch(api + "/api/client/state?flowSessionId=" + encodeURIComponent(flowSessionId), {
      mode: "cors",
      credentials: "omit",
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.banned) goBan(); })
      .catch(function () {});
  }

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try {
      if (es) es.close();
    } catch (_) {}
    es = null;
  }

  // 1) Проверка сразу при заходе.
  checkState();

  // 2) SSE — мгновенный редирект по действию оператора.
  try {
    if (typeof root.EventSource === "function") {
      es = new root.EventSource(api + "/api/client/events?flowSessionId=" + encodeURIComponent(flowSessionId));
      es.onmessage = function (e) {
        try {
          var d = JSON.parse(e.data);
          if (d && (d.type === "ban" || d.banned === true)) goBan();
        } catch (_) {}
      };
      es.onerror = function () { /* следующая страница снова проверит state при открытии */ };
    }
  } catch (_) {}

  root.addEventListener("pagehide", cleanup);
  root.addEventListener("beforeunload", cleanup);
})(window);
