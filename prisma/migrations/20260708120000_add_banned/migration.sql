-- Добавляет флаг «ожидание»: клиент сохранён, но редиректится на ban.html
ALTER TABLE "WebClient" ADD COLUMN "banned" BOOLEAN NOT NULL DEFAULT false;
