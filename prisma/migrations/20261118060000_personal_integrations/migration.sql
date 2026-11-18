CREATE TABLE "IntegrationConnection" (
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL CHECK ("provider" IN ('model','kdocs','ima','tinyfish')),
    "revision" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "testedAt" TIMESTAMP(3),
    "testCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("organizationId","userId","provider"),
    CONSTRAINT "IntegrationConnection_membership_fkey" FOREIGN KEY ("organizationId","userId")
      REFERENCES "Membership"("organizationId","userId") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "Task" ADD COLUMN "modelConnectionRevision" TEXT;
