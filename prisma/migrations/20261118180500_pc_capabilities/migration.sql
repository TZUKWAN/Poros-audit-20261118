ALTER TABLE "Task" ADD COLUMN "connectionRevisions" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "AgentGrantRevocation" (
  id TEXT NOT NULL PRIMARY KEY,
  "agentId" TEXT NOT NULL,
  kind "GrantKind" NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  "throughVersion" INTEGER NOT NULL,
  "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AgentGrantRevocation_agentId_kind_name_idx"
  ON "AgentGrantRevocation" ("agentId", kind, name);

CREATE TABLE "CapabilityDefinition" (
  id TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  kind "GrantKind" NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  description TEXT NOT NULL,
  instruction TEXT NOT NULL DEFAULT '',
  "fileId" TEXT,
  "projectId" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disabledAt" TIMESTAMP(3),
  "disabledBy" TEXT
);
CREATE UNIQUE INDEX "CapabilityDefinition_organizationId_kind_name_version_key"
  ON "CapabilityDefinition" ("organizationId", kind, name, version);
CREATE INDEX "CapabilityDefinition_organizationId_projectId_idx"
  ON "CapabilityDefinition" ("organizationId", "projectId");

CREATE FUNCTION poros_immutable_capability_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."organizationId", NEW.kind, NEW.name, NEW.version, NEW.description, NEW.instruction,
      NEW."fileId", NEW."projectId", NEW."createdBy", NEW."createdAt") IS DISTINCT FROM
     (OLD."organizationId", OLD.kind, OLD.name, OLD.version, OLD.description, OLD.instruction,
      OLD."fileId", OLD."projectId", OLD."createdBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'Capability version is immutable; register a new version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_capability_version BEFORE UPDATE ON "CapabilityDefinition"
  FOR EACH ROW EXECUTE FUNCTION poros_immutable_capability_version();

CREATE FUNCTION poros_immutable_correction_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."sourceEvidence" IS DISTINCT FROM OLD."sourceEvidence" THEN
    RAISE EXCEPTION 'Correction evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_correction_evidence BEFORE UPDATE ON "JudgmentRule"
  FOR EACH ROW EXECUTE FUNCTION poros_immutable_correction_evidence();
