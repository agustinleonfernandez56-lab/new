-- Правка операторских сообщений: отправитель + история версий
ALTER TABLE "Message" ADD COLUMN "senderHandlerId" TEXT;
ALTER TABLE "Message" ADD COLUMN "editedAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "editHistory" JSONB;
