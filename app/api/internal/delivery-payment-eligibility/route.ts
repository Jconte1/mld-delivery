import { prisma } from "@/lib/prisma";
import { checkPaymentWriteEligibility, paymentWriteAuthorized } from "@/lib/notifications/paymentWriteEligibility";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!paymentWriteAuthorized(request.headers.get("authorization"), process.env.MLD_QUEUE_TOKEN)) {
    return Response.json({ eligible: false, reason: "unauthorized" }, { status: 401 });
  }
  try {
    const text = await request.text();
    if (text.length > 8192) return Response.json({ eligible: false, reason: "invalid_request" }, { status: 400 });
    const input = JSON.parse(text);
    if (!input || !["hold", "clearance"].includes(input.operation) ||
        ![input.orderType, input.orderNumber, input.contactId].every(value => typeof value === "string" && value.trim() && value.length <= 64) ||
        typeof input.deliveryDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.deliveryDate) ||
        Number.isNaN(Date.parse(input.deliveryDate)) || !input.contact ||
        typeof input.contact.smsOptIn !== "boolean" || typeof input.contact.emailOptIn !== "boolean" ||
        ![input.contact.phone1, input.contact.phone2, input.contact.email].every(value => typeof value === "string" && value.length <= 256)) {
      return Response.json({ eligible: false, reason: "invalid_request" }, { status: 400 });
    }
    return Response.json(await checkPaymentWriteEligibility(input, prisma));
  } catch {
    return Response.json({ eligible: false, reason: "eligibility_check_unavailable" }, { status: 503 });
  }
}
