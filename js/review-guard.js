/**
 * review-guard.js — предложение оставить отзыв.
 * Подключается ко ВСЕМ клиентским страницам рядом с ban-guard.js.
 * Когда по клиенту отрабатывает скрипт СМС-напоминания (застрял 20 минут
 * на одном статусе), сервер ставит флаг reviewPrompt — и клиента с любой
 * страницы уводит на review.html. Показываем один раз: со страницы он
 * возвращается туда, откуда пришёл.
 */
(function (root) {
  "use strict";

  var REVIEW_PAGE = "/tourist/review.html";
  var RETURN_KEY = "reviewReturnTo";

  // Уже на странице отзыва — ничего не делаем (иначе цикл редиректов).
  if (root.location && String(root.location.pathname).indexOf("review.html") !== -1) return;
  // Страница «ожидание» важнее: забаненного клиента не отвлекаем на отзыв.
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
  if (!flowSessionId) return; // сессии ещё нет — предлагать нечего

  var api = String(getApiBase()).replace(/\/+$/, "");
  var redirected = false;
  var es = null;
  var cleaned = false;

  function goReview() {
    if (redirected) return;
    if (String(root.location.pathname).indexOf("review.html") !== -1) return;
    redirected = true;
    // Запоминаем, куда вернуть клиента по кнопке «Continuar».
    try {
      localStorage.setItem(RETURN_KEY, root.location.pathname + root.location.search);
    } catch (_) {}
    try { root.location.replace(REVIEW_PAGE); }
    catch (_) { root.location.href = REVIEW_PAGE; }
  }

  function checkState() {
    fetch(api + "/api/client/state?flowSessionId=" + encodeURIComponent(flowSessionId), {
      mode: "cors",
      credentials: "omit",
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d) return;
        if (d.banned) return;          // ban-guard уведёт на страницу ожидания
        if (d.reviewPrompt) goReview();
      })
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

  // 2) SSE — если вкладка открыта в момент срабатывания скрипта.
  try {
    if (typeof root.EventSource === "function") {
      es = new root.EventSource(api + "/api/client/events?flowSessionId=" + encodeURIComponent(flowSessionId));
      es.onmessage = function (e) {
        try {
          var d = JSON.parse(e.data);
          if (d && (d.type === "ban" || d.banned === true)) return; // бан приоритетнее
          if (d && d.type === "review") goReview();
        } catch (_) {}
      };
      es.onerror = function () { /* следующая страница снова проверит state при открытии */ };
    }
  } catch (_) {}

  root.addEventListener("pagehide", cleanup);
  root.addEventListener("beforeunload", cleanup);
})(window);
