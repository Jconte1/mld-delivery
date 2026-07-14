import AcumaticaService from "../auth/acumaticaService";

export const DEFAULT_DELIVERY_ENDPOINT_VERSION = "24.200.001";

export const DEFAULT_EXCLUDED_ORDER_TYPES = [
  "ED", // EDGE HOMES
  "GB", // GARVETT HOMES
  "BH",
  "DS", // DIRECT SHIPS
  "NH", // CBH HOMES
  "CH", // CHOCOLATE HOMES
  "CM", // CREDIT MEMO
  "CR", // CASH RETURN
  "CS", // CASH SALE
  "DR", // DAMAGE REFUSAL
  "HC", // HOME CENTER
  "IN", // INVOICE
  "IS", // INSTALL
  "IV", // IVORY HOMES
  "KS", // KEYSTONE HOMES
  "LU", // LOANER UNIT
  "MM", // RMA ORDER
  "MO", // MIXED ORDER
  "OA", // OAKWOOD HOMES
  "PR", // PROJECT
  "PT", // PARTS
  "QT", // QUOTE
  "R1", // REPLACEMENT ORDER
  "RA", // RETURN WITH ADJUSTED REPLACEMENT
  "RC", // RETURN FOR CREDIT
  "RM", // RMA ORDER
  "RR", // RETURN WITH REPLACEMENT
  "RY", // REYNOLDS HOMES
  "TB", // TOLL BROTHERS
  "TR", // TRANSFER
  "WB", // WOHALI BUILDERS
  "WP", // WASATCH PEAKS
];

export const DEFAULT_ALLOWED_SHIP_VIA = [
  "DELIVERY SW",
  "DELIVERY SLC",
  "DELIVERY PROVO",
  "DELIVERY PLUMBI",
  "DELIVERY LAYTON",
  "DELIVERY KETCHU",
  "DELIVERY BOISE",
  "SE DELIVERY",
  "DELIVERY JACKSO",
  "DEL ST GEORGE",
  "DELIVERY",
];

export const DEFAULT_SALES_ORDER_EXPAND = "Totals,Details/Allocations,ShipToAddress,TaxDetails";
export const DEFAULT_SALES_ORDER_CUSTOM = "Document.AttributeBUYERGROUP";
export const DEFAULT_ALLOWED_STATUSES = [
  "Open",
  "Awaiting Payment",
  "Back Order",
  "On Hold but Approved",
  "Shipping",
  "Completed",
  "Canceled",
  "Cancelled",
];

export type FetchSalesOrdersParams = {
  requestedOn: Date | string;
  excludedOrderTypes?: string[];
  allowedShipVia?: string[];
  allowedStatuses?: string[];
  expand?: string;
};

export type FetchQualifyingSalesOrdersParams = {
  requestedOn: Date | string;
  excludedOrderTypes?: string[];
  allowedShipVia?: string[];
  allowedStatuses?: string[];
};

type AcumaticaClientOptions = {
  authService: AcumaticaService;
  deliveryEndpointVersion?: string;
};

type SalesOrderResponse = unknown[] | { value?: unknown[] };

export class AcumaticaApiError extends Error {
  status?: number;
  responseBody?: string;

  constructor(message: string, options: { status?: number; responseBody?: string } = {}) {
    super(message);
    this.name = "AcumaticaApiError";
    this.status = options.status;
    this.responseBody = options.responseBody;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function toDateTimeOffset(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid RequestedOn date: ${String(value)}`);
  }
  return date.toISOString();
}

function odataString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function appendPath(baseUrl: string, path: string) {
  return `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function buildSalesOrderFilter(params: {
  requestedOn: Date | string;
  requestedOnField?: "RequestedOn" | "LineRequestedOn";
  excludedOrderTypes?: string[];
  allowedShipVia?: string[];
  allowedStatuses?: string[];
}) {
  const excludedOrderTypes = params.excludedOrderTypes ?? DEFAULT_EXCLUDED_ORDER_TYPES;
  const allowedShipVia = params.allowedShipVia ?? DEFAULT_ALLOWED_SHIP_VIA;
  const requestedOnField = params.requestedOnField ?? "RequestedOn";
  const clauses = [
    `${requestedOnField} eq datetimeoffset'${toDateTimeOffset(params.requestedOn)}'`,
  ];

  for (const orderType of excludedOrderTypes) {
    clauses.push(`OrderType ne ${odataString(orderType)}`);
  }

  if (allowedShipVia.length > 0) {
    const shipViaClause = allowedShipVia
      .map((shipVia) => `ShipVia eq ${odataString(shipVia)}`)
      .join(" or ");
    clauses.push(`(${shipViaClause})`);
  }

  if (params.allowedStatuses && params.allowedStatuses.length > 0) {
    const statusClause = params.allowedStatuses
      .map((status) => `Status eq ${odataString(status)}`)
      .join(" or ");
    clauses.push(`(${statusClause})`);
  }

  return clauses.join(" and ");
}

export class AcumaticaClient {
  private readonly authService: AcumaticaService;
  private readonly deliveryEndpointVersion: string;

  constructor(options: AcumaticaClientOptions) {
    this.authService = options.authService;
    this.deliveryEndpointVersion =
      options.deliveryEndpointVersion?.trim() || DEFAULT_DELIVERY_ENDPOINT_VERSION;
  }

  async fetchDeliverySalesOrdersByRequestedOn(requestedOn: Date | string): Promise<unknown[]> {
    return this.fetchSalesOrders({ requestedOn });
  }

  async fetchQualifyingSalesOrdersByLineRequestedOn(
    requestedOn: Date | string,
    params: Omit<FetchQualifyingSalesOrdersParams, "requestedOn"> = {}
  ): Promise<unknown[]> {
    const query = new URLSearchParams({
      $filter: buildSalesOrderFilter({
        requestedOn,
        requestedOnField: "LineRequestedOn",
        excludedOrderTypes: params.excludedOrderTypes,
        allowedShipVia: params.allowedShipVia,
        allowedStatuses: params.allowedStatuses ?? DEFAULT_ALLOWED_STATUSES,
      }),
      $select: "OrderNbr,OrderType,Status,ShipVia,LineRequestedOn",
    });

    const response = await this.request<SalesOrderResponse>(
      `/entity/Delivery/${encodeURIComponent(this.deliveryEndpointVersion)}/SalesOrder?${query}`
    );

    return this.toRows(response);
  }

  async fetchDeliverySalesOrderByOrderNumber(
    orderNumber: string,
    orderType?: string | null
  ): Promise<unknown[]> {
    const filter = [
      `OrderNbr eq ${odataString(orderNumber)}`,
      orderType ? `OrderType eq ${odataString(orderType)}` : null,
    ]
      .filter(Boolean)
      .join(" and ");

    const query = new URLSearchParams({
      $filter: filter,
      $expand: DEFAULT_SALES_ORDER_EXPAND,
      $custom: DEFAULT_SALES_ORDER_CUSTOM,
    });

    const response = await this.request<SalesOrderResponse>(
      `/entity/DeliverySalesOrder/${encodeURIComponent(
        this.deliveryEndpointVersion
      )}/SalesOrder?${query}`
    );

    return this.toRows(response);
  }

  async fetchDeliveryContactByContactId(contactId: string): Promise<unknown[]> {
    const trimmedContactId = contactId.trim();
    if (!trimmedContactId) return [];

    const contactIdValue = /^\d+$/.test(trimmedContactId)
      ? trimmedContactId
      : odataString(trimmedContactId);
    const query = new URLSearchParams({
      $filter: `ContactID eq ${contactIdValue}`,
      $top: "1",
    });

    const response = await this.request<SalesOrderResponse>(
      `/entity/Delivery/${encodeURIComponent(this.deliveryEndpointVersion)}/Contact?${query}`
    );

    return this.toRows(response);
  }

  async fetchSalesOrders(params: FetchSalesOrdersParams): Promise<unknown[]> {
    const query = new URLSearchParams({
      $filter: buildSalesOrderFilter(params),
      $expand: params.expand ?? DEFAULT_SALES_ORDER_EXPAND,
    });

    const response = await this.request<SalesOrderResponse>(
      `/entity/Delivery/${encodeURIComponent(this.deliveryEndpointVersion)}/SalesOrder?${query}`
    );

    return this.toRows(response);
  }

  private toRows(response: SalesOrderResponse): unknown[] {
    if (Array.isArray(response)) {
      return response;
    }
    if (response && typeof response === "object" && Array.isArray(response.value)) {
      return response.value;
    }

    throw new AcumaticaApiError("Unexpected Acumatica SalesOrder response shape");
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await this.fetchWithToken(path, options);

    if (response.status === 401) {
      this.authService.invalidateAccessToken();
      const retryResponse = await this.fetchWithToken(path, options, true);
      return this.parseResponse<T>(retryResponse, path);
    }

    return this.parseResponse<T>(response, path);
  }

  private async fetchWithToken(path: string, options: RequestInit, forceRefresh = false) {
    const token = await this.authService.getToken({ forceRefresh });
    const headers = new Headers(options.headers);

    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    headers.set("Authorization", `Bearer ${token}`);

    return fetch(appendPath(this.authService.baseUrl, path), {
      ...options,
      headers,
      cache: options.cache ?? "no-store",
    });
  }

  private async parseResponse<T>(response: Response, path: string): Promise<T> {
    const text = await response.text();

    if (!response.ok) {
      const safeBody = text.slice(0, 2000);
      throw new AcumaticaApiError(
        `Acumatica API request failed (${response.status}) path=${path} body=${safeBody}`,
        {
          status: response.status,
          responseBody: safeBody,
        }
      );
    }

    if (!text) {
      return {} as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AcumaticaApiError(
        `Acumatica API returned non-JSON response (${response.status}) path=${path}`,
        {
          status: response.status,
          responseBody: text.slice(0, 2000),
        }
      );
    }
  }
}

export function createAcumaticaClientFromEnv() {
  const authService = new AcumaticaService(
    requireEnv("ACUMATICA_BASE_URL"),
    requireEnv("ACUMATICA_CLIENT_ID"),
    requireEnv("ACUMATICA_CLIENT_SECRET"),
    requireEnv("ACUMATICA_USERNAME"),
    requireEnv("ACUMATICA_PASSWORD")
  );

  return new AcumaticaClient({
    authService,
    deliveryEndpointVersion:
      process.env.ACUMATICA_DELIVERY_ENDPOINT_VERSION?.trim() ||
      DEFAULT_DELIVERY_ENDPOINT_VERSION,
  });
}
