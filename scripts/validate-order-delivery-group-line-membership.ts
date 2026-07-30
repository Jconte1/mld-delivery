import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS,
  isDeliverableOrderLineItemType,
  syncOrderDeliveryGroupLineMemberships,
} from "@/lib/erp/orderDeliveryGroupLineMembership";

type Failure = {
  label: string;
  detail?: string;
};

type FakeDeliveryGroup = {
  id: string;
  orderId: string;
  deliveryDate: Date;
  isActive: boolean;
};

type FakeMembership = {
  id: string;
  orderDeliveryGroupId: string;
  orderLineId: string | null;
  orderId: string;
  orderType: string;
  orderNumber: string;
  lineNbr: number;
  inventoryId: string | null;
  deliveryDate: Date;
  isActive: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  removedAt: Date | null;
  removedReason: string | null;
};

function day(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function assert(condition: boolean, label: string, failures: Failure[], detail?: string) {
  if (!condition) failures.push({ label, detail });
}

function createFakeClient(params: {
  groups: FakeDeliveryGroup[];
  memberships?: FakeMembership[];
}) {
  const memberships = params.memberships ?? [];
  let nextMembershipId = 1;

  return {
    store: { memberships },
    client: {
      orderDeliveryGroup: {
        async findMany(args: { where: { orderId: string; isActive: boolean } }) {
          return params.groups
            .filter(
              (group) =>
                group.orderId === args.where.orderId && group.isActive === args.where.isActive
            )
            .map((group) => ({
              id: group.id,
              deliveryDate: group.deliveryDate,
            }));
        },
      },
      orderDeliveryGroupLine: {
        async findMany(args: { where: { orderId: string } }) {
          return memberships
            .filter((membership) => membership.orderId === args.where.orderId)
            .map((membership) => ({
              id: membership.id,
              orderDeliveryGroupId: membership.orderDeliveryGroupId,
              orderLineId: membership.orderLineId,
              deliveryDate: membership.deliveryDate,
              isActive: membership.isActive,
            }));
        },
        async upsert(args: {
          where: {
            orderDeliveryGroupId_orderLineId: {
              orderDeliveryGroupId: string;
              orderLineId: string;
            };
          };
          create: Omit<FakeMembership, "id" | "removedReason" | "removedAt"> & {
            removedReason: null;
            removedAt: null;
          };
          update: Partial<FakeMembership>;
        }) {
          const key = args.where.orderDeliveryGroupId_orderLineId;
          const existing = memberships.find(
            (membership) =>
              membership.orderDeliveryGroupId === key.orderDeliveryGroupId &&
              membership.orderLineId === key.orderLineId
          );
          if (existing) {
            Object.assign(existing, args.update);
            return { id: existing.id };
          }

          const created: FakeMembership = {
            ...args.create,
            id: `membership-${nextMembershipId++}`,
          };
          memberships.push(created);
          return { id: created.id };
        },
        async updateMany(args: {
          where: { id: string; isActive: boolean };
          data: Partial<FakeMembership>;
        }) {
          let count = 0;
          for (const membership of memberships) {
            if (
              membership.id === args.where.id &&
              membership.isActive === args.where.isActive
            ) {
              Object.assign(membership, args.data);
              count += 1;
            }
          }
          return { count };
        },
        async count(args: { where: { orderId: string; isActive: boolean } }) {
          return memberships.filter(
            (membership) =>
              membership.orderId === args.where.orderId &&
              membership.isActive === args.where.isActive
          ).length;
        },
      },
    } as unknown as Parameters<typeof syncOrderDeliveryGroupLineMemberships>[0],
  };
}

async function validateRuntimeMembershipSync(failures: Failure[]) {
  const importAt = day("2026-08-01");
  const fake = createFakeClient({
    groups: [{ id: "group-1", orderId: "order-1", deliveryDate: day("2026-08-01"), isActive: true }],
    memberships: [
      {
        id: "old-non-stock-membership",
        orderDeliveryGroupId: "group-1",
        orderLineId: "line-n",
        orderId: "order-1",
        orderType: "SO",
        orderNumber: "SO-TEST",
        lineNbr: 2,
        inventoryId: "LABOR",
        deliveryDate: day("2026-08-01"),
        isActive: true,
        firstSeenAt: day("2026-07-01"),
        lastSeenAt: day("2026-07-01"),
        removedAt: null,
        removedReason: null,
      },
    ],
  });

  const result = await syncOrderDeliveryGroupLineMemberships(fake.client, {
    orderId: "order-1",
    orderType: "SO",
    orderNumber: "SO-TEST",
    importAt,
    currentLines: [
      {
        id: "line-f",
        lineNbr: 1,
        inventoryId: "RANGE",
        itemType: "F",
        requestedOn: day("2026-08-01"),
      },
      {
        id: "line-n",
        lineNbr: 2,
        inventoryId: "LABOR",
        itemType: "N",
        requestedOn: day("2026-08-01"),
      },
      {
        id: "line-l",
        lineNbr: 3,
        inventoryId: "INSTALL",
        itemType: "L",
        requestedOn: day("2026-08-01"),
      },
      {
        id: "line-null",
        lineNbr: 4,
        inventoryId: "UNKNOWN",
        itemType: null,
        requestedOn: day("2026-08-01"),
      },
      {
        id: "line-f-missing-date",
        lineNbr: 5,
        inventoryId: "FRIDGE",
        itemType: "F",
        requestedOn: null,
      },
      {
        id: "line-f-missing-group",
        lineNbr: 6,
        inventoryId: "DW",
        itemType: "F",
        requestedOn: day("2026-08-02"),
      },
    ],
  });

  assert(result.deliverableLines === 1, "only F line with active group is deliverable", failures);
  assert(result.activeMembershipsUpserted === 1, "one active membership upserted", failures);
  assert(result.membershipsCreated === 1, "F line membership created", failures);
  assert(result.excludedNonStockLines === 1, "itemType N excluded", failures);
  assert(result.excludedServiceLines === 1, "itemType L excluded", failures);
  assert(result.excludedUnknownItemTypeLines === 1, "null itemType excluded", failures);
  assert(result.excludedMissingRequestedOnLines === 1, "F line missing requestedOn excluded", failures);
  assert(result.excludedMissingDeliveryGroupLines === 1, "F line missing active group excluded", failures);
  assert(result.activeMembershipCount === 1, "only one active membership remains", failures);

  const oldNonStock = fake.store.memberships.find(
    (membership) => membership.id === "old-non-stock-membership"
  );
  assert(oldNonStock?.isActive === false, "existing N membership deactivated", failures);
  assert(
    oldNonStock?.removedReason ===
      ORDER_DELIVERY_GROUP_LINE_REMOVED_REASONS.nonStockLineExcluded,
    "N membership deactivation reason is non_stock_line_excluded",
    failures,
    oldNonStock?.removedReason ?? "missing"
  );

  const nonStockOnly = createFakeClient({
    groups: [{ id: "group-n-only", orderId: "order-n-only", deliveryDate: day("2026-08-01"), isActive: true }],
  });
  const nonStockOnlyResult = await syncOrderDeliveryGroupLineMemberships(nonStockOnly.client, {
    orderId: "order-n-only",
    orderType: "SO",
    orderNumber: "SO-N-ONLY",
    importAt,
    currentLines: [
      {
        id: "line-n-only",
        lineNbr: 1,
        inventoryId: "DELIVERY-FEE",
        itemType: "N",
        requestedOn: day("2026-08-01"),
      },
    ],
  });
  assert(
    nonStockOnlyResult.activeMembershipCount === 0,
    "non-stock-only delivery group has zero active membership rows",
    failures
  );
}

async function validateStaticFiles(failures: Failure[]) {
  const repoRoot = process.cwd();
  const files = {
    schema: await readFile(path.join(repoRoot, "prisma/schema.prisma"), "utf8"),
    importSalesOrders: await readFile(path.join(repoRoot, "lib/erp/importSalesOrders.ts"), "utf8"),
    readiness: await readFile(path.join(repoRoot, "lib/delivery-readiness/orderLineReadiness.ts"), "utf8"),
    payment: await readFile(path.join(repoRoot, "lib/delivery-payment/deliveryGroupPayment.ts"), "utf8"),
    backfill: await readFile(path.join(repoRoot, "scripts/backfill-order-delivery-group-lines.ts"), "utf8"),
  };

  assert(files.schema.includes("model OrderDeliveryGroupLine"), "schema has OrderDeliveryGroupLine", failures);
  assert(files.schema.includes("onDelete: SetNull"), "membership keeps history when OrderLine is deleted", failures);
  assert(
    files.importSalesOrders.includes("isDeliverableOrderLineItemType") &&
      files.importSalesOrders.includes("requestedDateDeliverableLineCounts"),
    "import counts delivery group lines using deliverable item type",
    failures
  );
  assert(
    files.importSalesOrders.includes("syncOrderDeliveryGroupLineMemberships"),
    "import maintains explicit delivery group memberships",
    failures
  );
  assert(
    files.readiness.includes("deliveryGroupLines") &&
      !files.readiness.includes("where: { requestedOn: deliveryGroup.deliveryDate }"),
    "readiness loads explicit active membership instead of date-only inferred lines",
    failures
  );
  assert(
    files.payment.includes("deliveryGroupLines: { some: { isActive: true } }"),
    "payment evaluation is limited to active explicit deliverable memberships",
    failures
  );
  assert(
    files.backfill.includes("excludedNonStockItemTypeN") &&
      files.backfill.includes('includeRule: \'OrderLine.itemType === "F"\''),
    "backfill reports excluded itemType N and uses strict F include rule",
    failures
  );

  const notificationFiles = [
    "lib/notifications/createDeliveryReminderEvents.ts",
    "lib/notifications/create42DayDeliveryConfirmationEvents.ts",
    "lib/notifications/create30DayDeliveryReminderEvents.ts",
    "lib/notifications/create12DayDeliveryPaymentRequestEvents.ts",
    "lib/notifications/create10DayDeliveryPaymentRequestEvents.ts",
    "lib/notifications/create8DayPaymentEnforcementEvents.ts",
    "lib/notifications/create2DayDeliveryReminderEvents.ts",
  ];
  for (const file of notificationFiles) {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    assert(
      source.includes("deliveryGroupLines: { some: { isActive: true } }"),
      `${file} requires at least one active deliverable membership`,
      failures
    );
  }
}

async function main() {
  const failures: Failure[] = [];

  assert(isDeliverableOrderLineItemType("F"), "itemType F is deliverable", failures);
  assert(isDeliverableOrderLineItemType(" f "), "itemType F is normalized", failures);
  assert(!isDeliverableOrderLineItemType("N"), "itemType N is not deliverable", failures);
  assert(!isDeliverableOrderLineItemType("L"), "itemType L is not deliverable", failures);
  assert(!isDeliverableOrderLineItemType(null), "null itemType is not deliverable", failures);

  await validateRuntimeMembershipSync(failures);
  await validateStaticFiles(failures);

  if (failures.length > 0) {
    console.error("Order delivery group line membership validation failed:");
    for (const failure of failures) {
      console.error(`- ${failure.label}${failure.detail ? `: ${failure.detail}` : ""}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        status: "passed",
        includeRule: 'OrderLine.itemType === "F"',
        verified: [
          "itemType N lines do not create active OrderDeliveryGroupLine rows",
          "non-stock-only delivery groups have zero active membership rows",
          "non-stock/service/null item types are excluded and reported",
          "notification targeting requires active explicit deliverable membership",
          "readiness and payment use explicit active membership",
        ],
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
