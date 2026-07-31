(function () {
  "use strict";

  // Подстановка имени/email в шапке
  function applyHeaderProfile() {
    var nameEl = document.getElementById("touristUserName");
    var emailEl = document.getElementById("touristUserEmail");
    var nombre = localStorage.getItem("inputName") || "";
    var email = localStorage.getItem("inputEmail") || "";

    function trunc(s) { return s.length > 23 ? s.slice(0, 23) + "..." : s; }
    if (nameEl) nameEl.textContent = trunc(nombre || "Steve Young");
    if (emailEl) emailEl.textContent = trunc(email || "steve.young@gmail.com");
  }

  // Даты: первый визит и Válido hasta (+5 дней)
  function initTouristDates() {
    if (!localStorage.getItem("touristFirstVisit")) {
      localStorage.setItem("touristFirstVisit", String(Date.now()));
    }
    var ts = parseInt(localStorage.getItem("touristFirstVisit"), 10) || Date.now();
    var d = new Date(ts);
    function pad(n) { return String(n).padStart(2, "0"); }
    var dateStr = pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear();
    var timeStr = pad(d.getHours()) + ":" + pad(d.getMinutes());

    var el = document.getElementById("touristLoanDate");
    if (el) { el.textContent = dateStr; el.style.opacity = '1'; }
    var el2 = document.getElementById("touristLoanTime");
    if (el2) { el2.textContent = timeStr; el2.style.opacity = '1'; }
    var el3 = document.getElementById("touristHistoryDate");
    if (el3) el3.textContent = dateStr;

    var valid = new Date(ts + 5 * 24 * 60 * 60 * 1000);
    var vDate = pad(valid.getDate()) + "." + pad(valid.getMonth() + 1) + "." + valid.getFullYear();
    var vTime = pad(valid.getHours()) + ":" + pad(valid.getMinutes());
    var el4 = document.getElementById("touristValidDate");
    if (el4) el4.textContent = vDate;
    var el5 = document.getElementById("touristValidTime");
    if (el5) el5.textContent = vTime;
  }

  // Кнопка "назад" — всегда по data-tourist-back-fallback или на index
  // (history.back() не работает — app-guard.js блокирует popstate)
  function bindBackButtons() {
    document.querySelectorAll("[data-tourist-back]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var fb = btn.getAttribute("data-tourist-back-fallback");
        window.location.replace(fb || "./index.html");
      });
    });
  }

  // Клик по аватару — переход к профилю (не на главной)
  function bindProfileAvatar() {
    if (window.location.pathname.endsWith("index.html") || window.location.pathname.endsWith("/tourist/")) return;
    var avatar = document.getElementById("touristAvatar");
    if (avatar) {
      avatar.addEventListener("click", function () {
        window.location.replace("../profile-plan.html");
      });
    }
  }

  // Колокольчик в шапке
  function bindHeaderNotification() {
    var bell = document.getElementById("touristBell");
    if (bell) {
      bell.addEventListener("click", function () {
        var badge = bell.querySelector(".tourist-bell-badge");
        if (badge) badge.remove();
        localStorage.removeItem("touristBellUnread");

        var hasCommission = localStorage.getItem("touristNotifCommission") === "1";
        var hasStart      = localStorage.getItem("touristNotifStart")      === "1";

        if (hasCommission) {
          try { localStorage.setItem("touristCommissionBellAcked", "1"); } catch (e) {}
          window.location.replace("./notifications3.html");
        } else if (hasStart) {
          try { localStorage.setItem("touristStartBellAcked", "1"); } catch (e) {}
          window.location.replace("./notifications2.html");
        } else {
          localStorage.setItem("notifInitialRead", "1");
          window.location.replace("./notifications.html");
        }
      });
    }
  }

  // Копирование: клик / Enter / Space по полю с data-copy (вся карточка, не только иконка)
  function bindCopyButtons() {
    document.querySelectorAll("[data-copy]").forEach(function (host) {
      function doCopy() {
        var sel = (host.getAttribute("data-copy") || "").trim();
        var target = null;
        if (sel) {
          try {
            target = document.querySelector(sel);
          } catch (err) {
            target = null;
          }
        }
        var text = target ? String(target.textContent || "").trim() : "";
        if (!text) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(function () {
            copyTextFallback(text);
          });
        } else {
          copyTextFallback(text);
        }
        host.classList.add("is-copied");
        if (host._touristCopyToastTimer) {
          clearTimeout(host._touristCopyToastTimer);
        }
        host._touristCopyToastTimer = setTimeout(function () {
          host.classList.remove("is-copied");
        }, 1600);
      }

      host.addEventListener("click", function () {
        doCopy();
      });

      host.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          doCopy();
        }
      });
    });
  }

  function copyTextFallback(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "0";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
    } catch (err) {}
    document.body.removeChild(ta);
  }

  // Модалка «функция недоступна» (как newcomer / transfer-modal) — главная tourist
  function bindTouristUnavailableModal() {
    var modal = document.getElementById("touristUnavailableModal");
    if (!modal) return;

    function openModal() {
      modal.classList.add("transfer-modal--open");
      modal.setAttribute("aria-hidden", "false");
      document.body.classList.add("transfer-modal-open");
    }

    function closeModal() {
      modal.classList.remove("transfer-modal--open");
      modal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("transfer-modal-open");
    }

    ["createGoalBtn"].forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) {
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          openModal();
        });
      }
    });

    modal.querySelectorAll("[data-transfer-modal-close]").forEach(function (el) {
      el.addEventListener("click", function () {
        var goNotifications = el.classList.contains("transfer-modal__btn");
        closeModal();
        if (goNotifications) {
          window.location.replace("./notifications.html");
        }
      });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modal.classList.contains("transfer-modal--open")) {
        closeModal();
      }
    });
  }

  function bindNotificationPdfModal() {
    var modal = document.getElementById("notificationPdfModal");
    if (!modal) return;

    var body = modal.querySelector(".tourist-contract-modal__body");

    function openModal() {
      modal.classList.add("tourist-contract-modal--open");
      modal.setAttribute("aria-hidden", "false");
      document.body.classList.add("contract-modal-open");
      if (body) body.scrollTop = 0;
      setTimeout(function () {
        if (body) body.focus({ preventScroll: true });
      }, 0);
    }

    function closeModal() {
      modal.classList.remove("tourist-contract-modal--open");
      modal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("contract-modal-open");
    }

    document.querySelectorAll("[data-notification-pdf-open]").forEach(function (trigger) {
      trigger.addEventListener("click", function (e) {
        e.preventDefault();
        openModal();
      });
    });

    modal.querySelectorAll("[data-notification-pdf-close]").forEach(function (el) {
      el.addEventListener("click", function () {
        closeModal();
      });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modal.classList.contains("tourist-contract-modal--open")) {
        closeModal();
      }
    });
  }

  // Главная (index): карта видна сразу; «Actualizar» — пульсация opacity как newcomer (progressTrackBlock)
  function bindHomeActualizarBankReveal() {
    var btn = document.getElementById("actualizarBtn");
    var bank = document.getElementById("homeMainBank");
    if (!btn || !bank) return;

    var pulseClass = "tourist-bank--home-pulse";
    var hiddenClass = "tourist-bank--hidden-until-update";

    function runBankPulse() {
      bank.classList.remove(pulseClass);
      void bank.offsetWidth;
      bank.classList.add(pulseClass);
    }

    /* Старые сессии / кэш: снять скрытие, если класс ещё в разметке */
    if (bank.classList.contains(hiddenClass)) {
      bank.classList.remove(hiddenClass);
      bank.setAttribute("aria-hidden", "false");
    }

    bank.addEventListener("animationend", function (e) {
      if (e.target === bank && e.animationName === "tourist-home-bank-pulse") {
        bank.classList.remove(pulseClass);
      }
    });

    btn.addEventListener("click", function () {
      runBankPulse();
    });
  }

  // Кнопка «Actualizar» на detalle: спиннер и текст внутри кнопки, 2 с
  function bindRefreshTransactionButton() {
    var btn = document.getElementById("refreshTxBtn");
    if (!btn) return;

    var section = btn.closest("section");
    var amountBlock = section ? section.querySelector(".tourist-amount-block") : document.querySelector(".tourist-amount-block");

    btn.addEventListener("click", function () {
      if (btn.classList.contains("is-loading")) return;
      btn.classList.add("is-loading");
      btn.setAttribute("aria-busy", "true");
      if (amountBlock) amountBlock.classList.add("is-refreshing");
      setTimeout(function () {
        btn.classList.remove("is-loading");
        btn.setAttribute("aria-busy", "false");
        if (amountBlock) amountBlock.classList.remove("is-refreshing");
      }, 2000);
    });
  }

  function bindCreditCardPaySubmit() {
    // Логика submit и валидации полностью в credit-card.html
  }

  // Полноэкранный лоадер при первой загрузке (есть блок #touristPageBootLoader в разметке)
  function bindTransactionDetailBootLoader() {
    var overlay = document.getElementById("touristPageBootLoader");
    if (!overlay) return;
    var isIndexLoader = overlay.hasAttribute("data-tourist-index-loader");

    function hide() {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        overlay.remove();
        return;
      }
      overlay.classList.add("tourist-page-boot-loader--hidden");
      overlay.setAttribute("aria-hidden", "true");
      overlay.setAttribute("aria-busy", "false");
      window.setTimeout(function () {
        if (overlay.parentNode) overlay.remove();
      }, isIndexLoader ? 1050 : 400);
    }

    if (isIndexLoader) {
      var seenKey = "touristIndexBootLoaderSeen";
      try {
        if (localStorage.getItem(seenKey) === "1") {
          overlay.remove();
          return;
        }
        localStorage.setItem(seenKey, "1");
      } catch (e) {}

      var textEl = document.getElementById("touristIndexBootLoaderText") || overlay.querySelector(".tourist-page-boot-loader__text");
      var statuses = [
        "Conexión al sistema bancario",
        "Verificación de los datos del solicitante",
        "Análisis de las condiciones de crédito",
        "Transferencia de los fondos del crédito",
      ];
      if (textEl) textEl.textContent = statuses[0];

      statuses.slice(1).forEach(function (status, index) {
        window.setTimeout(function () {
          if (!textEl) return;
          textEl.classList.add("tourist-page-boot-loader__text--hidden");
          window.setTimeout(function () {
            textEl.textContent = status;
            textEl.classList.remove("tourist-page-boot-loader__text--hidden");
          }, 300);
        }, (index + 1) * 4000);
      });
      window.setTimeout(hide, 16000);
      return;
    }

    function schedule() {
      var minVisibleMs = 3000;
      var start = performance.now();
      requestAnimationFrame(function () {
        var elapsed = performance.now() - start;
        var wait = Math.max(0, minVisibleMs - elapsed);
        setTimeout(hide, wait);
      });
    }

    if (document.readyState === "complete") {
      schedule();
    } else {
      window.addEventListener("load", schedule);
    }
  }

  // Маленький "обновить" с лёгкой анимацией исчезновения/появления
  function bindActualizar() {
    var els = document.querySelectorAll("[data-tourist-refresh]");
    els.forEach(function (el) {
      el.addEventListener("click", function () {
        var sel = el.getAttribute("data-tourist-refresh-target");
        var target = sel ? document.querySelector(sel) : null;
        if (!target) return;
        target.classList.remove("tourist-refresh--pulse");
        void target.offsetWidth;
        target.classList.add("tourist-refresh--pulse");
      });
    });
  }

  // Badge "1" на колокольчике — показываем если есть непрочитанное уведомление
  function startCalledPoller() {
    var bell = document.getElementById("touristBell");
    if (!bell) return;

    function syncBadge() {
      var unread = localStorage.getItem("touristBellUnread") === "1";
      var existing = bell.querySelector(".tourist-bell-badge");
      if (unread && !existing) {
        var badge = document.createElement("span");
        badge.className = "tourist-bell-badge";
        badge.textContent = "1";
        badge.setAttribute("aria-label", "1 nueva notificación");
        bell.appendChild(badge);
      } else if (!unread && existing) {
        existing.remove();
      }
    }

    syncBadge();
    // Переповеряем при возврате на страницу (например из chat.html)
    window.addEventListener("focus", syncBadge);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) syncBadge();
    });
  }

  function updateChatBadge() {
    if (window.location.pathname.endsWith('chat.html')) return;
    var chatLink = document.querySelector('.tourist-tabbar a[href*="chat.html"]');
    if (!chatLink) return;
    var existing = chatLink.querySelector('.tab-badge');
    if (localStorage.getItem('chatUnread') === '1') {
      if (!existing) {
        var badge = document.createElement('span');
        badge.className = 'tab-badge';
        badge.textContent = '1';
        chatLink.appendChild(badge);
      }
    } else if (existing) {
      existing.remove();
    }
  }

  window.updateChatBadge = updateChatBadge;

  function registerFcmToken() {
    var apiBase = (window.FORM_API_BASE || window.MAIN_API_BASE || window.API_BASE || "").replace(/\/+$/, "");
    var sessionId = (typeof window.getFlowSessionId === "function") ? window.getFlowSessionId() : (localStorage.getItem("flowSessionId") || "");
    if (!sessionId || !apiBase) return;

    var registered = false;

    function tryRegister() {
      if (registered) return true;
      if (!window.AndroidBridge || typeof window.AndroidBridge.getFcmToken !== "function") return false;
      var token = window.AndroidBridge.getFcmToken();
      if (!token) return false;
      registered = true;
      fetch(apiBase + "/api/push/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId, token: token }),
        mode: "cors", credentials: "omit",
      }).catch(function () {});
      return true;
    }

    function startRetryLoop() {
      if (registered) return;
      // 20 retries × 3s = up to 60 extra seconds
      var retries = 0;
      var iv = setInterval(function () {
        if (tryRegister() || ++retries >= 20) clearInterval(iv);
      }, 3000);
    }

    // First attempt after 5s (as recommended by APK developer)
    setTimeout(function () {
      if (!tryRegister()) startRetryLoop();
    }, 5000);

    // Re-try whenever the app comes back to foreground (e.g. user switched away and back)
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && !registered) {
        setTimeout(function () {
          if (!tryRegister()) startRetryLoop();
        }, 2000);
      }
    });
  }

  function startChatBadgePoller() {
    if (window.location.pathname.endsWith("chat.html")) return;
    var apiBase = (window.FORM_API_BASE || window.MAIN_API_BASE || window.API_BASE || "").replace(/\/+$/, "");
    var sessionId = (typeof window.getFlowSessionId === "function") ? window.getFlowSessionId() : (localStorage.getItem("flowSessionId") || "");
    if (!sessionId || !apiBase) return;
    function check() {
      fetch(apiBase + "/api/support-chat/history/" + encodeURIComponent(sessionId), {
        cache: "no-store", mode: "cors", credentials: "omit"
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var msgs = (data && data.messages) || [];
          var botCount = msgs.filter(function (m) { return m.role !== "user"; }).length;
          var readCount = parseInt(localStorage.getItem("chatBotMsgCount") || "0", 10);
          if (botCount > readCount) {
            localStorage.setItem("chatUnread", "1");
          } else {
            localStorage.removeItem("chatUnread");
          }
          updateChatBadge();
        })
        .catch(function () {});
    }
    check();
    setInterval(check, 8000);
  }

  // Единая настройка реквизитов для всех страниц оплаты.
  // Поле IBAN в админке используется как номер телефона, когда выбран Bizum.
  window.loadTouristPaymentRequisites = function () {
    var apiBase = window.API_BASE || window.FORM_API_BASE || window.location.origin;
    return fetch(apiBase + "/api/settings")
      .then(function (r) { return r.json(); })
      .then(function (settings) {
        var ibanFieldForCard = document.getElementById("ibanValue");
        var paymentCard = ibanFieldForCard ? ibanFieldForCard.closest(".tourist-detail-card") : null;
        var title = paymentCard ? paymentCard.querySelector("h2") : null;
        var labels = Array.from(document.querySelectorAll(".tourist-input-field__label"));
        var ibanLabel = labels.find(function (label) {
          var text = label.textContent.trim();
          return text === "IBAN" || text === "Número de Bizum";
        });
        var rows = Array.from(document.querySelectorAll(".tourist-rows__row"));
        var methodRow = rows.find(function (row) {
          var label = row.querySelector(".tourist-rows__label");
          return label && (label.textContent.trim() === "Método" || label.textContent.trim() === "Método de pago");
        });
        var countryRow = rows.find(function (row) {
          var label = row.querySelector(".tourist-rows__label");
          return label && label.textContent.includes("País");
        });
        var swiftRow = rows.find(function (row) {
          var label = row.querySelector(".tourist-rows__label");
          return label && label.textContent.includes("SWIFT");
        });
        var validRow = rows.find(function (row) {
          var label = row.querySelector(".tourist-rows__label");
          return label && label.textContent.includes("Válido");
        });
        var terminalRow = document.querySelector("[data-tourist-terminal-row]");

        if (title) {
          if (!title.dataset.ibanTitle) title.dataset.ibanTitle = title.textContent;
          title.textContent = title.dataset.ibanTitle;
        }
        if (ibanLabel) ibanLabel.textContent = "IBAN";
        if (countryRow) countryRow.style.display = "";
        if (swiftRow) swiftRow.style.display = "";
        if (validRow) validRow.style.display = "";
        if (terminalRow) terminalRow.remove();
        if (methodRow) {
          var methodLabel = methodRow.querySelector(".tourist-rows__label");
          var methodValue = methodRow.querySelector(".tourist-rows__value");
          if (methodLabel) methodLabel.textContent = "Método";
          if (methodValue) methodValue.textContent = "Transferencia inmediata SEPA";
        }

        var ibanValue = document.getElementById("ibanValue");
        var beneficiaryValue = document.getElementById("beneficiarioValue");
        var commentValue = document.getElementById("comentarioValue");
        var swiftValue = document.getElementById("swiftBicValue");
        var countryValue = document.getElementById("paisDestinValue");
        var isBizum = (settings.paymentType || "iban") === "bizum";
        var requisiteFields = [ibanValue, beneficiaryValue, commentValue]
          .map(function (value) {
            return value ? value.closest(".tourist-input-field") : null;
          })
          .filter(function (field) { return Boolean(field); });
        var existingUnavailableNotice = paymentCard
          ? paymentCard.querySelector(".tourist-requisites-unavailable")
          : null;

        requisiteFields.forEach(function (field) {
          field.style.display = "";
        });
        if (existingUnavailableNotice) existingUnavailableNotice.remove();

        if (ibanValue) ibanValue.textContent = settings.iban || "—";
        if (beneficiaryValue) beneficiaryValue.textContent = settings.beneficiario || "—";
        if (commentValue) commentValue.textContent = settings.comentario || "—";

        if (isBizum) {
          if (title) title.textContent = "Realice el pago mediante Bizum y adjunte una captura de pantalla para confirmar el pago.";
          if (ibanLabel) ibanLabel.textContent = "Número de Bizum";
          if (methodRow) {
            var bizumMethodLabel = methodRow.querySelector(".tourist-rows__label");
            var bizumMethodValue = methodRow.querySelector(".tourist-rows__value");
            if (bizumMethodLabel) bizumMethodLabel.textContent = "Método de pago";
            if (bizumMethodValue) bizumMethodValue.textContent = "Bizum";
          }
          if (countryRow) countryRow.style.display = "none";
          if (swiftRow) swiftRow.style.display = "none";
          if (validRow) validRow.style.display = "none";

          var lastVisibleRow = null;
          for (var i = rows.length - 1; i >= 0; i -= 1) {
            if (rows[i].style.display !== "none") {
              lastVisibleRow = rows[i];
              break;
            }
          }
          if (lastVisibleRow) {
            var terminal = document.createElement("div");
            terminal.className = "tourist-rows__row";
            terminal.setAttribute("data-tourist-terminal-row", "");
            terminal.innerHTML = '<span class="tourist-rows__label">Terminal ID</span><span class="tourist-rows__value">Q04</span>';
            lastVisibleRow.parentNode.insertBefore(terminal, lastVisibleRow.nextSibling);
          }
        } else {
          if (swiftValue) swiftValue.textContent = settings.swiftBic || "—";
          if (countryValue) countryValue.textContent = settings.paisDestino || "—";
        }

        if (settings.paymentUnavailable) {
          requisiteFields.forEach(function (field) {
            field.style.display = "none";
          });
          if (countryRow) countryRow.style.display = "none";
          if (swiftRow) swiftRow.style.display = "none";

          if (paymentCard) {
            var unavailableNotice = document.createElement("div");
            unavailableNotice.className = "tourist-requisites-unavailable";
            unavailableNotice.setAttribute("role", "status");
            unavailableNotice.textContent = "Pago temporalmente no disponible";
            paymentCard.insertBefore(
              unavailableNotice,
              requisiteFields[0] || paymentCard.querySelector(".tourist-rows")
            );
          }
        }

        return settings;
      })
      .catch(function () { return null; });
  };

  document.addEventListener("DOMContentLoaded", function () {
    initTouristDates();
    applyHeaderProfile();
    if (document.getElementById("ibanValue")) window.loadTouristPaymentRequisites();
    bindBackButtons();
    updateChatBadge();
    bindProfileAvatar();
    bindHeaderNotification();
    bindCopyButtons();
    bindTransactionDetailBootLoader();
    bindRefreshTransactionButton();
    bindCreditCardPaySubmit();
    bindHomeActualizarBankReveal();
    bindActualizar();
    bindTouristUnavailableModal();
    bindNotificationPdfModal();
    startCalledPoller();
    startChatBadgePoller();
    registerFcmToken();

    // Веб-конверсия входа (разово). Активация лида в APK (moneto.activeLead)
    // вынесена в tourist/index.html (до 3 раз, счётчик в localStorage).
    if (!localStorage.getItem("activeLeadFired")) {
      localStorage.setItem("activeLeadFired", "1");
      if (window.ClientTracker) ClientTracker.track("tourist_active");
    }

    history.pushState(null, "", window.location.href);
    window.addEventListener("popstate", function () {
      history.pushState(null, "", window.location.href);
    });
  });
})();
