import {
  formatPaymentDeadlineDate,
  getPaymentDeadlineDate,
  PAYMENT_DEADLINE_INTERVAL_DAYS,
} from "../lib/notifications/paymentDeadlineBusinessDays";

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function main() {
  const failures: string[] = [];

  assert(PAYMENT_DEADLINE_INTERVAL_DAYS === 8, "deadline interval is 8 days", failures);
  assert(
    getPaymentDeadlineDate("2026-07-30") === "2026-07-22",
    "weekday raw 8-day date stays unchanged",
    failures
  );
  assert(
    getPaymentDeadlineDate("2026-08-02") === "2026-07-24",
    "Saturday raw 8-day date moves to prior Friday",
    failures
  );
  assert(
    getPaymentDeadlineDate("2026-08-03") === "2026-07-24",
    "Sunday raw 8-day date moves to prior Friday",
    failures
  );
  assert(
    formatPaymentDeadlineDate("2026-07-30") === "Wednesday, July 22, 2026",
    "customer-facing deadline date is formatted with existing helper",
    failures
  );

  if (failures.length > 0) {
    console.error("Payment deadline business-day validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("Payment deadline business-day validation passed.");
}

main();
