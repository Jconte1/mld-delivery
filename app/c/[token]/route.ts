import { NextResponse } from "next/server";

import { buildDeliveryConfirmationLink } from "@/lib/notifications/deliveryConfirmationLinks";

export async function GET(
  request: Request,
  context: { params: Promise<{ token?: string }> }
) {
  const params = await context.params;
  const token = params.token?.trim() || "invalid";
  const target = new URL(buildDeliveryConfirmationLink(token));
  target.search = new URL(request.url).search;
  return NextResponse.redirect(target);
}
