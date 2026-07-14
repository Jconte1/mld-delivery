type OrderDeliveryGroupDelegate = {
  upsert(args: {
    where: {
      orderId_deliveryDate: {
        orderId: string;
        deliveryDate: Date;
      };
    };
    create: {
      orderId: string;
      orderNumber: string;
      orderType: string;
      deliveryDate: Date;
      status: string | null;
      isActive: boolean;
      supersededAt: null;
      supersededReason: null;
      lineCount: number;
      lastSeenAt: Date;
      lastSyncedAt: Date;
    };
    update: {
      orderNumber: string;
      orderType: string;
      deliveryDate: Date;
      status: string | null;
      isActive: boolean;
      supersededAt: null;
      supersededReason: null;
      lineCount: number;
      lastSeenAt: Date;
      lastSyncedAt: Date;
    };
  }): Promise<unknown>;
  updateMany(args: {
    where: {
      orderId: string;
      isActive: boolean;
      deliveryDate?: {
        notIn: Date[];
      };
    };
    data: {
      isActive: boolean;
      supersededAt: Date;
      supersededReason: string;
      lineCount: number;
      lastSyncedAt: Date;
    };
  }): Promise<{ count: number }>;
};

export type OrderDeliveryGroupSyncClient = {
  orderDeliveryGroup: OrderDeliveryGroupDelegate;
};

export type CurrentDeliveryGroupInput = {
  deliveryDate: Date;
  lineCount: number;
};

export type SyncOrderDeliveryGroupsResult = {
  upserted: number;
  superseded: number;
};

export async function syncOrderDeliveryGroups(
  tx: OrderDeliveryGroupSyncClient,
  params: {
    orderId: string;
    orderNumber: string;
    orderType: string;
    status: string | null;
    currentDeliveryGroups: CurrentDeliveryGroupInput[];
    importAt: Date;
  }
): Promise<SyncOrderDeliveryGroupsResult> {
  let upserted = 0;

  for (const currentGroup of params.currentDeliveryGroups) {
    const deliveryGroupData = {
      orderNumber: params.orderNumber,
      orderType: params.orderType,
      deliveryDate: currentGroup.deliveryDate,
      status: params.status,
      isActive: true,
      supersededAt: null,
      supersededReason: null,
      lineCount: currentGroup.lineCount,
      lastSeenAt: params.importAt,
      lastSyncedAt: params.importAt,
    };

    await tx.orderDeliveryGroup.upsert({
      where: {
        orderId_deliveryDate: {
          orderId: params.orderId,
          deliveryDate: currentGroup.deliveryDate,
        },
      },
      create: {
        orderId: params.orderId,
        ...deliveryGroupData,
      },
      update: deliveryGroupData,
    });
    upserted += 1;
  }

  const currentDeliveryDates = params.currentDeliveryGroups.map(
    (currentGroup) => currentGroup.deliveryDate
  );
  const superseded = await tx.orderDeliveryGroup.updateMany({
    where: {
      orderId: params.orderId,
      isActive: true,
      ...(currentDeliveryDates.length > 0
        ? { deliveryDate: { notIn: currentDeliveryDates } }
        : {}),
    },
    data: {
      isActive: false,
      supersededAt: params.importAt,
      supersededReason: "not_present_in_latest_erp_payload",
      lineCount: 0,
      lastSyncedAt: params.importAt,
    },
  });

  return {
    upserted,
    superseded: superseded.count,
  };
}
