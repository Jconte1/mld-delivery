import { createHash } from "node:crypto";

import { Prisma } from "@/lib/generated/prisma/client";

import {
  ERP_CHANGE_ENTITY_TYPES,
  ERP_CHANGE_SEVERITIES,
  ERP_CHANGE_STATUSES,
  ERP_CHANGE_TYPES,
  type ErpChangeEntityType,
  type ErpChangeSeverity,
  type ErpChangeType,
} from "./erpChangeTypes";

export type ErpChangeDetectionResult = {
  detected: number;
  created: number;
  deduped: number;
};

type ErpChangeEventWriter = {
  erpChangeEvent: {
    createMany(args: {
      data: Prisma.ErpChangeEventCreateManyInput[];
      skipDuplicates?: boolean;
    }): Promise<{ count: number }>;
  };
};

type ChangeValueType = "string" | "date" | "decimal" | "boolean" | "integer";

type ChangeFieldDefinition = {
  fieldName: string;
  changeType: ErpChangeType;
  valueType?: ChangeValueType;
};

type NormalizedChangeValue = string | number | boolean | null;

type ChangeContext = {
  entityType: ErpChangeEntityType;
  entityId?: string | null;
  entityKey: string;
  changeKeyBase: string;
  orderId?: string | null;
  orderType?: string | null;
  orderNumber?: string | null;
  orderLineId?: string | null;
  orderDeliveryGroupId?: string | null;
  orderLineAllocationId?: string | null;
  lineNbr?: number | null;
  splitLineNbr?: number | null;
  deliveryDate?: Date | null;
};

type DetectErpChangesParams = {
  existing: unknown | null;
  incoming: unknown;
  fields: ChangeFieldDefinition[];
  context: ChangeContext;
};

type EntityWrapperParams = {
  existing: unknown | null;
  incoming: unknown;
};

type OrderContext = {
  orderId?: string | null;
  orderType: string;
  orderNumber: string;
};

type ChildContext = OrderContext & {
  entityId?: string | null;
};

const ORDER_FIELDS: ChangeFieldDefinition[] = [
  { fieldName: "status", changeType: ERP_CHANGE_TYPES.ORDER_STATUS_CHANGED },
  { fieldName: "customerId", changeType: ERP_CHANGE_TYPES.CUSTOMER_CHANGED },
  { fieldName: "customerDescription", changeType: ERP_CHANGE_TYPES.CUSTOMER_CHANGED },
  { fieldName: "contactId", changeType: ERP_CHANGE_TYPES.CONTACT_CHANGED },
  { fieldName: "locationId", changeType: ERP_CHANGE_TYPES.LOCATION_CHANGED },
  { fieldName: "locationDescription", changeType: ERP_CHANGE_TYPES.LOCATION_CHANGED },
  { fieldName: "buyerGroup", changeType: ERP_CHANGE_TYPES.BUYER_GROUP_CHANGED },
  { fieldName: "shipVia", changeType: ERP_CHANGE_TYPES.SHIPPING_METHOD_CHANGED },
];

const ORDER_TOTAL_FIELDS: ChangeFieldDefinition[] = [
  {
    fieldName: "unpaidBalance",
    changeType: ERP_CHANGE_TYPES.ORDER_TOTAL_CHANGED,
    valueType: "decimal",
  },
  {
    fieldName: "orderTotal",
    changeType: ERP_CHANGE_TYPES.ORDER_TOTAL_CHANGED,
    valueType: "decimal",
  },
  {
    fieldName: "taxTotal",
    changeType: ERP_CHANGE_TYPES.ORDER_TOTAL_CHANGED,
    valueType: "decimal",
  },
  {
    fieldName: "lineTotalAmount",
    changeType: ERP_CHANGE_TYPES.ORDER_TOTAL_CHANGED,
    valueType: "decimal",
  },
  {
    fieldName: "unbilledAmount",
    changeType: ERP_CHANGE_TYPES.ORDER_TOTAL_CHANGED,
    valueType: "decimal",
  },
  {
    fieldName: "unbilledQty",
    changeType: ERP_CHANGE_TYPES.ORDER_TOTAL_CHANGED,
    valueType: "decimal",
  },
  {
    fieldName: "paymentTerms",
    changeType: ERP_CHANGE_TYPES.ORDER_TOTAL_CHANGED,
  },
];

const ORDER_LINE_FIELDS: ChangeFieldDefinition[] = [
  {
    fieldName: "requestedOn",
    changeType: ERP_CHANGE_TYPES.DELIVERY_DATE_CHANGED,
    valueType: "date",
  },
  { fieldName: "eta", changeType: ERP_CHANGE_TYPES.ETA_CHANGED, valueType: "date" },
  { fieldName: "inventoryId", changeType: ERP_CHANGE_TYPES.LINE_ITEM_CHANGED },
  { fieldName: "lineDescription", changeType: ERP_CHANGE_TYPES.LINE_ITEM_CHANGED },
  { fieldName: "itemType", changeType: ERP_CHANGE_TYPES.LINE_ITEM_CHANGED },
  { fieldName: "itemClass", changeType: ERP_CHANGE_TYPES.LINE_ITEM_CHANGED },
  { fieldName: "warehouseId", changeType: ERP_CHANGE_TYPES.LINE_ITEM_CHANGED },
  {
    fieldName: "orderQty",
    changeType: ERP_CHANGE_TYPES.LINE_QUANTITY_CHANGED,
    valueType: "decimal",
  },
  {
    fieldName: "openQty",
    changeType: ERP_CHANGE_TYPES.LINE_QUANTITY_CHANGED,
    valueType: "decimal",
  },
  {
    fieldName: "discountedUnitPrice",
    changeType: ERP_CHANGE_TYPES.LINE_PRICE_CHANGED,
    valueType: "decimal",
  },
];

const ORDER_LINE_ALLOCATION_FIELDS: ChangeFieldDefinition[] = [
  {
    fieldName: "allocated",
    changeType: ERP_CHANGE_TYPES.ALLOCATION_CHANGED,
    valueType: "boolean",
  },
  {
    fieldName: "completed",
    changeType: ERP_CHANGE_TYPES.ALLOCATION_CHANGED,
    valueType: "boolean",
  },
  { fieldName: "qty", changeType: ERP_CHANGE_TYPES.ALLOCATION_CHANGED, valueType: "decimal" },
  { fieldName: "inventoryId", changeType: ERP_CHANGE_TYPES.ALLOCATION_CHANGED },
  { fieldName: "lineNbr", changeType: ERP_CHANGE_TYPES.ALLOCATION_CHANGED, valueType: "integer" },
  {
    fieldName: "splitLineNbr",
    changeType: ERP_CHANGE_TYPES.ALLOCATION_CHANGED,
    valueType: "integer",
  },
];

const ORDER_ADDRESS_FIELDS: ChangeFieldDefinition[] = [
  { fieldName: "addressLine1", changeType: ERP_CHANGE_TYPES.ADDRESS_CHANGED },
  { fieldName: "addressLine2", changeType: ERP_CHANGE_TYPES.ADDRESS_CHANGED },
  { fieldName: "city", changeType: ERP_CHANGE_TYPES.ADDRESS_CHANGED },
  { fieldName: "state", changeType: ERP_CHANGE_TYPES.ADDRESS_CHANGED },
  { fieldName: "postalCode", changeType: ERP_CHANGE_TYPES.ADDRESS_CHANGED },
  { fieldName: "country", changeType: ERP_CHANGE_TYPES.ADDRESS_CHANGED },
];

const CONTACT_FIELDS: ChangeFieldDefinition[] = [
  { fieldName: "status", changeType: ERP_CHANGE_TYPES.CONTACT_CHANGED },
  { fieldName: "companyName", changeType: ERP_CHANGE_TYPES.CONTACT_CHANGED },
  { fieldName: "displayName", changeType: ERP_CHANGE_TYPES.CONTACT_CHANGED },
  { fieldName: "firstName", changeType: ERP_CHANGE_TYPES.CONTACT_CHANGED },
  { fieldName: "lastName", changeType: ERP_CHANGE_TYPES.CONTACT_CHANGED },
  { fieldName: "email", changeType: ERP_CHANGE_TYPES.CONTACT_CHANGED },
  { fieldName: "phone1", changeType: ERP_CHANGE_TYPES.CONTACT_CHANGED },
  { fieldName: "phone2", changeType: ERP_CHANGE_TYPES.CONTACT_CHANGED },
  { fieldName: "emailOptIn", changeType: ERP_CHANGE_TYPES.CONTACT_CHANGED, valueType: "boolean" },
];

function emptyResult(): ErpChangeDetectionResult {
  return {
    detected: 0,
    created: 0,
    deduped: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getRecordValue(record: unknown, fieldName: string): unknown {
  if (!isRecord(record)) return undefined;
  return record[fieldName];
}

function unwrapValue(value: unknown): unknown {
  if (isRecord(value) && "value" in value) return value.value ?? null;
  return value ?? null;
}

function dateKeyFromValue(value: unknown): string | null {
  const unwrapped = unwrapValue(value);

  if (unwrapped instanceof Date) {
    return unwrapped.toISOString().slice(0, 10);
  }

  if (typeof unwrapped === "string") {
    const trimmed = unwrapped.trim();
    if (!trimmed) return null;

    const dateOnly = trimmed.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    if (dateOnly) return dateOnly;

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }

    return trimmed;
  }

  return null;
}

function normalizeDecimalString(value: string): string {
  const normalized = value.trim().replace(/,/g, "");
  if (!normalized) return "";
  if (!/^[+-]?\d+(\.\d+)?$/.test(normalized)) return normalized;

  const sign = normalized.startsWith("-") ? "-" : "";
  const unsigned = normalized.replace(/^[+-]/, "");
  const [wholeRaw, fractionRaw = ""] = unsigned.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionRaw.replace(/0+$/, "");
  const decimal = `${sign}${whole}${fraction ? `.${fraction}` : ""}`;

  return decimal === "-0" ? "0" : decimal;
}

export function normalizeErpChangeValue(
  value: unknown,
  valueType: ChangeValueType = "string"
): NormalizedChangeValue {
  const unwrapped = unwrapValue(value);
  if (unwrapped === null || unwrapped === undefined) return null;

  if (valueType === "date") {
    return dateKeyFromValue(unwrapped);
  }

  if (valueType === "decimal") {
    if (typeof unwrapped === "number") {
      return Number.isFinite(unwrapped) ? normalizeDecimalString(String(unwrapped)) : null;
    }
    const stringValue = String(unwrapped).trim();
    return stringValue ? normalizeDecimalString(stringValue) : null;
  }

  if (valueType === "integer") {
    const parsed = typeof unwrapped === "number" ? unwrapped : Number(String(unwrapped).trim());
    return Number.isInteger(parsed) ? parsed : null;
  }

  if (valueType === "boolean") {
    if (typeof unwrapped === "boolean") return unwrapped;
    if (typeof unwrapped === "number") {
      if (unwrapped === 1) return true;
      if (unwrapped === 0) return false;
      return null;
    }

    const normalized = String(unwrapped).trim().toLowerCase();
    if (["1", "true", "t", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "f", "no", "n", "off"].includes(normalized)) return false;
    return null;
  }

  if (unwrapped instanceof Date) return unwrapped.toISOString().slice(0, 10);
  if (typeof unwrapped === "boolean" || typeof unwrapped === "number") return unwrapped;

  const stringValue = String(unwrapped).trim();
  return stringValue || null;
}

function jsonValue(
  value: NormalizedChangeValue
): Prisma.ErpChangeEventCreateManyInput["oldValue"] {
  return value === null ? Prisma.JsonNull : value;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function keyValue(value: NormalizedChangeValue) {
  const raw = value === null ? "null" : String(value);
  if (raw.length <= 120) return raw;
  return `${raw.slice(0, 80)}~${hash(raw).slice(0, 16)}`;
}

function buildChangeKey(
  changeKeyBase: string,
  fieldName: string,
  oldValue: NormalizedChangeValue,
  newValue: NormalizedChangeValue
) {
  const changeValueKey = `${keyValue(oldValue)}->${keyValue(newValue)}`;
  const changeKey = `${changeKeyBase}:${fieldName}:${changeValueKey}`;
  if (changeKey.length <= 512) return changeKey;
  return `${changeKeyBase}:${fieldName}:hash:${hash(changeValueKey)}`;
}

function defaultSeverity(changeType: ErpChangeType, fieldName: string): ErpChangeSeverity {
  if (
    changeType === ERP_CHANGE_TYPES.DELIVERY_DATE_CHANGED ||
    (changeType === ERP_CHANGE_TYPES.ORDER_TOTAL_CHANGED && fieldName === "unpaidBalance")
  ) {
    return ERP_CHANGE_SEVERITIES.HIGH;
  }

  if (changeType === ERP_CHANGE_TYPES.LINE_PRICE_CHANGED) {
    return ERP_CHANGE_SEVERITIES.LOW;
  }

  return ERP_CHANGE_SEVERITIES.MEDIUM;
}

function formatSummaryValue(value: NormalizedChangeValue) {
  return value === null ? "null" : String(value);
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function buildSummary(
  context: ChangeContext,
  fieldName: string,
  oldValue: NormalizedChangeValue,
  newValue: NormalizedChangeValue
) {
  return truncate(
    `${context.entityType} ${context.entityKey} ${fieldName} changed from ${formatSummaryValue(
      oldValue
    )} to ${formatSummaryValue(newValue)}`,
    1024
  );
}

function buildChangeEvents({
  existing,
  incoming,
  fields,
  context,
}: DetectErpChangesParams): Prisma.ErpChangeEventCreateManyInput[] {
  if (!existing) return [];

  const now = new Date();
  const events: Prisma.ErpChangeEventCreateManyInput[] = [];

  for (const field of fields) {
    const oldValue = normalizeErpChangeValue(
      getRecordValue(existing, field.fieldName),
      field.valueType
    );
    const newValue = normalizeErpChangeValue(
      getRecordValue(incoming, field.fieldName),
      field.valueType
    );

    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) {
      continue;
    }

    events.push({
      changeType: field.changeType,
      entityType: context.entityType,
      entityId: context.entityId ?? null,
      entityKey: context.entityKey,
      fieldName: field.fieldName,
      orderId: context.orderId ?? null,
      orderType: context.orderType ?? null,
      orderNumber: context.orderNumber ?? null,
      orderLineId: context.orderLineId ?? null,
      orderDeliveryGroupId: context.orderDeliveryGroupId ?? null,
      orderLineAllocationId: context.orderLineAllocationId ?? null,
      lineNbr: context.lineNbr ?? null,
      splitLineNbr: context.splitLineNbr ?? null,
      deliveryDate: context.deliveryDate ?? null,
      oldValue: jsonValue(oldValue),
      newValue: jsonValue(newValue),
      summary: buildSummary(context, field.fieldName, oldValue, newValue),
      severity: defaultSeverity(field.changeType, field.fieldName),
      changeKey: buildChangeKey(context.changeKeyBase, field.fieldName, oldValue, newValue),
      status: ERP_CHANGE_STATUSES.DETECTED,
      source: "acumatica",
      detectedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  return events;
}

export async function detectMeaningfulErpChanges(
  tx: ErpChangeEventWriter,
  params: DetectErpChangesParams
): Promise<ErpChangeDetectionResult> {
  const events = buildChangeEvents(params);
  if (events.length === 0) return emptyResult();

  const created = await tx.erpChangeEvent.createMany({
    data: events,
    skipDuplicates: true,
  });

  return {
    detected: events.length,
    created: created.count,
    deduped: events.length - created.count,
  };
}

export function addErpChangeDetectionResults(
  target: ErpChangeDetectionResult,
  source: ErpChangeDetectionResult
) {
  target.detected += source.detected;
  target.created += source.created;
  target.deduped += source.deduped;
}

export function detectOrderChanges(
  tx: ErpChangeEventWriter,
  params: EntityWrapperParams & OrderContext
) {
  const entityKey = `order:${params.orderType}:${params.orderNumber}`;
  return detectMeaningfulErpChanges(tx, {
    existing: params.existing,
    incoming: params.incoming,
    fields: ORDER_FIELDS,
    context: {
      entityType: ERP_CHANGE_ENTITY_TYPES.ORDER,
      entityId: params.orderId,
      entityKey,
      changeKeyBase: entityKey,
      orderId: params.orderId,
      orderType: params.orderType,
      orderNumber: params.orderNumber,
    },
  });
}

export function detectOrderTotalChanges(
  tx: ErpChangeEventWriter,
  params: EntityWrapperParams & ChildContext
) {
  const entityKey = `order_total:${params.orderType}:${params.orderNumber}`;
  return detectMeaningfulErpChanges(tx, {
    existing: params.existing,
    incoming: params.incoming,
    fields: ORDER_TOTAL_FIELDS,
    context: {
      entityType: ERP_CHANGE_ENTITY_TYPES.ORDER_TOTAL,
      entityId: params.entityId,
      entityKey,
      changeKeyBase: entityKey,
      orderId: params.orderId,
      orderType: params.orderType,
      orderNumber: params.orderNumber,
    },
  });
}

export function detectOrderLineChanges(
  tx: ErpChangeEventWriter,
  params: EntityWrapperParams &
    ChildContext & {
      lineNbr: number;
      deliveryDate?: Date | null;
    }
) {
  const entityKey = `order_line:${params.orderType}:${params.orderNumber}:${params.lineNbr}`;
  return detectMeaningfulErpChanges(tx, {
    existing: params.existing,
    incoming: params.incoming,
    fields: ORDER_LINE_FIELDS,
    context: {
      entityType: ERP_CHANGE_ENTITY_TYPES.ORDER_LINE,
      entityId: params.entityId,
      entityKey,
      changeKeyBase: entityKey,
      orderId: params.orderId,
      orderType: params.orderType,
      orderNumber: params.orderNumber,
      orderLineId: params.entityId,
      lineNbr: params.lineNbr,
      deliveryDate: params.deliveryDate,
    },
  });
}

export function detectOrderLineAllocationChanges(
  tx: ErpChangeEventWriter,
  params: EntityWrapperParams &
    ChildContext & {
      orderLineId: string;
      lineNbr: number;
      splitLineNbr: number;
    }
) {
  const entityKey = `allocation:${params.orderType}:${params.orderNumber}:${params.lineNbr}:${params.splitLineNbr}`;
  return detectMeaningfulErpChanges(tx, {
    existing: params.existing,
    incoming: params.incoming,
    fields: ORDER_LINE_ALLOCATION_FIELDS,
    context: {
      entityType: ERP_CHANGE_ENTITY_TYPES.ORDER_LINE_ALLOCATION,
      entityId: params.entityId,
      entityKey,
      changeKeyBase: entityKey,
      orderId: params.orderId,
      orderType: params.orderType,
      orderNumber: params.orderNumber,
      orderLineId: params.orderLineId,
      orderLineAllocationId: params.entityId,
      lineNbr: params.lineNbr,
      splitLineNbr: params.splitLineNbr,
    },
  });
}

export function detectOrderAddressChanges(
  tx: ErpChangeEventWriter,
  params: EntityWrapperParams & ChildContext
) {
  const entityKey = `address:${params.orderType}:${params.orderNumber}`;
  return detectMeaningfulErpChanges(tx, {
    existing: params.existing,
    incoming: params.incoming,
    fields: ORDER_ADDRESS_FIELDS,
    context: {
      entityType: ERP_CHANGE_ENTITY_TYPES.ORDER_ADDRESS,
      entityId: params.entityId,
      entityKey,
      changeKeyBase: entityKey,
      orderId: params.orderId,
      orderType: params.orderType,
      orderNumber: params.orderNumber,
    },
  });
}

export function detectContactChanges(
  tx: ErpChangeEventWriter,
  params: EntityWrapperParams & {
    contactId: string;
    entityId?: string | null;
  }
) {
  const entityKey = `contact:${params.contactId}`;
  return detectMeaningfulErpChanges(tx, {
    existing: params.existing,
    incoming: params.incoming,
    fields: CONTACT_FIELDS,
    context: {
      entityType: ERP_CHANGE_ENTITY_TYPES.CONTACT,
      entityId: params.entityId,
      entityKey,
      changeKeyBase: entityKey,
    },
  });
}
