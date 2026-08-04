(function () {
  "use strict";

  if (document.body.dataset.page !== "consultation") return;

  const runtimeConfig = window.__FORM_RUNTIME_CONFIG__ || {};
  const apiBase = String(
    runtimeConfig.FORM_API_BASE || runtimeConfig.MAIN_API_BASE || window.location.origin,
  ).replace(/\/+$/, "");
  const whatsappBase = String(
    runtimeConfig.WHATSAPP_BASE_URL || "https://api.whatsapp.com/send?phone=41772895081&text=Hola",
  );

  function getSessionId() {
    const stored = localStorage.getItem("flowSessionId");
    if (/^ID\d{6}$/.test(stored || "")) return stored;
    const sessionId = `ID${Math.floor(100000 + Math.random() * 900000)}`;
    localStorage.setItem("flowSessionId", sessionId);
    return sessionId;
  }

  function readAmount() {
    const rawValue = localStorage.getItem("currentAmount") || "";
    const numericValue = Number(rawValue.replace(/[^\d]/g, ""));
    return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
  }

  function formatCurrency(value) {
    if (!Number.isFinite(value)) return "—";
    return `${String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} €`;
  }

  function getProfile() {
    return {
      name: localStorage.getItem("inputName") || "Cliente AvalAvance",
      email: localStorage.getItem("inputEmail") || getSessionId(),
      amount: readAmount(),
    };
  }

  function track(event, profile) {
    fetch(`${apiBase}/api/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        flowSessionId: getSessionId(),
        email: profile.email || "",
      }),
      keepalive: true,
    }).catch(() => null);
  }

  function setupBack() {
    const button = document.querySelector("[data-back]");
    if (!button) return;
    button.addEventListener("click", () => {
      if (window.history.length > 1) {
        window.history.back();
        return;
      }
      window.location.href = button.dataset.backFallback || "/profile-plan1.html?lite=1";
    });
  }

  function setupNotifications() {
    const button = document.querySelector("[data-bell]");
    if (!button) return;
    button.addEventListener("click", openWhatsApp);
  }

  function setupTime() {
    const timeElement = document.querySelector("[data-current-time]");
    if (!timeElement) return;
    timeElement.textContent = new Intl.DateTimeFormat("es-ES", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  }

  const profile = getProfile();
  document.querySelector("[data-profile-name]").textContent = profile.name;
  document.querySelector("[data-profile-email]").textContent = profile.email;
  const consultationAmount = document.querySelector("[data-consultation-amount]");
  if (consultationAmount) consultationAmount.textContent = formatCurrency(profile.amount);
  document.querySelectorAll(".skeleton-text").forEach((element) => {
    element.classList.remove("skeleton-text", "skeleton-text--small");
  });

  function openWhatsApp() {
    const message = [
      "Hola, quiero hablar con un experto de AvalAvance.",
      `Nombre: ${profile.name}`,
      profile.amount ? `Importe seleccionado: ${formatCurrency(profile.amount)}` : "",
      `Código de solicitud: ${getSessionId()}`,
    ].filter(Boolean).join("\n");
    track("lite_consultation_whatsapp", profile);
    const whatsappUrl = new URL(whatsappBase, window.location.href);
    whatsappUrl.searchParams.set("text", message);
    window.location.href = whatsappUrl.toString();
  }

  document.querySelector("[data-whatsapp]")?.addEventListener("click", openWhatsApp);

  setupBack();
  setupNotifications();
  setupTime();
  track("lite_consultation_opened", profile);
})();
