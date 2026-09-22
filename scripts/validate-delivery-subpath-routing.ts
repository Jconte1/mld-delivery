import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { GET as shortLinkGet } from "../app/c/[token]/route";
import {
  buildDeliveryConfirmationLink,
  buildShortDeliveryConfirmationLink,
} from "../lib/notifications/deliveryConfirmationLinks";
import { buildDeliveryDetailsLink } from "../lib/notifications/deliveryDetailsLinks";
import { buildTwilioStatusCallbackUrl } from "../lib/notifications/deliveryNotificationProviders";

const root = process.cwd();

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

async function main() {
  const originalBaseUrl = process.env.DELIVERY_APP_BASE_URL;

  try {
    process.env.DELIVERY_APP_BASE_URL = "https://mld-delivery.vercel.app";
    assert(
      buildDeliveryConfirmationLink("test token") ===
        "https://mld-delivery.vercel.app/delivery/confirm/test%20token",
      "host-only confirmation base must include /delivery exactly once"
    );
    assert(
      buildShortDeliveryConfirmationLink("test token") ===
        "https://mld-delivery.vercel.app/delivery/c/test%20token",
      "host-only short-link base must include /delivery exactly once"
    );
    assert(
      buildDeliveryDetailsLink("test token") ===
        "https://mld-delivery.vercel.app/delivery/details/test%20token",
      "host-only details base must include /delivery exactly once"
    );
    assert(
      buildTwilioStatusCallbackUrl({
        ...process.env,
        DELIVERY_APP_BASE_URL: "https://mld-delivery.vercel.app",
      }) === "https://mld-delivery.vercel.app/delivery/api/webhooks/twilio/message-status",
      "host-only callback base must include /delivery exactly once"
    );

    process.env.DELIVERY_APP_BASE_URL = "https://www.mld.com/delivery";
    const generatedUrls = [
      buildDeliveryConfirmationLink("test-token"),
      buildShortDeliveryConfirmationLink("test-token"),
      buildDeliveryDetailsLink("test-token"),
      buildTwilioStatusCallbackUrl({
        ...process.env,
        DELIVERY_APP_BASE_URL: "https://www.mld.com/delivery",
      }),
    ];
    assert(
      generatedUrls.every((url) => url.startsWith("https://www.mld.com/delivery/")),
      "canonical URLs must use https://www.mld.com/delivery"
    );
    assert(
      generatedUrls.every((url) => !url.includes("/delivery/delivery/")),
      "canonical URLs must not duplicate /delivery"
    );

    const shortResponse = await shortLinkGet(
      new Request("https://www.mld.com/delivery/c/test-token"),
      { params: Promise.resolve({ token: "test-token" }) }
    );
    assert(shortResponse.status === 307, "short link must return a temporary redirect");
    assert(
      shortResponse.headers.get("location") ===
        "https://www.mld.com/delivery/confirm/test-token",
      "short link must redirect to the canonical confirmation path"
    );

    assert(existsSync(join(root, "app/confirm/[token]/page.tsx")), "confirmation route missing");
    assert(existsSync(join(root, "app/details/[token]/page.tsx")), "details route missing");
    assert(!existsSync(join(root, "app/delivery/confirm/[token]/page.tsx")), "legacy nested confirmation route remains");
    assert(!existsSync(join(root, "app/delivery/details/[token]/page.tsx")), "legacy nested details route remains");

    const config = readFileSync(join(root, "next.config.ts"), "utf8");
    assert(config.includes('|| "/delivery"'), "Next basePath must default to /delivery");

    console.log(
      JSON.stringify(
        {
          ok: true,
          basePath: "/delivery",
          generatedUrls,
          shortLinkLocation: shortResponse.headers.get("location"),
          networkCalls: 0,
          databaseWrites: 0,
        },
        null,
        2
      )
    );
  } finally {
    if (originalBaseUrl === undefined) delete process.env.DELIVERY_APP_BASE_URL;
    else process.env.DELIVERY_APP_BASE_URL = originalBaseUrl;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
