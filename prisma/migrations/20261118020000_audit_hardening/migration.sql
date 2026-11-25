-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TaskStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "TaskStatus" ADD VALUE 'TIMED_OUT';

-- AlterTable
ALTER TABLE "AgentDefinition" ADD COLUMN     "versionCounter" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "AgentVersion" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "manifest" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "AgentGrant" ADD COLUMN     "source" TEXT NOT NULL DEFAULT '@deepseek-ai/dsh',
ADD COLUMN     "version" TEXT NOT NULL DEFAULT '0.2.2-rc.1';

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "executionSnapshot" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "leaseUntil" TIMESTAMP(3),
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "requestHash" TEXT,
ADD COLUMN     "requestKey" TEXT,
ADD COLUMN     "timeoutMs" INTEGER NOT NULL DEFAULT 180000,
ADD COLUMN     "workerId" TEXT;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "usage" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "payload" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "JudgmentRule" ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "disabledBy" TEXT,
ADD COLUMN     "familyId" TEXT,
ADD COLUMN     "previousId" TEXT;

-- Existing rule IDs define their own revision families. No historical grant is fabricated.
UPDATE "JudgmentRule" SET "familyId" = "id";
ALTER TABLE "JudgmentRule" ALTER COLUMN "familyId" SET NOT NULL;
UPDATE "AgentDefinition" a SET "versionCounter" = COALESCE((SELECT MAX(v.version) FROM "AgentVersion" v WHERE v."agentId"=a.id), 0);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DownloadTicket" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "DownloadTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "id" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_status_availableAt_idx" ON "Task"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "Task_organizationId_createdBy_requestKey_key" ON "Task"("organizationId", "createdBy", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "JudgmentRule_familyId_version_key" ON "JudgmentRule"("familyId", "version");

-- Publication content is immutable, even through accidental service updates.
CREATE FUNCTION poros_immutable_agent_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."agentId" <> OLD."agentId" OR NEW.version <> OLD.version OR NEW.config <> OLD.config OR NEW.manifest <> OLD.manifest OR NEW."publishedBy" <> OLD."publishedBy" THEN
    RAISE EXCEPTION 'Published Agent content is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_agent_version BEFORE UPDATE ON "AgentVersion" FOR EACH ROW EXECUTE FUNCTION poros_immutable_agent_version();

CREATE FUNCTION poros_immutable_rule_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rule <> OLD.rule OR NEW.version <> OLD.version OR NEW."familyId" <> OLD."familyId" OR NEW."scopeType" <> OLD."scopeType" OR NEW."scopeId" <> OLD."scopeId" OR NEW.kind <> OLD.kind OR NEW."sourceFeedback" <> OLD."sourceFeedback" OR NEW."sourceRunId" <> OLD."sourceRunId" THEN
    RAISE EXCEPTION 'Rule revision is immutable; create a new revision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_rule_revision BEFORE UPDATE ON "JudgmentRule" FOR EACH ROW EXECUTE FUNCTION poros_immutable_rule_revision();

