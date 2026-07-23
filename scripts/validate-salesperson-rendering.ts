import { readFile } from "node:fs/promises";
import path from "node:path";

import { NotificationIntervalType } from "../lib/generated/prisma/client";
import {
  render42DayEmailConfirmationBody,
  render42DayEmailConfirmationHtmlBody,
} from "../lib/notifications/deliveryConfirmationEmail";
import {
  getSmsChangeRequestedNextStepMessage,
  getSmsInvalidDateFormatMessage,
  getSmsUnrecognizedResponseMessage,
  render42DaySmsConfirmationMessage,
} from "../lib/notifications/deliveryConfirmationSms";
import { renderDeliveryReminderEmailBody } from "../lib/notifications/deliveryReminderEmail";
import { renderDeliveryReminderMessage } from "../lib/notifications/helpers";
import {
  renderSalespersonEmailFooterText,
  renderSalespersonWebpageContactText,
} from "../lib/notifications/salespersonContactDisplay";

function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

function assertIncludes(value: string, expected: string, message: string) {
  assert(value.includes(expected), `${message}: expected "${expected}"`);
}

function assertNotIncludes(value: string, unexpected: string, message: string) {
  assert(!value.includes(unexpected), `${message}: unexpected "${unexpected}"`);
}

async function main() {
  const contact = {
    salespersonName: "John Smith",
    salespersonPhone: "8015551234",
    salespersonEmail: "john.smith@mld.com",
    isActive: true,
  };
  const footer =
    "For additional information or changes to this order, please reach out to John Smith at 801-555-1234 or john.smith@mld.com.";
  const webpageText =
    "Questions or changes? Contact John Smith at 801-555-1234 or john.smith@mld.com.";

  assert(renderSalespersonEmailFooterText(contact) === footer, "full contact footer should render");
  assert(
    renderSalespersonWebpageContactText(contact) === webpageText,
    "full contact webpage copy should render"
  );
  assert(
    renderSalespersonEmailFooterText({
      salespersonName: "John Smith",
      salespersonEmail: "john.smith@mld.com",
      isActive: true,
    }) ===
      "For additional information or changes to this order, please reach out to John Smith at john.smith@mld.com.",
    "name and email partial should render"
  );
  assert(
    renderSalespersonEmailFooterText({
      salespersonName: "John Smith",
      salespersonPhone: "8015551234",
      isActive: true,
    }) ===
      "For additional information or changes to this order, please reach out to John Smith at 801-555-1234.",
    "name and phone partial should render"
  );
  assert(
    renderSalespersonEmailFooterText({ salespersonEmail: "john.smith@mld.com", isActive: true }) ===
      "For additional information or changes to this order, please reach out to john.smith@mld.com.",
    "email-only partial should render"
  );
  assert(
    renderSalespersonEmailFooterText({ salespersonPhone: "8015551234", isActive: true }) ===
      "For additional information or changes to this order, please reach out to 801-555-1234.",
    "phone-only partial should render"
  );
  assert(
    renderSalespersonEmailFooterText({ ...contact, isActive: false }) === null,
    "inactive contact should not render"
  );
  assert(renderSalespersonEmailFooterText(null) === null, "missing contact should not render");

  const reminderBase = {
    contactName: "Customer",
    buyerGroup: "Appliance",
    jobName: "Smith Residence",
    jobAddress: "123 Main St",
    deliveryDate: "2027-01-04",
  };

  for (const intervalType of [
    NotificationIntervalType.DAY_180,
    NotificationIntervalType.DAY_90,
    NotificationIntervalType.DAY_60,
  ]) {
    const emailBody = renderDeliveryReminderEmailBody({
      ...reminderBase,
      intervalType,
      salespersonContact: contact,
    });
    assertIncludes(emailBody, footer, `${intervalType} email should include salesperson footer`);

    const smsBody = renderDeliveryReminderMessage({ ...reminderBase, intervalType });
    assertNotIncludes(smsBody, "John Smith", `${intervalType} SMS should not include salesperson name`);
    assertNotIncludes(smsBody, "john.smith@mld.com", `${intervalType} SMS should not include email`);
    assertNotIncludes(smsBody, "801-555-1234", `${intervalType} SMS should not include phone`);
  }

  const confirmationBody = render42DayEmailConfirmationBody({
    ...reminderBase,
    link: "https://delivery.example.test/confirm/token",
    salespersonContact: contact,
  });
  assertIncludes(confirmationBody, footer, "42-day email should include salesperson footer");
  assertNotIncludes(
    render42DayEmailConfirmationBody({
      ...reminderBase,
      link: "https://delivery.example.test/confirm/token",
      salespersonContact: { ...contact, isActive: false },
    }),
    footer,
    "42-day email should omit inactive contact footer"
  );
  assertIncludes(
    render42DayEmailConfirmationHtmlBody({
      ...reminderBase,
      link: "https://delivery.example.test/confirm/token",
      salespersonContact: contact,
    }),
    "john.smith@mld.com",
    "42-day HTML email should include salesperson footer"
  );

  const confirmationSms = render42DaySmsConfirmationMessage({
    ...reminderBase,
    link: "https://delivery.example.test/confirm/token",
  });
  for (const sms of [
    confirmationSms,
    getSmsInvalidDateFormatMessage(),
    getSmsUnrecognizedResponseMessage(),
    getSmsChangeRequestedNextStepMessage(),
  ]) {
    assertNotIncludes(sms, "John Smith", "SMS content should not include salesperson name");
    assertNotIncludes(sms, "john.smith@mld.com", "SMS content should not include salesperson email");
    assertNotIncludes(sms, "801-555-1234", "SMS content should not include salesperson phone");
  }
  assertIncludes(confirmationSms, "Reply Y to confirm or N", "42-day SMS route/response note remains");

  const projectRoot = path.resolve(__dirname, "..");
  const [page, block, emailRenderer, reminderEmailRenderer, intervalTestScript] =
    await Promise.all([
    readFile(path.join(projectRoot, "app/delivery/confirm/[token]/page.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/delivery/components/SalespersonContactBlock.tsx"), "utf8"),
    readFile(path.join(projectRoot, "lib/notifications/deliveryConfirmationEmail.ts"), "utf8"),
    readFile(path.join(projectRoot, "lib/notifications/deliveryReminderEmail.ts"), "utf8"),
    readFile(
      path.join(projectRoot, "scripts/manual-demo/test-interval-emails-with-salesperson.ts"),
      "utf8"
    ),
  ]);

  assert(page.includes("SalespersonContactBlock"), "confirmation webpage should render contact block");
  assert(
    block.includes("mailto:") && block.includes("display.phoneHref"),
    "webpage block should link email and phone"
  );
  for (const source of [page, block, emailRenderer, reminderEmailRenderer]) {
    assert(!source.includes("CATALOGUE_DATABASE_URL"), "rendering should not require catalogue-db");
    assert(!source.includes("fetchCatalogueSalespersonStaffUsers"), "rendering should not query catalogue-db");
  }
  assert(
    intervalTestScript.includes('requireEnv("DELIVERY_TEST_EMAIL_TO")'),
    "interval email test should require explicit DELIVERY_TEST_EMAIL_TO"
  );
  assert(
    !intervalTestScript.includes("sendDemoSms") &&
      !intervalTestScript.includes("render42DaySmsConfirmationMessage") &&
      !intervalTestScript.includes("TWILIO_"),
    "interval email test should not use SMS or Twilio"
  );
  assert(
    !intervalTestScript.includes("confirmDeliveryFromWebpage") &&
      !intervalTestScript.includes("enqueueDeliveryConfirmationAttributeWriteback"),
    "interval email/page test should not invoke Acumatica confirmation writeback"
  );
  assert(
    intervalTestScript.includes("noRealCustomerEmailSent") &&
      intervalTestScript.includes("noNotificationEventCreatedByScript"),
    "interval email test should report customer-recipient and notification-event safety"
  );

  console.log(
    JSON.stringify(
      {
        partialContactRendering: true,
        reminderEmailsIncludeSalespersonFooter: ["DAY_180", "DAY_90", "DAY_60"],
        confirmationEmailIncludesSalespersonFooter: true,
        missingOrInactiveContactOmitted: true,
        webpageBlockWired: true,
        intervalEmailTestRequiresExplicitTestRecipient: true,
        intervalEmailTestIsEmailOnly: true,
        intervalEmailTestDoesNotInvokeAcumaticaWriteback: true,
        smsSalespersonContactOmitted: true,
        normalRenderingDoesNotRequireCatalogueDb: true,
        noLiveMessagesSent: true,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
