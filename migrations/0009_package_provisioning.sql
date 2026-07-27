-- GENERATE → auto-provision: an approved Identity Graph Builder package now
-- materializes a live MCP server. Package-provisioned servers carry their
-- package and tenant so tool calls execute against the governed core engine.
ALTER TABLE servers ADD COLUMN package_id TEXT;
ALTER TABLE servers ADD COLUMN tenant_id TEXT;
