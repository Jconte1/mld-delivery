import { evaluateDeliveryGroupPayment } from "../lib/delivery-payment/deliveryGroupPayment";
import { summarizeDeliveryGroupReadiness } from "../lib/delivery-readiness/orderLineReadiness";
import {
  getFreshExternalStockMatchesForInventoryIds,
  getLatestSharePointStockSyncFreshness,
} from "../lib/sharepoint-stock/externalStockReadiness";
import {
  normalizeStockInventoryId,
  SHAREPOINT_STOCK_SOURCE,
} from "../lib/sharepoint-stock/stockInventoryNormalization";
import { prisma } from "../lib/prisma";

function dateKey(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate()
  ).padStart(2, "0")}`;
}

function money(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function main() {
  const freshness = await getLatestSharePointStockSyncFreshness();
  const activeExternalStockItems = await prisma.externalStockItem.findMany({
    where: {
      source: SHAREPOINT_STOCK_SOURCE,
      isActive: true,
    },
    select: {
      normalizedInventoryId: true,
    },
  });
  const activeStockIds = new Set(
    activeExternalStockItems.map((item) => item.normalizedInventoryId)
  );

  const candidateGroups = await prisma.orderDeliveryGroup.findMany({
    where: {
      isActive: true,
      deliveryGroupLines: {
        some: {
          isActive: true,
          orderLine: {
            itemType: "F",
            inventoryId: { not: null },
          },
        },
      },
    },
    include: {
      deliveryGroupLines: {
        where: { isActive: true },
        include: {
          orderLine: {
            include: {
              allocations: {
                orderBy: { splitLineNbr: "asc" },
              },
            },
          },
        },
        orderBy: { lineNbr: "asc" },
      },
      order: {
        include: {
          total: true,
          lines: {
            orderBy: { lineNbr: "asc" },
          },
          taxDetails: {
            orderBy: [{ rowNumber: "asc" }, { taxId: "asc" }],
          },
          deliveryGroupPaymentChargeAllocations: {
            select: {
              orderDeliveryGroupId: true,
              orderLineId: true,
              amountIncluded: true,
              sourceInterval: true,
            },
            orderBy: [{ includedAt: "asc" }, { orderLineId: "asc" }],
          },
        },
      },
    },
    orderBy: { deliveryDate: "asc" },
    take: 500,
  });

  const selected = candidateGroups.find((group) =>
    group.deliveryGroupLines.some((membership) => {
      const line = membership.orderLine;
      const normalized = normalizeStockInventoryId(line?.inventoryId);
      return line?.itemType === "F" && Boolean(normalized && activeStockIds.has(normalized));
    })
  );

  if (!selected) {
    console.log(
      JSON.stringify(
        {
          inspectedGroups: candidateGroups.length,
          activeExternalStockItems: activeExternalStockItems.length,
          matchedDeliveryGroupFound: false,
          freshness,
          safety:
            "Read-only inspection only; no notifications, sends, Acumatica, holds, order lines, delivery dates, or memberships were modified.",
        },
        null,
        2
      )
    );
    return;
  }

  const membershipLines = selected.deliveryGroupLines
    .map((membership) => membership.orderLine)
    .filter((line): line is NonNullable<typeof line> => Boolean(line));
  const stockInventoryIds = membershipLines
    .filter((line) => line.itemType === "F")
    .map((line) => line.inventoryId);
  const freshMatches = await getFreshExternalStockMatchesForInventoryIds(stockInventoryIds);
  const oldReadiness = summarizeDeliveryGroupReadiness({
    orderDeliveryGroupId: selected.id,
    orderId: selected.orderId,
    orderType: selected.orderType,
    orderNumber: selected.orderNumber,
    deliveryDate: selected.deliveryDate,
    lines: membershipLines.map((line) => ({
      id: line.id,
      lineNbr: line.lineNbr,
      inventoryId: line.inventoryId,
      lineDescription: line.lineDescription,
      itemType: line.itemType,
      itemClass: line.itemClass,
      requestedOn: line.requestedOn,
      eta: line.eta,
      orderQty: line.orderQty,
      openQty: line.openQty,
      allocations: line.allocations,
    })),
    externalStockReadyInventoryIds: new Set(),
  });
  const newReadiness = summarizeDeliveryGroupReadiness({
    orderDeliveryGroupId: selected.id,
    orderId: selected.orderId,
    orderType: selected.orderType,
    orderNumber: selected.orderNumber,
    deliveryDate: selected.deliveryDate,
    lines: membershipLines.map((line) => ({
      id: line.id,
      lineNbr: line.lineNbr,
      inventoryId: line.inventoryId,
      lineDescription: line.lineDescription,
      itemType: line.itemType,
      itemClass: line.itemClass,
      requestedOn: line.requestedOn,
      eta: line.eta,
      orderQty: line.orderQty,
      openQty: line.openQty,
      allocations: line.allocations,
    })),
    externalStockReadyInventoryIds: freshMatches,
  });

  const activeOrderLineIds = selected.deliveryGroupLines
    .map((membership) => membership.orderLineId)
    .filter((orderLineId): orderLineId is string => Boolean(orderLineId));
  const paymentInput = {
    orderDeliveryGroupId: selected.id,
    orderId: selected.orderId,
    orderType: selected.orderType,
    orderNumber: selected.orderNumber,
    deliveryDate: selected.deliveryDate,
    paymentTerms: selected.order.total?.paymentTerms ?? null,
    unpaidBalance: selected.order.total?.unpaidBalance,
    orderTotal: selected.order.total?.orderTotal,
    taxTotal: selected.order.total?.taxTotal,
    lines: selected.order.lines,
    taxDetails: selected.order.taxDetails,
    activeOrderLineIds,
    freightDeliveryChargeAllocations: selected.order.deliveryGroupPaymentChargeAllocations,
  };
  const oldPayment = evaluateDeliveryGroupPayment({
    ...paymentInput,
    externalStockReadyInventoryIds: new Set(),
  });
  const newPayment = evaluateDeliveryGroupPayment({
    ...paymentInput,
    externalStockReadyInventoryIds: freshMatches,
  });

  const detailsLinkAvailable = await prisma.deliveryDetailsLink.findFirst({
    where: {
      orderDeliveryGroupId: selected.id,
      deliveryDate: selected.deliveryDate,
    },
    select: { id: true },
  });
  const confirmationAvailable = await prisma.deliveryConfirmation.findFirst({
    where: {
      deliveryGroupId: selected.id,
      deliveryDate: selected.deliveryDate,
    },
    select: { id: true },
  });
  const stockMemberLineCount = membershipLines.filter((line) => line.itemType === "F").length;
  const matchingStockItemCount = membershipLines.filter((line) => {
    const normalized = normalizeStockInventoryId(line.inventoryId);
    return line.itemType === "F" && Boolean(normalized && freshMatches.has(normalized));
  }).length;
  const readyDueToStockList = newReadiness.lines.filter((line) => {
    const previous = oldReadiness.lines.find((candidate) => candidate.orderLineId === line.orderLineId);
    return previous?.readinessStatus !== "ready" && line.readinessStatus === "ready";
  }).length;

  console.log(
    JSON.stringify(
      {
        orderType: selected.orderType,
        orderNumber: selected.orderNumber,
        deliveryDate: dateKey(selected.deliveryDate),
        freshness,
        matchingStockItemCount,
        nonmatchingStockItemCount: stockMemberLineCount - matchingStockItemCount,
        statusesWouldBecomeReadyDueToStockList: readyDueToStockList,
        oldReadinessTotals: oldReadiness.totals,
        newReadinessTotals: newReadiness.totals,
        paymentPayableBasisChanged:
          money(oldPayment.payableBasisValue) !== money(newPayment.payableBasisValue),
        oldPayableStockValue: oldPayment.payableStockValue,
        newPayableStockValue: newPayment.payableStockValue,
        oldPayableBasisValue: oldPayment.payableBasisValue,
        newPayableBasisValue: newPayment.payableBasisValue,
        oldAmountDueNowRounded: oldPayment.amountDueNowRounded,
        newAmountDueNowRounded: newPayment.amountDueNowRounded,
        detailsLinkAvailable: Boolean(detailsLinkAvailable),
        detailsLinkCanBeOpenedLocally: Boolean(detailsLinkAvailable),
        confirmationLinkAvailable: Boolean(confirmationAvailable),
        safety:
          "Read-only inspection only; no notifications, sends, Acumatica, holds, order lines, delivery dates, or memberships were modified.",
      },
      null,
      2
    )
  );
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
