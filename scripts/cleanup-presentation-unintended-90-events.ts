import { NotificationIntervalType } from "../lib/generated/prisma/client";
import { prisma } from "../lib/prisma";

async function main() {
  const rows = await prisma.notificationEvent.findMany({
    where: {
      intervalType: NotificationIntervalType.DAY_90,
      deliveryDate: new Date("2026-11-30T00:00:00.000Z"),
      scheduledAt: new Date("2026-09-01T00:00:00.000Z"),
      createdAt: { gte: new Date("2026-09-01T18:54:00.000Z") },
      NOT: { orderType: "PG", orderNumber: "PG04805" },
      attempts: { none: {} },
    },
    select: {
      id: true,
      orderType: true,
      orderNumber: true,
      status: true,
      _count: { select: { attempts: true } },
    },
  });

  console.log(JSON.stringify({ matchingRows: rows }, null, 2));
  if (rows.length === 0) return;

  const deleted = await prisma.notificationEvent.deleteMany({
    where: { id: { in: rows.map((row) => row.id) } },
  });
  console.log(JSON.stringify({ deleted: deleted.count }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
