export const ERP_CHANGE_TYPES = {
  DELIVERY_DATE_CHANGED: "delivery_date_changed",
  ORDER_STATUS_CHANGED: "order_status_changed",
  ORDER_TOTAL_CHANGED: "order_total_changed",
  CUSTOMER_CHANGED: "customer_changed",
  CONTACT_CHANGED: "contact_changed",
  ADDRESS_CHANGED: "address_changed",
  LOCATION_CHANGED: "location_changed",
  SALESPERSON_CHANGED: "salesperson_changed",
  SHIPPING_METHOD_CHANGED: "shipping_method_changed",
  LINE_ITEM_CHANGED: "line_item_changed",
  LINE_QUANTITY_CHANGED: "line_quantity_changed",
  LINE_PRICE_CHANGED: "line_price_changed",
  ALLOCATION_CHANGED: "allocation_changed",
  BACKORDER_RELEVANT_CHANGE: "backorder_relevant_change",
} as const;

export type ErpChangeType = (typeof ERP_CHANGE_TYPES)[keyof typeof ERP_CHANGE_TYPES];

export const ERP_CHANGE_ENTITY_TYPES = {
  ORDER: "order",
  ORDER_TOTAL: "order_total",
  ORDER_LINE: "order_line",
  ORDER_LINE_ALLOCATION: "order_line_allocation",
  ORDER_ADDRESS: "order_address",
  ORDER_DELIVERY_GROUP: "order_delivery_group",
  CONTACT: "contact",
} as const;

export type ErpChangeEntityType =
  (typeof ERP_CHANGE_ENTITY_TYPES)[keyof typeof ERP_CHANGE_ENTITY_TYPES];

export const ERP_CHANGE_STATUSES = {
  DETECTED: "detected",
  PROCESSED: "processed",
  IGNORED: "ignored",
} as const;

export type ErpChangeStatus = (typeof ERP_CHANGE_STATUSES)[keyof typeof ERP_CHANGE_STATUSES];

export const ERP_CHANGE_SEVERITIES = {
  INFO: "info",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
} as const;

export type ErpChangeSeverity =
  (typeof ERP_CHANGE_SEVERITIES)[keyof typeof ERP_CHANGE_SEVERITIES];

export const ERP_MEANINGFUL_CHANGE_FIELDS = {
  order: {
    order_status_changed: ["status"],
    customer_changed: ["customerId", "customerDescription"],
    contact_changed: ["contactId"],
    location_changed: ["locationId", "locationDescription"],
    shipping_method_changed: ["shipVia"],
  },
  order_total: {
    order_total_changed: [
      "unpaidBalance",
      "orderTotal",
      "taxTotal",
      "lineTotalAmount",
      "unbilledAmount",
      "unbilledQty",
    ],
  },
  order_line: {
    delivery_date_changed: ["requestedOn"],
    line_item_changed: ["inventoryId", "lineDescription", "warehouseId"],
    line_quantity_changed: ["orderQty", "openQty"],
    line_price_changed: ["discountedUnitPrice"],
  },
  order_line_allocation: {
    allocation_changed: [
      "allocated",
      "completed",
      "qty",
      "inventoryId",
      "lineNbr",
      "splitLineNbr",
    ],
  },
  order_address: {
    address_changed: [
      "addressLine1",
      "addressLine2",
      "city",
      "state",
      "postalCode",
      "country",
    ],
  },
  contact: {
    contact_changed: [
      "status",
      "displayName",
      "firstName",
      "lastName",
      "email",
      "phone1",
      "phone2",
      "smsOptIn",
      "emailOptIn",
      "phoneCallOptIn",
      "preferredContactMethod",
    ],
  },
} as const;

export type ErpMeaningfulChangeFields = typeof ERP_MEANINGFUL_CHANGE_FIELDS;

// Future comparison logic should live in lib/erp/detectErpChanges.ts and be called
// before import/upsert code overwrites existing DB values. The future changeKey
// should omit import-run timestamps so re-importing identical Acumatica state does
// not create duplicate events. Intended examples:
// order:{orderType}:{orderNumber}:status:{oldValue}->{newValue}
// order_total:{orderType}:{orderNumber}:unpaidBalance:{oldValue}->{newValue}
// order_line:{orderType}:{orderNumber}:{lineNbr}:requestedOn:{oldValue}->{newValue}
// allocation:{orderType}:{orderNumber}:{lineNbr}:{splitLineNbr}:completed:{oldValue}->{newValue}
// address:{orderType}:{orderNumber}:postalCode:{oldValue}->{newValue}
// contact:{contactId}:email:{oldValue}->{newValue}
