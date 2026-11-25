ALTER TABLE "IntegrationConnection" DROP CONSTRAINT "IntegrationConnection_provider_check";
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_provider_check"
CHECK (
  "provider" IN ('model', 'kdocs', 'ima', 'tinyfish')
  OR "provider" ~ '^ide:[A-Za-z0-9_-]{1,120}:(model|mcp:[a-z][a-z0-9-]{0,39}|api:[a-z][a-z0-9-]{0,39})$'
);
