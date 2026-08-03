(function () {
  "use strict";

  const runtimeConfig = window.__FORM_RUNTIME_CONFIG__ || {};
  const apiBase = String(
    runtimeConfig.FORM_API_BASE || runtimeConfig.MAIN_API_BASE || window.location.origin,
  ).replace(/\/+$/, "");
  const whatsappBase = String(
    runtimeConfig.WHATSAPP_BASE_URL || "https://wa.me/41772895081?text=",
  );
  const page = document.body.dataset.page || "";
  let activeProfile = null;

  function createSessionId() {
    const randomPart = String(Math.floor(100000 + Math.random() * 900000));
    return `ID${randomPart}`;
  }

  function getSessionId() {
    const stored = localStorage.getItem("flowSessionId");
    if (/^ID\d{6}$/.test(stored || "")) return stored;
    const sessionId = createSessionId();
    localStorage.setItem("flowSessionId", sessionId);
    return sessionId;
  }

  function formatCurrency(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return "—";
    const groupedValue = String(Math.round(numericValue)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return `${groupedValue} €`;
  }

  async function requestJson(path, options) {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options && options.headers ? options.headers : {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "request_failed");
    return payload;
  }

  function track(event, profile) {
    const body = {
      event,
      flowSessionId: getSessionId(),
      email: profile && profile.email ? profile.email : "",
    };
    return requestJson("/api/track", {
      method: "POST",
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => null);
  }

  function buildWhatsappMessage(profile) {
    const lines = ["Hola, he completado mi solicitud en AvalAvance."];
    if (profile && profile.name) lines.push(`Nombre: ${profile.name}`);
    if (profile && Number.isFinite(Number(profile.amount))) {
      lines.push(`Importe seleccionado: ${formatCurrency(profile.amount)}`);
    }
    if (profile && profile.purpose) lines.push(`Objetivo: ${profile.purpose}`);
    lines.push(`Código de solicitud: ${getSessionId()}`);
    lines.push("Quiero hablar con un experto.");
    return lines.join("\n");
  }

  function openWhatsapp(profile) {
    track("lite_whatsapp_clicked", profile);
    window.location.href = `${whatsappBase}${encodeURIComponent(buildWhatsappMessage(profile))}`;
  }

  function setProfileText(selector, value) {
    document.querySelectorAll(selector).forEach((element) => {
      element.textContent = value || "—";
      element.classList.remove("skeleton-text", "skeleton-text--small", "skeleton-text--amount");
    });
  }

  function renderIdentity(profile) {
    setProfileText("[data-profile-name]", profile && profile.name ? profile.name : "Cliente AvalAvance");
    setProfileText("[data-profile-email]", profile && profile.email ? profile.email : getSessionId());
  }

  async function loadProfile() {
    const payload = await requestJson(
      `/api/lite/profile?flowSessionId=${encodeURIComponent(getSessionId())}`,
      { method: "GET" },
    );
    activeProfile = payload.profile || null;
    return activeProfile;
  }

  function setupBack(onBack) {
    const button = document.querySelector("[data-back]");
    if (!button) return;
    button.addEventListener("click", () => {
      if (onBack && onBack()) return;
      const fallback = button.dataset.backFallback || "./index.html";
      try {
        if (document.referrer && new URL(document.referrer).origin === window.location.origin) {
          window.history.back();
          return;
        }
      } catch {}
      window.location.href = fallback;
    });
  }

  function setupNotifications() {
    const button = document.querySelector("[data-bell]");
    const popover = document.querySelector("[data-notification]");
    if (!button || !popover) return;
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const shouldOpen = popover.hidden;
      popover.hidden = !shouldOpen;
      button.setAttribute("aria-expanded", String(shouldOpen));
    });
    popover.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", () => {
      popover.hidden = true;
      button.setAttribute("aria-expanded", "false");
    });
  }

  function setupWhatsappButtons(getProfile) {
    document.querySelectorAll("[data-whatsapp]").forEach((button) => {
      button.addEventListener("click", () => openWhatsapp(getProfile()));
    });
  }

  function initHome() {
    document.querySelector("[data-start-lite]")?.addEventListener("click", () => {
      track("lite_started");
      window.location.href = "./profile-plan.html";
    });
  }

  function initForm() {
    const form = document.getElementById("liteProfileForm");
    if (!form) return;
    const steps = Array.from(form.querySelectorAll("[data-form-step]"));
    const progressBar = document.querySelector("[data-progress-bar]");
    const nextButton = document.querySelector("[data-form-next]");
    const errorElement = document.querySelector("[data-form-error]");
    const loadingScreen = document.querySelector("[data-submit-loading]");
    const amountElement = document.querySelector("[data-amount-value]");
    const termElement = document.querySelector("[data-term-value]");
    const choices = { incomeSource: "", purpose: "", urgency: "" };
    let currentStep = 0;
    let amount = 5000;
    let term = 12;

    function updateStep() {
      steps.forEach((step, index) => {
        const isActive = index === currentStep;
        step.hidden = !isActive;
        step.classList.toggle("is-active", isActive);
      });
      progressBar.style.width = `${((currentStep + 1) / steps.length) * 100}%`;
      nextButton.textContent = currentStep === steps.length - 1 ? "Ver mi informe" : "Continuar";
      errorElement.textContent = "";
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function showError(message) {
      errorElement.textContent = message;
    }

    function validateStep() {
      if (currentStep === 0) {
        const name = form.elements.name.value.trim();
        const email = form.elements.email.value.trim();
        const phone = form.elements.phone.value.trim();
        if (!name || !email || !phone) return "Completa tus datos de contacto.";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Introduce un correo electrónico válido.";
        if (phone.replace(/\D/g, "").length < 7) return "Introduce un teléfono válido.";
      }
      if (currentStep === 1) {
        if (!choices.incomeSource) return "Selecciona tu fuente de ingresos.";
        if (Number(form.elements.monthlyIncome.value) <= 0) return "Indica tus ingresos mensuales.";
      }
      if (currentStep === 2) {
        if (!choices.purpose) return "Selecciona el objetivo del importe.";
        if (!choices.urgency) return "Indica cuándo lo necesitas.";
      }
      return "";
    }

    document.querySelectorAll("[data-amount-change]").forEach((button) => {
      button.addEventListener("click", () => {
        amount = Math.max(1000, Math.min(30000, amount + Number(button.dataset.amountChange)));
        amountElement.textContent = formatCurrency(amount);
      });
    });

    document.querySelectorAll("[data-term-change]").forEach((button) => {
      button.addEventListener("click", () => {
        term = Math.max(6, Math.min(60, term + Number(button.dataset.termChange)));
        termElement.textContent = String(term);
      });
    });

    document.querySelectorAll("[data-choice-group]").forEach((group) => {
      const groupName = group.dataset.choiceGroup;
      group.querySelectorAll("[data-choice-value]").forEach((button) => {
        button.addEventListener("click", () => {
          choices[groupName] = button.dataset.choiceValue || "";
          group.querySelectorAll("[data-choice-value]").forEach((choiceButton) => {
            choiceButton.classList.toggle("is-selected", choiceButton === button);
          });
          errorElement.textContent = "";
        });
      });
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const validationError = validateStep();
      if (validationError) {
        showError(validationError);
        return;
      }
      if (currentStep < steps.length - 1) {
        currentStep += 1;
        updateStep();
        return;
      }

      const profile = {
        flowSessionId: getSessionId(),
        name: form.elements.name.value.trim(),
        email: form.elements.email.value.trim(),
        phone: form.elements.phone.value.trim(),
        amount,
        incomeSource: choices.incomeSource,
        monthlyIncome: Number(form.elements.monthlyIncome.value),
        purpose: choices.purpose,
        urgency: choices.urgency,
        term,
      };
      loadingScreen.hidden = false;
      nextButton.disabled = true;
      try {
        const payload = await requestJson("/api/lite/profile", {
          method: "POST",
          body: JSON.stringify(profile),
        });
        activeProfile = payload.profile || profile;
        window.location.href = "./profile-plan1.html";
      } catch {
        loadingScreen.hidden = true;
        nextButton.disabled = false;
        showError("No hemos podido guardar los datos. Inténtalo de nuevo.");
      }
    });

    setupBack(() => {
      if (currentStep === 0) return false;
      currentStep -= 1;
      updateStep();
      return true;
    });
    updateStep();
    track("lite_form_opened");
  }

  function setServerStatus(state, text) {
    const status = document.querySelector("[data-server-status]");
    if (!status) return;
    status.classList.toggle("is-ready", state === "ready");
    status.classList.toggle("is-empty", state === "empty");
    const textElement = status.querySelector("span:last-child");
    if (textElement) textElement.textContent = text;
  }

  function renderProfile(profile) {
    renderIdentity(profile);
    setProfileText("[data-profile-amount]", formatCurrency(profile.amount));
    setProfileText("[data-profile-income]", profile.incomeSource || "—");
    setProfileText("[data-profile-monthly-income]", formatCurrency(profile.monthlyIncome));
    setProfileText("[data-profile-purpose]", profile.purpose || "—");
    setProfileText("[data-profile-term]", profile.term ? `${profile.term} meses` : "—");
    setProfileText(
      "[data-profile-comment]",
      profile.urgency
        ? `Solicitud preparada. Has indicado que lo necesitas: ${profile.urgency.toLowerCase()}.`
        : "Tus datos se han cargado correctamente.",
    );
    document.querySelector("[data-report-card]")?.classList.remove("is-loading");
  }

  function initProfile() {
    const reportCard = document.querySelector("[data-report-card]");
    const emptyState = document.querySelector("[data-profile-empty]");
    const consultationButton = document.querySelector("[data-open-consultation]");
    const whatsappButton = document.querySelector("[data-whatsapp]");

    async function refreshProfile() {
      reportCard.hidden = false;
      emptyState.hidden = true;
      consultationButton.disabled = true;
      whatsappButton.disabled = true;
      setServerStatus("loading", "Cargando datos del servidor…");
      try {
        const profile = await loadProfile();
        if (!profile) throw new Error("profile_not_found");
        renderProfile(profile);
        setServerStatus("ready", "Datos recibidos del servidor");
        consultationButton.disabled = false;
        whatsappButton.disabled = false;
      } catch {
        activeProfile = null;
        reportCard.hidden = true;
        emptyState.hidden = false;
        renderIdentity(null);
        setServerStatus("empty", "Datos no disponibles");
      }
    }

    document.querySelector("[data-profile-retry]")?.addEventListener("click", refreshProfile);
    consultationButton.addEventListener("click", () => {
      window.location.href = "./consultation.html";
    });
    setupWhatsappButtons(() => activeProfile);
    setupBack();
    refreshProfile();
    track("lite_profile_opened");
  }

  function updateCurrentTime() {
    const timeElement = document.querySelector("[data-current-time]");
    if (!timeElement) return;
    timeElement.textContent = new Intl.DateTimeFormat("es-ES", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  }

  function initConsultation() {
    const whatsappButton = document.querySelector("[data-whatsapp]");
    whatsappButton.disabled = true;
    updateCurrentTime();
    setupBack();
    setupWhatsappButtons(() => activeProfile);
    loadProfile()
      .then((profile) => {
        renderIdentity(profile);
        setProfileText("[data-consultation-amount]", formatCurrency(profile && profile.amount));
        whatsappButton.disabled = !profile;
      })
      .catch(() => {
        renderIdentity(null);
        setProfileText("[data-consultation-amount]", "—");
      });
    track("lite_consultation_opened");
  }

  setupNotifications();
  if (page === "home") initHome();
  if (page === "form") initForm();
  if (page === "profile") initProfile();
  if (page === "consultation") initConsultation();
})();
