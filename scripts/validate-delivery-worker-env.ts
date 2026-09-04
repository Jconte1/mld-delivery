export {};

type CheckLevel = "pass" | "warn" | "fail" | "info";

type Check = {
  level: CheckLevel;
  name: string;
  message: string;
};

const checks: Check[] = [];

function envValue(name: string) {
  return process.env[name]?.trim() ?? "";
}

function lowerEnv(name: string) {
  return envValue(name).toLowerCase();
}

function present(name: string) {
  return Boolean(envValue(name));
}

function flagTrue(name: string) {
  return lowerEnv(name) === "true";
}

function flagExplicitFalse(name: string) {
  return lowerEnv(name) === "false";
}

function add(level: CheckLevel, name: string, message: string) {
  checks.push({ level, name, message });
}

function requirePresent(name: string, purpose: string) {
  add(present(name) ? "pass" : "fail", name, `${name} is ${present(name) ? "present" : `missing for ${purpose}`}.`);
}

function requireTrue(name: string, purpose: string) {
  add(flagTrue(name) ? "pass" : "fail", name, `${name} must be exactly true for ${purpose}.`);
}

function requireFalseOrUnset(name: string, purpose: string) {
  const value = lowerEnv(name);
  add(!value || value === "false" ? "pass" : "fail", name, `${name} must be false or unset for ${purpose}.`);
}

function failIfExplicitFalse(name: string, purpose: string) {
  add(
    flagExplicitFalse(name) ? "fail" : "pass",
    name,
    flagExplicitFalse(name)
      ? `${name} is explicitly false and will block ${purpose}.`
      : `${name} is not explicitly false.`
  );
}

function reportOptionalDefault(name: string, defaultBehavior: string) {
  const value = envValue(name);
  add("info", name, value ? `${name} is set.` : `${name} is unset; default applies: ${defaultBehavior}.`);
}

function run() {
  requirePresent("DATABASE_URL", "delivery worker database access");
  requireTrue("USE_QUEUE_ERP", "fresh ERP import");
  requirePresent("MLD_QUEUE_BASE_URL", "queue-backed ERP and writeback jobs");
  requirePresent("MLD_QUEUE_TOKEN", "queue-backed ERP and writeback jobs");
  requirePresent("DELIVERY_APP_BASE_URL", "customer delivery webpage links");

  failIfExplicitFalse("DELIVERY_SCHEDULER_LIVE_SEND_ENABLED", "scheduled live worker sends");
  failIfExplicitFalse("DELIVERY_REAL_CUSTOMER_SEND_ENABLED", "real customer sends");

  if (process.env.NODE_ENV === "production" || flagTrue("DELIVERY_ALLOW_REAL_CUSTOMER_SEND_IN_NON_PRODUCTION")) {
    add("pass", "NODE_ENV", "Production send environment gate is satisfied.");
  } else {
    add(
      "fail",
      "NODE_ENV",
      "NODE_ENV must be production, or DELIVERY_ALLOW_REAL_CUSTOMER_SEND_IN_NON_PRODUCTION must be true for approved non-production shell runs."
    );
  }

  requireFalseOrUnset("DELIVERY_CONTROLLED_RECIPIENT_MODE", "real customer worker sends");
  requireFalseOrUnset("DELIVERY_FORCE_CONTACT_CHANNEL_ELIGIBILITY_FOR_TEST", "real customer worker sends");
  requireFalseOrUnset("DEMO_NOTIFICATION_SEND_ENABLED", "real customer worker sends");
  failIfExplicitFalse("TWILIO_WEBHOOK_VALIDATE_SIGNATURES", "Twilio callback verification");

  requirePresent("TWILIO_ACCOUNT_SID", "SMS sends");
  requirePresent("TWILIO_AUTH_TOKEN", "SMS sends");
  if (present("TWILIO_MESSAGING_SERVICE_SID") || present("TWILIO_FROM_NUMBER")) {
    add("pass", "TWILIO_FROM", "Twilio sender is configured.");
  } else {
    add("fail", "TWILIO_FROM", "TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER is required for SMS sends.");
  }

  for (const name of [
    "MS_GRAPH_TENANT_ID",
    "MS_GRAPH_CLIENT_ID",
    "MS_GRAPH_CLIENT_SECRET",
    "MS_GRAPH_FROM_EMAIL",
  ]) {
    requirePresent(name, "email sends");
  }

  reportOptionalDefault("DELIVERY_CONFIRMATION_WRITEBACK_DRY_RUN", "live writeback unless explicitly true");
  reportOptionalDefault("DELIVERY_REQUESTED_DATE_WRITEBACK_DRY_RUN", "live requested-date writeback unless explicitly true");
  reportOptionalDefault("DELIVERY_TEN_DAY_CONFIRMATION_WRITEBACK_DRY_RUN", "live 10-day confirmation writeback unless explicitly true");
  reportOptionalDefault("DELIVERY_CONTACT_OPT_IN_WRITEBACK_DRY_RUN", "live contact opt-in writeback unless explicitly true");
  reportOptionalDefault("DELIVERY_PREPAYMENT_HOLD_DRY_RUN", "live hold unless explicitly true");
  reportOptionalDefault("DELIVERY_NOTIFICATION_WORKER_INTERVAL_MS", "60000");

  const failed = checks.filter((check) => check.level === "fail");
  const warned = checks.filter((check) => check.level === "warn");
  const result = {
    ok: failed.length === 0,
    failed: failed.length,
    warnings: warned.length,
    checks,
    sensitiveValuesPrinted: false,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

run();
