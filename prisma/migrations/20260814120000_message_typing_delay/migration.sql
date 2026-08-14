-- Анимация «печатает» во втором чате: отложенный показ сообщений оператора.
-- deliverAt — момент, когда сообщение становится видно клиенту (хранится в БД,
-- чтобы клиент, зашедший позже, досматривал только остаток анимации).
ALTER TABLE "Message" ADD COLUMN "deliverAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "typingMs" INTEGER;
