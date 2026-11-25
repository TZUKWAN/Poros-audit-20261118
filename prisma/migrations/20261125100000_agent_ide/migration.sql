CREATE TABLE "IdeWorkspace" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'AGENT',
  "sourceDigest" TEXT NOT NULL DEFAULT '',
  "latestBuildId" TEXT,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "IdeWorkspace_organizationId_ownerId_updatedAt_idx" ON "IdeWorkspace"("organizationId", "ownerId", "updatedAt");
CREATE TABLE "IdeRevision" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "IdeWorkspace"("id") ON DELETE CASCADE,
  "digest" TEXT NOT NULL,
  "files" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "IdeRevision_workspaceId_digest_key" ON "IdeRevision"("workspaceId", "digest");
CREATE TABLE "IdeBuild" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "IdeWorkspace"("id") ON DELETE CASCADE,
  "sourceDigest" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "diagnostics" JSONB NOT NULL DEFAULT '[]',
  "manifest" JSONB NOT NULL DEFAULT '{}',
  "bundles" JSONB NOT NULL DEFAULT '{}',
  "previewHtml" TEXT NOT NULL DEFAULT '',
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "IdeBuild_workspaceId_createdAt_idx" ON "IdeBuild"("workspaceId", "createdAt");
CREATE TABLE "IdeJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "IdeWorkspace"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "stage" TEXT NOT NULL DEFAULT 'queued',
  "requestKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "sourceDigest" TEXT NOT NULL,
  "buildId" TEXT,
  "input" JSONB NOT NULL,
  "output" JSONB NOT NULL DEFAULT '{}',
  "events" JSONB NOT NULL DEFAULT '[]',
  "usage" JSONB NOT NULL DEFAULT '{}',
  "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "workerId" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "IdeJob_workspaceId_requestKey_key" ON "IdeJob"("workspaceId", "requestKey");
CREATE INDEX "IdeJob_status_createdAt_idx" ON "IdeJob"("status", "createdAt");
