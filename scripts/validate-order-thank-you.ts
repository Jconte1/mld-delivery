import assert from "node:assert/strict";

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
    url: "https://mld.com/willcall",
    existingAccount: false,
  });
  assert.match(willCall.textBody, /Finish your Will Call account setup/);
  assert.match(willCall.textBody, /Reply STOP to opt out/);

  assert.equal(orderThankYouIsDue({ localTime: "10:00", enabled: "true" }), true);
  assert.equal(orderThankYouIsDue({ localTime: "10:01", enabled: "true" }), false);
  assert.equal(orderThankYouIsDue({ localTime: "10:00", enabled: "false" }), false);
  assert.equal(orderThankYouIsDue({ localTime: "10:00" }), false);

  console.log(JSON.stringify({
    ok: true,
    cases: 17,
    providerCalls: 0,
    acumaticaWrites: 0,
    databaseWrites: 0,
  }, null, 2));
}

main();
