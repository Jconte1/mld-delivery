/*
  Warnings:

  - You are about to drop the column `preferredContactMethod` on the `contacts` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "contacts" DROP COLUMN "preferredContactMethod",
ADD COLUMN     "companyName" VARCHAR(256);
