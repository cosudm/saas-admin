-- Identity Graph Builder (formerly FORGE — renamed; no "forge identity" language).
-- Flow stages: INGEST (graph) → RESOLVE (capabilities) → APPROVE (maker-checker) → GENERATE (package).
-- 11 schema objects. Nothing is provisioned until approved; every generated artifact links to a receipt.
-- audit receipts live in the existing audit_receipts chain (D1 has no schemas; ig.surface_bindings → ig_surface_bindings).

CREATE TABLE IF NOT EXISTS igb_intake_requests (
  id TEXT PRIMARY KEY,
  raw_text TEXT NOT NULL,
  channel TEXT DEFAULT 'text',        -- text | voice
  requested_by TEXT NOT NULL,         -- the maker
  status TEXT DEFAULT 'ingested',     -- ingested | resolved | in_review | approved | generated | rejected
  tenant_id TEXT,
  receipt_id TEXT NOT NULL,           -- INGEST receipt (fail closed)
  created_at REAL
);
CREATE TABLE IF NOT EXISTS igb_intake_facts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES igb_intake_requests(id),
  kind TEXT NOT NULL,                 -- entity | location | activity | integration | metric
  key TEXT NOT NULL,
  value TEXT,
  confidence REAL DEFAULT 1,
  resolved_code_id TEXT,              -- UDM lattice code when resolved
  resolved_jurisdiction_id TEXT,
  receipt_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS igb_capability_candidates (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES igb_intake_requests(id),
  family TEXT NOT NULL,               -- obligations | capabilities | tools | flows | connectors |
                                      -- customer_connector_configurations | prompts | agents | instructions | resources
  name TEXT NOT NULL,
  description TEXT,
  details_json TEXT,
  source TEXT,                        -- what determined this candidate (deterministic provenance)
  gated INTEGER DEFAULT 1,            -- 1 = requires maker-checker approval before generation
  status TEXT DEFAULT 'proposed',     -- proposed | approved | rejected
  receipt_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS igb_approval_reviews (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES igb_intake_requests(id),
  maker TEXT NOT NULL,
  checker TEXT,                       -- must differ from maker (enforced in service layer)
  status TEXT DEFAULT 'open',         -- open | approved | rejected
  decided_at REAL,
  receipt_id TEXT
);
CREATE TABLE IF NOT EXISTS igb_approval_items (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES igb_approval_reviews(id),
  candidate_id TEXT NOT NULL REFERENCES igb_capability_candidates(id),
  family TEXT NOT NULL,               -- the 8 approval gates are the 8 gated families
  decision TEXT DEFAULT 'pending',    -- pending | approved | rejected
  note TEXT,
  decided_by TEXT
);
CREATE TABLE IF NOT EXISTS igb_generated_packages (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES igb_intake_requests(id),
  review_id TEXT NOT NULL REFERENCES igb_approval_reviews(id),
  tenant_id TEXT,
  name TEXT,
  manifest_json TEXT NOT NULL,        -- the 10 provisioned object families
  receipt_id TEXT NOT NULL,
  created_at REAL
);
CREATE TABLE IF NOT EXISTS mcp_agents (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES igb_generated_packages(id),
  name TEXT NOT NULL,
  role TEXT,                          -- lead | specialist | gatekeeper
  intent TEXT,
  prompt_template_id TEXT,
  receipt_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_tool_manifests (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES igb_generated_packages(id),
  name TEXT NOT NULL,
  description TEXT,
  input_schema TEXT,
  governance TEXT,
  receipt_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_prompt_templates (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES igb_generated_packages(id),
  name TEXT NOT NULL,
  purpose TEXT,
  template TEXT,
  receipt_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_resources (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES igb_generated_packages(id),
  name TEXT NOT NULL,
  kind TEXT,                          -- authority | reference | dataset | documentation
  uri TEXT,
  description TEXT,
  receipt_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ig_surface_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  surface TEXT NOT NULL,              -- mcp_server | console | api
  binding_ref TEXT,                   -- e.g. proposed /mcp/{slug}
  package_id TEXT REFERENCES igb_generated_packages(id),
  receipt_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_igb_facts_req ON igb_intake_facts(request_id);
CREATE INDEX IF NOT EXISTS idx_igb_cand_req ON igb_capability_candidates(request_id);
CREATE INDEX IF NOT EXISTS idx_igb_items_review ON igb_approval_items(review_id);
CREATE INDEX IF NOT EXISTS idx_mcp_agents_pkg ON mcp_agents(package_id);
