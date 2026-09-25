import { runOrderThankYou } from "../lib/notifications/orderThankYou";
import { prisma } from "../lib/prisma";

function option(args: string[], name: string) {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const preview = args.includes("--preview") || !send;
  const orderType = option(args, "--order-type") ?? null;
  const orderNumber = option(args, "--order-number") ?? null;
  if (send && args.includes("--preview")) throw new Error("Choose either --preview or --send");
  const result = await runOrderThankYou({
    send: !preview,
    orderType,
    orderNumber,
  });
  console.log(JSON.stringify({ ok: true, mode: preview ? "preview" : "send", ...result }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), sensitiveValuesPrinted: false }, null, 2));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
