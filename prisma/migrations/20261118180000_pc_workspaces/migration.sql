-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('MANAGER', 'CONTRIBUTOR', 'VIEWER');
ALTER TYPE "ApprovalDecision" ADD VALUE 'WITHDRAWN';

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "disabledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "ProjectMember" ADD COLUMN     "role" "ProjectRole" NOT NULL DEFAULT 'CONTRIBUTOR';

-- AlterTable
ALTER TABLE "AgentDefinition" ADD COLUMN     "draftOrigin" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "generationModel" TEXT,
ADD COLUMN     "projectRestricted" BOOLEAN NOT NULL DEFAULT false;

-- The old format did not record which model or template produced a draft.
UPDATE "AgentDefinition" SET "draftOrigin" = 'LEGACY_NL' WHERE "nlSource" IS NOT NULL;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "acceptedBy" TEXT,
ADD COLUMN     "acceptedRunId" TEXT;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "modelId" TEXT,
ALTER COLUMN "modelGateway" SET DEFAULT 'pending';

-- AlterTable
ALTER TABLE "Artifact" ADD COLUMN     "runId" TEXT;

-- AlterTable
ALTER TABLE "FileObject" ADD COLUMN     "category" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "JudgmentRule" ADD COLUMN     "sourceEvidence" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "AgentProject" (
    "agentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "AgentProject_pkey" PRIMARY KEY ("agentId","projectId")
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskInput" (
    "taskId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,

    CONSTRAINT "TaskInput_pkey" PRIMARY KEY ("taskId","fileId")
);

-- CreateTable
CREATE TABLE "FileUse" (
    "runId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "chars" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileUse_pkey" PRIMARY KEY ("runId","fileId")
);

-- CreateIndex
CREATE INDEX "AuditEntry_organizationId_projectId_createdAt_idx" ON "AuditEntry"("organizationId", "projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_runId_key" ON "Artifact"("runId");

-- AddForeignKey
ALTER TABLE "AgentProject" ADD CONSTRAINT "AgentProject_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProject" ADD CONSTRAINT "AgentProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskInput" ADD CONSTRAINT "TaskInput_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskInput" ADD CONSTRAINT "TaskInput_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileUse" ADD CONSTRAINT "FileUse_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileUse" ADD CONSTRAINT "FileUse_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
