-- История привязок лида к обработчикам.
-- WebClient.handlerId = «кто ведёт сейчас», здесь = интервалы «кто вёл и когда».
CREATE TABLE "ClientAssignment" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "handlerId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientAssignment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientAssignment_clientId_startedAt_idx" ON "ClientAssignment"("clientId", "startedAt");
CREATE INDEX "ClientAssignment_handlerId_startedAt_idx" ON "ClientAssignment"("handlerId", "startedAt");

ALTER TABLE "ClientAssignment" ADD CONSTRAINT "ClientAssignment_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "WebClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientAssignment" ADD CONSTRAINT "ClientAssignment_handlerId_fkey"
    FOREIGN KEY ("handlerId") REFERENCES "Handler"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Бэкфилл: каждому уже назначенному лиду открываем интервал с даты его когорты.
-- Истории переназначений до этой миграции не существует, поэтому все прошлые
-- депозиты закрепляются за ТЕКУЩИМ обработчиком лида — восстановить, кто вёл
-- клиента раньше, уже неоткуда. Разделение «до/после» начнёт работать с новых
-- переназначений.
INSERT INTO "ClientAssignment" ("id", "clientId", "handlerId", "startedAt", "endedAt", "createdAt")
SELECT
    'cas_' || md5(random()::text || clock_timestamp()::text || wc."id"),
    wc."id",
    wc."handlerId",
    wc."assignedAt",
    NULL,
    CURRENT_TIMESTAMP
FROM "WebClient" wc
WHERE wc."handlerId" IS NOT NULL
  AND wc."assignedAt" IS NOT NULL;
