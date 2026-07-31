-- Выбор ИИ-провайдера для бота (deepseek | openai)
ALTER TABLE "BotConfig" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'deepseek';
