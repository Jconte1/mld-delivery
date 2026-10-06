import "dotenv/config";

import { buildDeliveryOperationsReport, runDeliveryOperationsReport } from "../lib/notifications/deliveryOperationsReport";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
  const send = process.argv.slice(2).includes("--send");
  const preview = process.argv.slice(2).includes("--preview");
  if (send === preview) throw new Error("Choose exactly one of --preview or --send");
  const today = denverDateTimeParts(new Date(), "America/Denver").date;
  const reportDate = dateKey(argValue("run-date") ?? today);
  if (preview) {
    const report = await buildDeliveryOperationsReport(reportDate);
    const dir = resolve(argValue("output-dir") ?? "artifacts");
    await mkdir(dir, { recursive: true });
    const stem = resolve(dir, `delivery-recap-${reportDate}`);
    await writeFile(`${stem}.xlsx`, report.workbook);
    await writeFile(`${stem}.html`, report.htmlBody);
    await writeFile(`${stem}.json`, JSON.stringify({ summary: report.summary, sheets: report.sheets }, null, 2));
    console.log(JSON.stringify({ ok: true, preview: true, ...report.summary, workbook: `${stem}.xlsx`, html: `${stem}.html`, sends: 0, databaseWrites: 0 }, null, 2));
    return;
  }
  const result = await runDeliveryOperationsReport({
    reportDate,
    recipient: argValue("recipient"),
    retryFailed: process.argv.slice(2).includes("--retry-failed"),
  });
  console.log(JSON.stringify({ ...result, sensitiveValuesPrinted: false }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), sensitiveValuesPrinted: false }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
