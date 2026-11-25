-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "contextSnapshot" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "intent" TEXT NOT NULL DEFAULT 'REQUEST',
ADD COLUMN     "parentRunId" TEXT,
ADD COLUMN     "turn" INTEGER;

-- AlterTable
ALTER TABLE "Artifact" ADD COLUMN     "revisionOfId" TEXT;

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "agentId" TEXT,
    "title" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunFeedback" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "rating" TEXT,
    "comment" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Conversation_organizationId_createdBy_updatedAt_idx" ON "Conversation"("organizationId", "createdBy", "updatedAt");

-- CreateIndex
CREATE INDEX "Conversation_projectId_updatedAt_idx" ON "Conversation"("projectId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunFeedback_runId_createdBy_key" ON "RunFeedback"("runId", "createdBy");

-- CreateIndex
CREATE UNIQUE INDEX "Task_conversationId_turn_key" ON "Task"("conversationId", "turn");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunFeedback" ADD CONSTRAINT "RunFeedback_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_revisionOfId_fkey" FOREIGN KEY ("revisionOfId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Each historical task becomes an addressable conversation without changing its execution evidence.
INSERT INTO "Conversation" ("id", "organizationId", "projectId", "agentId", "title", "createdBy", "createdAt", "updatedAt")
SELECT "id", "organizationId", "projectId", NULLIF("executionSnapshot"->>'agentId', ''),
       "title", "createdBy", "createdAt", "createdAt"
FROM "Task";

UPDATE "Task" SET "conversationId" = "id", "turn" = 1;

ALTER TABLE "Task" ADD CONSTRAINT "Task_conversation_turn_check"
CHECK (("conversationId" IS NULL AND "turn" IS NULL) OR ("conversationId" IS NOT NULL AND "turn" > 0));
