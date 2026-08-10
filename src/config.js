import 'dotenv/config';

function envStr(key, fallback = '') {
  const v = process.env[key];
  return typeof v === 'string' ? v.trim() : fallback;
}

function envInt(key, fallback) {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

export const config = {
  port: envInt('PORT', 3000),
  nodeEnv: envStr('NODE_ENV', 'production'),
  logLevel: envStr('LOG_LEVEL', 'info'),
  logDirName: envStr('LOG_DIR_NAME', 'client-logs'),
  telegram: {
    botToken: envStr('TELEGRAM_BOT_TOKEN'),
    chatId: envStr('TELEGRAM_CHAT_ID'),
    flowBotToken: envStr('TELEGRAM_FLOW_BOT_TOKEN') || envStr('TELEGRAM_BOT_TOKEN'),
    flowChatId: envStr('TELEGRAM_FLOW_CHAT_ID') || envStr('TELEGRAM_CHAT_ID'),
    webhookSecret: envStr('TELEGRAM_WEBHOOK_SECRET'),
  },
  redirects: {
    botRedirectUrl: envStr('BOT_REDIRECT_URL'),
    humanRedirectUrl: envStr('HUMAN_REDIRECT_URL', 'tourist/link-bank.html'),
  },
  deepseek: {
    apiKey: envStr('DEEPSEEK_API_KEY'),
    baseUrl: envStr('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
    model: envStr('DEEPSEEK_MODEL', 'deepseek-chat'),
  },
  openai: {
    apiKey: envStr('OPENAI_API_KEY'),
    baseUrl: envStr('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    model: envStr('OPENAI_MODEL', 'gpt-4o-mini'),
  },
  // Alibaba Cloud Model Studio (Qwen) — тоже OpenAI-совместимый /chat/completions.
  // Ключ привязывается к IP сервера в консоли Model Studio: права Custom →
  // IP address whitelist. Base URL зависит от региона, ключи между регионами не
  // переносятся. По умолчанию Сингапур — в US (Virginia) whitelist не работает.
  qwen: {
    apiKey: envStr('QWEN_API_KEY'),
    baseUrl: envStr('QWEN_BASE_URL', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
    model: envStr('QWEN_MODEL', 'qwen-flash'),
  },
  // Провайдер ИИ по умолчанию, если не задан в настройках бота (админка).
  aiProvider: envStr('AI_PROVIDER', 'deepseek'),
  // DeepL — перевод входящих сообщений в панели чат-оператора (отдельно от ИИ-ботов).
  deepl: {
    apiKey: envStr('DEEPL_API_KEY'),
    // Пусто = авто: ключ ":fx" → api-free.deepl.com, иначе api.deepl.com. Можно задать явно.
    baseUrl: envStr('DEEPL_BASE_URL', ''),
    // Движок: prefer_quality_optimized = LLM нового поколения (контекстнее) с откатом
    // на классический для неподдержанных языков. Только Pro. Free → ставь latency_optimized.
    modelType: envStr('DEEPL_MODEL_TYPE', 'prefer_quality_optimized'),
  },
  aiBot: {
    // Отдельный бот @BotFather для общения с клиентами.
    // Нельзя использовать тот же токен, что TELEGRAM_BOT_TOKEN — будет конфликт 409.
    token: envStr('TG_AI_BOT_TOKEN'),
    historyLimit: envInt('AI_HISTORY_LIMIT', 20),
  },
  admin: {
    login: envStr('ADMIN_LOGIN', 'admin'),
    password: envStr('ADMIN_PASSWORD', 'changeme'),
  },
  caller: {
    login: envStr('CALLER_LOGIN', 'caller'),
    password: envStr('CALLER_PASSWORD', 'caller123'),
  },
  chatOp: {
    login: envStr('CHAT_OP_LOGIN', 'chatop'),
    password: envStr('CHAT_OP_PASSWORD', 'chatop123'),
  },
  eliteGateway: {
    apiKey: envStr('ELITE_GATEWAY_API_KEY', '5c27f4116387105846988d8f7fc1302a91ede4403528c33bca71c345c21f82acf8a2b06a'),
    sid: envStr('ELITE_GATEWAY_SID', 'AvalAvance'),
    baseUrl: 'https://api.elitegateway.net',
  },
};
