export const SHAREPOINT_STOCK_SOURCE = "sharepoint_stock_list";

export function normalizeStockInventoryId(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  const trimmed = String(value).trim();
  if (!trimmed) return null;

  return trimmed.toUpperCase();
}
