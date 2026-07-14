import {
  getDeliveryGroupPaymentEvaluation,
  getDeliveryGroupPaymentEvaluationByOrderDate,
} from "../lib/delivery-payment/deliveryGroupPayment";
import { prisma } from "../lib/prisma";

type ParsedArgs =
  | {
      mode: "deliveryGroupId";
      deliveryGroupId: string;
    }
  | {
      mode: "orderDate";
      orderType: string;
      orderNumber: string;
      deliveryDate: string;
    };

function parseArgs(argv: string[]): ParsedArgs {
  const values: Record<string, string> = {};
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("--delivery-group-id=")) {
      values.deliveryGroupId = arg.slice("--delivery-group-id=".length);
      continue;
    }
    if (arg.startsWith("--order-delivery-group-id=")) {
      values.deliveryGroupId = arg.slice("--order-delivery-group-id=".length);
      continue;
    }
    if (arg.startsWith("--order-type=")) {
      values.orderType = arg.slice("--order-type=".length);
      continue;
    }
    if (arg.startsWith("--order-number=")) {
      values.orderNumber = arg.slice("--order-number=".length);
      continue;
    }
    if (arg.startsWith("--delivery-date=")) {
      values.deliveryDate = arg.slice("--delivery-date=".length);
      continue;
    }
    if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  if (values.deliveryGroupId) {
    return { mode: "deliveryGroupId", deliveryGroupId: values.deliveryGroupId };
  }

  const orderType = values.orderType ?? positional[0];
  const orderNumber = values.orderNumber ?? positional[1];
  const deliveryDate = values.deliveryDate ?? positional[2];

  if (!orderType || !orderNumber || !deliveryDate) {
    throw new Error(
      "Usage: tsx scripts/inspect-delivery-group-payment.ts --order-type=SO --order-number=SO39963 --delivery-date=2026-07-24"
    );
  }

  return { mode: "orderDate", orderType, orderNumber, deliveryDate };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result =
    args.mode === "deliveryGroupId"
      ? await getDeliveryGroupPaymentEvaluation(args.deliveryGroupId)
      : await getDeliveryGroupPaymentEvaluationByOrderDate(args);

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
