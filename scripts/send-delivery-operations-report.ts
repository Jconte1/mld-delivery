import "dotenv/config";

import { runDeliveryOperationsReport } from "../lib/notifications/deliveryOperationsReport";
import { dateKey } from "../lib/notifications/helpers";
import { prisma } from "../lib/prisma";
import { denverDateTimeParts } from "./run-scheduled-delivery-interval";

function argValue(name: string) {
  const args = process.argv.slice(2);
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3).trim() || null;
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : null;
  return value && !value.startsWith("--") ? value.trim() || null : null;
}

async function main() {
  if (!process.argv.slice(2).includes("--send")) {
    throw new Error("--send is required because this command sends the internal operations report email");
  }
  const today = denverDateTimeParts(new Date(), "America/Denver").date;
  const reportDate = dateKey(argValue("run-date") ?? today);
  const result = await runDeliveryOperationsReport({
    reportDate,
    recipient: argValue("recipient"),
  });
  console.log(JSON.stringify({ ...result, sensitiveValuesPrinted: false }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), sensitiveValuesPrinted: false }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
