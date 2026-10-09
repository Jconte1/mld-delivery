import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import type { OrderCompleteStore } from "./orderComplete";

export function createOrderCompleteStore(db: PrismaClient): OrderCompleteStore {
  return {
    async exists({ orderType, orderNumber }) {
      return Boolean(await db.orderCompleteEvent.findUnique({ where: { orderType_orderNumber: { orderType, orderNumber } }, select: { id: true } }));
    },
    async claim(input) {
      try {
        // Nested create is atomic; the database unique key arbitrates concurrent workers.
        const event = await db.orderCompleteEvent.create({
          data: {
            orderType: input.orderType,
            orderNumber: input.orderNumber,
            completedAt: new Date(input.completedAt),
            discoveryJobId: input.discoveryJobId,
            attempt: { create: {
              contactId: input.contactId,
              channel: input.channel,
              recipient: input.recipient,
              realSmsOptIn: input.smsOptIn,
              realEmailOptIn: input.emailOptIn,
              optOutCheckedAt: input.checkedAt,
              freshErpCheckedAt: input.checkedAt,
            } },
          },
          include: { attempt: true },
        });
        if (!event.attempt) throw new Error("order_complete_atomic_attempt_missing");
        return { eventId: event.id, attemptId: event.attempt.id };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
        throw error;
      }
    },
    async submitted(attemptId, receipt, at) {
      await db.orderCompleteAttempt.update({ where: { id: attemptId }, data: { ...receipt, status: "SUBMITTED", submittedAt: at } });
    },
    async review(attemptId, receipt, reason) {
      await db.orderCompleteAttempt.update({ where: { id: attemptId }, data: { ...receipt, status: "REVIEW", reason } });
    },
  };
}
