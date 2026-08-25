import {
  importSalesOrdersForLineRequestedOn,
  type ImportSalesOrdersResult,
} from "@/lib/erp/importSalesOrders";
import { dateKey } from "@/lib/notifications/helpers";

export const DELIVERY_INTERVAL_IMPORT_REQUESTED_ON_TIME = "09:19:00.000Z";
export const FRESH_IMPORT_FAILED_SKIP_REASON = "fresh_import_failed";

export type DeliveryIntervalFreshImportLoader = typeof importSalesOrdersForLineRequestedOn;

export type FreshImportFailedOrder = {
  orderType: string | null;
  orderNumber: string;
  reason: string;
};

export type FreshImportFailedOrderLookup = {
  keys: string[];
  orderNumbers: string[];
};

export type DeliveryIntervalFreshImportResult = {
  required: boolean;
  performed: boolean;
  targetDate: string;
  requestedOn: string;
  skippedReason: string | null;
  importResult: ImportSalesOrdersResult | null;
  failedOrders: FreshImportFailedOrder[];
  failedOrderLookup: FreshImportFailedOrderLookup;
  globalFailed: boolean;
  perOrderFailed: boolean;
  errorMessage: string | null;
};

export function requestedOnForDeliveryIntervalTargetDate(targetDeliveryDate: Date | string) {
  return `${dateKey(targetDeliveryDate)}T${DELIVERY_INTERVAL_IMPORT_REQUESTED_ON_TIME}`;
}

function normalizeOrderIdentifier(value: string | null | undefined) {
  return value?.trim().toUpperCase() ?? "";
}

export function freshImportFailedOrderKey(order: {
  orderType?: string | null;
  orderNumber: string;
}) {
  return `${normalizeOrderIdentifier(order.orderType)}:${normalizeOrderIdentifier(order.orderNumber)}`;
}

export function importErrorLooksLikeFailedOrder(
  error: ImportSalesOrdersResult["errors"][number]
) {
  return /failed|did not return/i.test(error.reason);
}

export function getFreshImportFailedOrders(
  importResult: ImportSalesOrdersResult | null | undefined
): FreshImportFailedOrder[] {
  return (importResult?.errors ?? [])
    .filter((error) => error.orderNumber && importErrorLooksLikeFailedOrder(error))
    .map((error) => ({
      orderType: error.orderType ? normalizeOrderIdentifier(error.orderType) : null,
      orderNumber: normalizeOrderIdentifier(error.orderNumber),
      reason: error.reason,
    }));
}

export function createFreshImportFailedOrderLookup(
  failedOrders: FreshImportFailedOrder[]
): FreshImportFailedOrderLookup {
  const keys = new Set<string>();
  const orderNumbers = new Set<string>();
  for (const order of failedOrders) {
    keys.add(freshImportFailedOrderKey(order));
    orderNumbers.add(normalizeOrderIdentifier(order.orderNumber));
  }

  return {
    keys: [...keys].sort(),
    orderNumbers: [...orderNumbers].sort(),
  };
}

export function isFreshImportFailedOrder(params: {
  failedOrderLookup?: FreshImportFailedOrderLookup | null;
  importResult?: ImportSalesOrdersResult | null;
  orderType: string;
  orderNumber: string;
}) {
  const lookup =
    params.failedOrderLookup ??
    createFreshImportFailedOrderLookup(getFreshImportFailedOrders(params.importResult));
  const keys = new Set(lookup.keys);
  const orderKey = freshImportFailedOrderKey(params);
  const untypedKey = freshImportFailedOrderKey({
    orderType: null,
    orderNumber: params.orderNumber,
  });
  return keys.has(orderKey) || keys.has(untypedKey);
}

function importFailureMetadata(importResult: ImportSalesOrdersResult | null | undefined) {
  const failedOrders = getFreshImportFailedOrders(importResult);
  return {
    failedOrders,
    failedOrderLookup: createFreshImportFailedOrderLookup(failedOrders),
    perOrderFailed: failedOrders.length > 0,
  };
}

function emptyFreshImportResult(params: {
  required: boolean;
  performed: boolean;
  targetDate: string;
  requestedOn: string;
  skippedReason: string | null;
  importResult?: ImportSalesOrdersResult | null;
  globalFailed?: boolean;
  errorMessage?: string | null;
}): DeliveryIntervalFreshImportResult {
  const metadata = importFailureMetadata(params.importResult ?? null);
  return {
    required: params.required,
    performed: params.performed,
    targetDate: params.targetDate,
    requestedOn: params.requestedOn,
    skippedReason: params.skippedReason,
    importResult: params.importResult ?? null,
    failedOrders: metadata.failedOrders,
    failedOrderLookup: metadata.failedOrderLookup,
    globalFailed: params.globalFailed ?? false,
    perOrderFailed: metadata.perOrderFailed,
    errorMessage: params.errorMessage ?? null,
  };
}

function queueErpEnabled(env: NodeJS.ProcessEnv) {
  const configured = env.USE_QUEUE_ERP?.trim().toLowerCase();
  if (configured) {
    return ["1", "true", "yes", "y", "on"].includes(configured);
  }

  return Boolean(env.MLD_QUEUE_BASE_URL?.trim() && env.MLD_QUEUE_TOKEN?.trim());
}

export function assertQueueBackedDeliveryImportConfigured(env: NodeJS.ProcessEnv = process.env) {
  if (!queueErpEnabled(env)) {
    throw new Error(
      "Fresh production delivery interval import requires queue-backed ERP. Set USE_QUEUE_ERP=true with MLD_QUEUE_BASE_URL and MLD_QUEUE_TOKEN."
    );
  }

  if (!env.MLD_QUEUE_BASE_URL?.trim()) {
    throw new Error("Fresh production delivery interval import requires MLD_QUEUE_BASE_URL.");
  }

  if (!env.MLD_QUEUE_TOKEN?.trim()) {
    throw new Error("Fresh production delivery interval import requires MLD_QUEUE_TOKEN.");
  }
}

export async function prepareFreshDeliveryIntervalImport(params: {
  targetDeliveryDate: Date | string;
  dryRun: boolean;
  deliveryDateSkipReason?: string | null;
  freshImport?: boolean;
  requireQueueBackedImport?: boolean;
  importSalesOrders?: DeliveryIntervalFreshImportLoader;
  env?: NodeJS.ProcessEnv;
}): Promise<DeliveryIntervalFreshImportResult> {
  const targetDate = dateKey(params.targetDeliveryDate);
  const requestedOn = requestedOnForDeliveryIntervalTargetDate(params.targetDeliveryDate);
  const required = params.freshImport ?? !params.dryRun;

  if (!required) {
    return emptyFreshImportResult({
      required,
      performed: false,
      targetDate,
      requestedOn,
      skippedReason: "dry_run_preview",
      importResult: null,
    });
  }

  if (params.deliveryDateSkipReason) {
    return emptyFreshImportResult({
      required,
      performed: false,
      targetDate,
      requestedOn,
      skippedReason: params.deliveryDateSkipReason,
      importResult: null,
    });
  }

  const importSalesOrders = params.importSalesOrders ?? importSalesOrdersForLineRequestedOn;
  const shouldRequireQueue = params.requireQueueBackedImport ?? !params.importSalesOrders;
  if (shouldRequireQueue) {
    assertQueueBackedDeliveryImportConfigured(params.env ?? process.env);
  }

  try {
    const importResult = await importSalesOrders(requestedOn);
    return emptyFreshImportResult({
      required,
      performed: true,
      targetDate,
      requestedOn,
      skippedReason: null,
      importResult,
    });
  } catch (error) {
    return emptyFreshImportResult({
      required,
      performed: false,
      targetDate,
      requestedOn,
      skippedReason: FRESH_IMPORT_FAILED_SKIP_REASON,
      importResult: null,
      globalFailed: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
