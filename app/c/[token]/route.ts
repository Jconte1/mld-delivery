import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  context: { params: Promise<{ token?: string }> }
) {
  const params = await context.params;
  const token = params.token?.trim() || "invalid";
  const target = new URL(`/delivery/confirm/${encodeURIComponent(token)}`, request.url);
  target.search = new URL(request.url).search;
  return NextResponse.redirect(target);
}
