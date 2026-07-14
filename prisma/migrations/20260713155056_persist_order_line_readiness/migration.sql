-- AlterTable
ALTER TABLE "order_lines" ADD COLUMN     "activeAllocatedQty" DECIMAL(18,4),
ADD COLUMN     "allocationStatus" VARCHAR(64),
ADD COLUMN     "displayStatus" VARCHAR(128),
ADD COLUMN     "etaStatus" VARCHAR(64),
ADD COLUMN     "readinessCalculatedAt" TIMESTAMP(3),
ADD COLUMN     "readinessStatus" VARCHAR(64);
