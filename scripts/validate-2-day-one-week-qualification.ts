function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function group(params: {
  localConfirmed?: boolean | null;
  acumaticaWritebackStatus?: string | null;
  mismatchReason?: string | null;
  acumaticaOneWeekConfirmed?: boolean | null;
}) {
  return {
    id: "group_2",
    orderId: "order_2",
    orderType: "SO",
    orderNumber: "SO2",
    deliveryDate: new Date("2026-08-01T00:00:00.000Z"),
    isActive: true,
    lineCount: 1,
    lastSeenAt: new Date("2026-07-20T00:00:00.000Z"),
    status: "Open",
    tenDayConfirmation:
      params.localConfirmed === null
        ? null
        : {
            localConfirmed: params.localConfirmed ?? false,
            acumaticaWritebackStatus: params.acumaticaWritebackStatus ?? null,
            mismatchReason: params.mismatchReason ?? null,
          },
    order: {
      id: "order_2",
      orderType: "SO",
      orderNumber: "SO2",
      status: "Open",
      internalLifecycleStatus: "ACTIVE",
      buyerGroup: "Builder",
      confirmVia: "WEBPAGE",
      acumaticaOneWeekConfirmed: params.acumaticaOneWeekConfirmed ?? false,
      salespersonNumber: "123",
      customerDescription: "Customer",
      locationDescription: "Residence",
      address: null,
      contact: {
        contactId: "contact_2",
        companyName: null,
        displayName: "Customer",
        firstName: "Customer",
        lastName: "Fixture",
        email: "customer@example.test",
        phone1: "8015551212",
        phone2: null,
        smsOptIn: true,
        emailOptIn: true,
        smsOptOuts: [],
        emailOptOuts: [],
      },
    },
  } as never;
}

async function main() {
  const failures: string[] = [];
  process.env.DATABASE_URL ||= "postgresql://validation:validation@localhost:5432/validation";
  const {
    hasRequired2DayOneWeekConfirmation,
  } = await import("../lib/notifications/create2DayDeliveryReminderEvents");

  assert(
    !hasRequired2DayOneWeekConfirmation(
      group({ localConfirmed: null, acumaticaOneWeekConfirmed: true })
    ),
    "Acumatica ONEWEEKCON true alone does not qualify 2-day",
    failures
  );
  assert(
    !hasRequired2DayOneWeekConfirmation(
      group({ localConfirmed: false, acumaticaWritebackStatus: "DRY_RUN" })
    ),
    "dry-run 10-day confirmation does not qualify 2-day",
    failures
  );
  assert(
    !hasRequired2DayOneWeekConfirmation(
      group({ localConfirmed: true, acumaticaWritebackStatus: "DRY_RUN" })
    ),
    "local confirmed with DRY_RUN status does not qualify 2-day",
    failures
  );
  assert(
    hasRequired2DayOneWeekConfirmation(
      group({ localConfirmed: true, acumaticaWritebackStatus: "WRITTEN" })
    ),
    "local confirmed with WRITTEN status qualifies 2-day",
    failures
  );
  assert(
    hasRequired2DayOneWeekConfirmation(
      group({ localConfirmed: true, acumaticaWritebackStatus: "ALREADY_TRUE" })
    ),
    "local confirmed with ALREADY_TRUE status qualifies 2-day",
    failures
  );
  assert(
    hasRequired2DayOneWeekConfirmation(
      group({
        localConfirmed: true,
        acumaticaWritebackStatus: "QUEUED",
        acumaticaOneWeekConfirmed: true,
      })
    ),
    "local confirmed plus imported Acumatica true qualifies even if previous queue status is not complete",
    failures
  );
  assert(
    !hasRequired2DayOneWeekConfirmation(
      group({
        localConfirmed: false,
        acumaticaWritebackStatus: "MISMATCH_BALANCE_DUE",
        mismatchReason: "acumatica_one_week_true_but_group_balance_due",
        acumaticaOneWeekConfirmed: true,
      })
    ),
    "mismatch/manual override does not qualify 2-day",
    failures
  );

  if (failures.length > 0) {
    console.error("2-day one-week qualification validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    "2-day one-week qualification validation passed. No SMS/email, provider dispatch, Acumatica write, or deployment was performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
