-- Handler (менеджер)
CREATE TABLE "Handler" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Handler_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Handler_login_key" ON "Handler"("login");

-- WebClient: обработчик + дата назначения (когорта)
ALTER TABLE "WebClient" ADD COLUMN "handlerId" TEXT;
ALTER TABLE "WebClient" ADD COLUMN "assignedAt" TIMESTAMP(3);
CREATE INDEX "WebClient_handlerId_assignedAt_idx" ON "WebClient"("handlerId", "assignedAt");
ALTER TABLE "WebClient" ADD CONSTRAINT "WebClient_handlerId_fkey"
    FOREIGN KEY ("handlerId") REFERENCES "Handler"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Deposit (подтверждённая оплата)
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "flowSessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Deposit_flowSessionId_type_key" ON "Deposit"("flowSessionId", "type");
CREATE INDEX "Deposit_confirmedAt_idx" ON "Deposit"("confirmedAt");
CREATE INDEX "Deposit_clientId_idx" ON "Deposit"("clientId");
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "WebClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
