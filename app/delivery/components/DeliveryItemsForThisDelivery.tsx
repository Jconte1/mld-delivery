import type { OrderLineReadinessSummary } from "@/lib/delivery-readiness/orderLineReadiness";
import { dateKey } from "@/lib/notifications/helpers";

function quantity(value: number | string | { toString(): string } | null | undefined) {
  if (value === null || value === undefined) return "";
  const numeric = Number(value.toString());
  if (!Number.isFinite(numeric)) return value.toString();
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
}

function statusClass(status: string | null | undefined) {
  switch (status) {
    case "ready":
    case "complete":
      return "bg-emerald-50 text-emerald-800 ring-emerald-200";
    case "eta_pending":
    case "expected_on_time":
      return "bg-amber-50 text-amber-800 ring-amber-200";
    case "backordered":
    case "partially_allocated":
      return "bg-rose-50 text-rose-800 ring-rose-200";
    default:
      return "bg-zinc-100 text-zinc-700 ring-zinc-200";
  }
}

export function DeliveryItemsForThisDelivery({
  lines,
  includedLineCount,
  hasActionableIssues,
}: {
  lines: OrderLineReadinessSummary[];
  includedLineCount: number;
  hasActionableIssues: boolean;
}) {
  return (
    <section className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-zinc-200">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Items For This Delivery</h2>
          <p className="mt-1 text-sm text-zinc-600">
            {includedLineCount} included lines,{" "}
            {hasActionableIssues ? "some items need review" : "items look ready or complete"}.
          </p>
        </div>
      </div>
      <div className="mt-5 overflow-x-auto">
        <table className="min-w-full divide-y divide-zinc-200 text-sm">
          <thead>
            <tr className="text-left text-zinc-500">
              <th className="py-3 pr-4 font-medium">Line</th>
              <th className="py-3 pr-4 font-medium">Item</th>
              <th className="py-3 pr-4 font-medium">Qty</th>
              <th className="py-3 pr-4 font-medium">Open</th>
              <th className="py-3 pr-4 font-medium">ETA</th>
              <th className="py-3 pr-4 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {lines.map((line) => (
              <tr key={line.lineNbr} className="align-top">
                <td className="py-3 pr-4 text-zinc-500">{line.lineNbr}</td>
                <td className="py-3 pr-4">
                  <div className="font-medium text-zinc-900">
                    {line.inventoryId ?? "Item"}
                  </div>
                  <div className="mt-1 max-w-xl text-zinc-600">
                    {line.lineDescription}
                  </div>
                </td>
                <td className="py-3 pr-4">{quantity(line.orderQty)}</td>
                <td className="py-3 pr-4">{quantity(line.openQty)}</td>
                <td className="py-3 pr-4">{line.eta ? dateKey(line.eta) : "Pending"}</td>
                <td className="py-3 pr-4">
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${statusClass(
                      line.readinessStatus
                    )}`}
                  >
                    {line.displayStatus ?? "Not calculated"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
