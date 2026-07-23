import { getDeliveryGroupPaymentEvaluation } from "@/lib/delivery-payment/deliveryGroupPayment";
import { getDeliveryGroupReadiness } from "@/lib/delivery-readiness/orderLineReadiness";
import {
  formatCustomerFriendlyDate,
  formatJobAddress,
  formatJobName,
} from "@/lib/notifications/helpers";
import { getActiveSalespersonContact } from "@/lib/notifications/salespersonContactCache";
import { prisma } from "@/lib/prisma";
import { DeliveryInfoState } from "../../components/DeliveryInfoState";
import { DeliveryItemsForThisDelivery } from "../../components/DeliveryItemsForThisDelivery";
import { DeliveryPaymentSummary } from "../../components/DeliveryPaymentSummary";
import { SalespersonContactBlock } from "../../components/SalespersonContactBlock";

type PageProps = {
  params: Promise<{ token: string }>;
};

function formatLastUpdated(value: Date | null | undefined) {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(value);
}

async function loadDetails(token: string) {
  const detailsLink = await prisma.deliveryDetailsLink.findUnique({
    where: { token },
  });

  if (!detailsLink) return null;

  const group = await prisma.orderDeliveryGroup.findFirst({
    where: {
      id: detailsLink.orderDeliveryGroupId,
      deliveryDate: detailsLink.deliveryDate,
    },
    include: {
      order: {
        include: {
          address: true,
        },
      },
    },
  });

  if (!group) {
    return { detailsLink, group: null, salespersonContact: null };
  }

  const salespersonContact = await getActiveSalespersonContact(group.order.salespersonNumber);
  return { detailsLink, group, salespersonContact };
}

export default async function DeliveryDetailsPage({ params }: PageProps) {
  const { token } = await params;
  const loaded = await loadDetails(token);

  if (!loaded) {
    return (
      <DeliveryInfoState
        title="Delivery details link not found"
        message="This delivery details link could not be found. Please contact Mountain Land Design if you need current delivery details."
      />
    );
  }

  if (!loaded.group) {
    return (
      <DeliveryInfoState
        title="Delivery details unavailable"
        message="This delivery is not currently available. Please contact Mountain Land Design if you need current delivery details."
      />
    );
  }

  const group = loaded.group;
  const order = group.order;

  if (!group.isActive) {
    return (
      <DeliveryInfoState
        title="This delivery date has changed"
        message="This delivery group is no longer active. Please contact Mountain Land Design for the current delivery details."
      />
    );
  }

  // Keep this details page read-only during render; do not update lastViewedAt here.
  const readiness = await getDeliveryGroupReadiness(group.id);
  const payment = await getDeliveryGroupPaymentEvaluation(group.id);
  const scheduledDateLabel = formatCustomerFriendlyDate(group.deliveryDate);
  const jobName = formatJobName({
    customerDescription: order.customerDescription,
    locationDescription: order.locationDescription,
  });
  const jobAddress = formatJobAddress(order.address ?? {}) || "the job site";
  const deliveryDescription = order.buyerGroup ? `${order.buyerGroup} delivery` : "Delivery";
  const lastUpdated = group.lastSeenAt ?? group.lastSyncedAt ?? order.lastSyncedAt ?? null;

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <section className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
        <div className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-zinc-200">
          <p className="text-sm font-medium text-zinc-500">Delivery details</p>
          <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">{jobName}</h1>
              <p className="mt-2 text-lg text-zinc-700">
                {deliveryDescription} scheduled for {scheduledDateLabel}
              </p>
            </div>
            <div className="rounded-md bg-zinc-100 px-4 py-3 text-sm text-zinc-700">
              <div>Order #: {group.orderNumber}</div>
              <div>Last updated: {formatLastUpdated(lastUpdated)}</div>
            </div>
          </div>

          <SalespersonContactBlock contact={loaded.salespersonContact} />
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          <section className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-zinc-200">
            <h2 className="text-lg font-semibold">Delivery Details</h2>
            <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-medium text-zinc-500">Customer</dt>
                <dd className="mt-1 font-semibold text-zinc-900">
                  {order.customerDescription ?? "Not provided"}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-zinc-500">Job</dt>
                <dd className="mt-1 font-semibold text-zinc-900">
                  {order.locationDescription ?? "Not provided"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="font-medium text-zinc-500">Address</dt>
                <dd className="mt-1 font-semibold text-zinc-900">{jobAddress}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="font-medium text-zinc-500">Requested Delivery Date</dt>
                <dd className="mt-1 font-semibold text-zinc-900">{scheduledDateLabel}</dd>
              </div>
            </dl>
          </section>

          <DeliveryPaymentSummary payment={payment} />
        </div>

        <DeliveryItemsForThisDelivery
          lines={readiness.lines}
          includedLineCount={readiness.includedLineCount}
          hasActionableIssues={readiness.hasActionableIssues}
        />
      </section>
    </main>
  );
}
