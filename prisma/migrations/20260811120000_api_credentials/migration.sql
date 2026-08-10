-- Ключи провайдеров ИИ, управляемые из админки / присылаемые userscript'ом.
-- Запись здесь перебивает значение из .env; нет записи — работает .env.
CREATE TABLE "ApiCredential" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiCredential_provider_key" ON "ApiCredential"("provider");
