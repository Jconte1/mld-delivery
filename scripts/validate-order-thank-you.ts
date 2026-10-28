import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectNotificationChannel } from "../lib/notifications/helpers";

import { OrderThankYouClassification } from "../lib/generated/prisma/client";
import {
  classifyThankYouShipVia,
  orderThankYouIsDue,
  parseThankYouCandidate,
} from "../lib/notifications/orderThankYou";
import {
  renderDeliveryThankYou,
  renderWillCallThankYou,
} from "../lib/notifications/orderThankYouTemplates";

function main() {
  const parsed = parseThankYouCandidate({
    OrderType: "SO",
    OrderNbr: "SO12345",
    Status: "Open",
    ShipVia: "DELIVERY SLC",
    RequestedOn: "2026-11-03T00:00:00Z",
    CustomerID: "BA0000001",
    PostalCode: "84101",
    AttributeTHANKYOU: false,
    AttributeEMAILNOTY: "legacy@example.com",
  });
  assert(parsed);
  assert.equal(parsed.orderType, "SO");
  assert.equal(parsed.orderNumber, "SO12345");
  assert.equal(parsed.thankYouAlreadySent, false);
  assert.equal(classifyThankYouShipVia("DELIVERY SLC"), OrderThankYouClassification.DELIVERY);
  assert.equal(classifyThankYouShipVia("WILL CALL JX"), OrderThankYouClassification.WILL_CALL);
  assert.equal(classifyThankYouShipVia("TRANS JACKSON"), OrderThankYouClassification.WILL_CALL);
  assert.equal(classifyThankYouShipVia("UNKNOWN"), null);

  const standard = renderDeliveryThankYou({
    orderNumber: "SO12345",
    requestedDeliveryDate: new Date("2026-11-03T00:00:00Z"),
    withinSixWeeks: false,
  });
  assert.match(standard.textBody, /send reminders as your delivery approaches/i);
  assert.match(standard.textBody, /six weeks before delivery/i);
  assert.match(standard.textBody, /confirm your delivery date or request a later date/i);
  assert.match(standard.textBody, /Reply STOP to opt out/);
  assert.match(standard.textBody, /Tuesday, November 3, 2026/);

  const short = renderDeliveryThankYou({
    orderNumber: "SO12345",
    requestedDeliveryDate: new Date("2026-10-01T00:00:00Z"),
    withinSixWeeks: true,
  });
  assert.match(short.textBody, /within six weeks/i);
  assert.match(short.textBody, /contact you soon/i);

  const willCall = renderWillCallThankYou({
    orderNumber: "SO12345",
    orderType: "SO",
    customerName: "Example Construction",
    locationName: "Main Street Job",
  });
  assert.equal(willCall.subject, "Appliance | SO12345 | Example Construction | Main Street Job");
  assert.match(willCall.textBody, /Appliance order #SO12345 for Example Construction \/ Main Street Job has been received/);
  assert.match(willCall.textBody, /\n\nWe will let you know when your order is ready for pickup\.\n\n/);
  assert.match(willCall.textBody, /Reply STOP to opt out/);
  assert.match(willCall.htmlBody, /We will let you know when your order is ready for pickup\./);
  assert.doesNotMatch(willCall.textBody, /https?:|register|registration|dashboard|account|log in/i);
  assert.doesNotMatch(willCall.htmlBody, /<a\b|register|registration|dashboard|account|log in/i);
  const primary = renderWillCallThankYou({ orderNumber: "PL12345", orderType: "PL",
    customerName: "Smith & Sons", locationName: "Primary Location" });
  assert.equal(primary.subject, "Plumbing | PL12345 | Smith & Sons");
  assert.doesNotMatch(primary.textBody, /Primary Location/);
  assert.match(primary.htmlBody, /Smith &amp; Sons/);
  const minimal = renderWillCallThankYou({ orderNumber: "HW12345", orderType: "HW" });
  assert.match(minimal.textBody, /Hardware order #HW12345 for Customer/);
  assert.equal(selectNotificationChannel({ smsOptIn: true, phone1: "8015550123", email: null }).selectedChannel, "SMS");
  assert.equal(selectNotificationChannel({ smsOptIn: true, phone1: "8015550123", emailOptIn: true,
    email: "example@example.com" }).selectedChannel, "SMS");
  assert.equal(selectNotificationChannel({ emailOptIn: true, email: "example@example.com" }).selectedChannel, "EMAIL");
  assert.equal(selectNotificationChannel({ phone1: "8015550123", email: "example@example.com" }).selectedChannel, null);
  const runner = readFileSync(new URL("../lib/notifications/orderThankYou.ts", import.meta.url), "utf8");
  assert.doesNotMatch(runner, /getWillCallUrl|WILLCALL_BACKEND_URL|WILLCALL_INVITE_TOKEN|WILLCALL_FRONTEND_URL|invites\/dispatch|will_call_customer_id_billing_zip_or_email_missing/);

  assert.equal(orderThankYouIsDue({ localTime: "10:00", enabled: "true" }), true);
  assert.equal(orderThankYouIsDue({ localTime: "10:01", enabled: "true" }), false);
  assert.equal(orderThankYouIsDue({ localTime: "10:00", enabled: "false" }), false);
  assert.equal(orderThankYouIsDue({ localTime: "10:00" }), false);

  console.log(JSON.stringify({
    ok: true,
    coverage: "report parsing, classification, delivery copy, link-free Will Call copy, SMS-first selection, removed invite dependency, schedule gate",
    providerCalls: 0,
    acumaticaWrites: 0,
    databaseWrites: 0,
  }, null, 2));
}

main();
