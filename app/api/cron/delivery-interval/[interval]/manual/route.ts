import { handleDeliveryIntervalCronRequest } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ interval?: string }> }
) {
  return handleDeliveryIntervalCronRequest(request, context, { manualRun: true });
}
