import { SHAREPOINT_STOCK_SOURCES } from "@/lib/sharepoint-stock/regionalStockLists";

export const SHAREPOINT_STOCK_SOURCE = SHAREPOINT_STOCK_SOURCES.utah_wyoming;

export function normalizeStockInventoryId(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  const trimmed = String(value).trim();
  if (!trimmed) return null;

  return trimmed.toUpperCase();
}
