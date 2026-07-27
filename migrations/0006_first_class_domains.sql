-- First-class domains for the IOS+ production-aligned MCP Server Builder.
-- Principles enforced by this schema:
--   * Identity Graph is tenant-specific position (ig_*).
--   * UDM is a tenant-independent reference lattice (code_systems/codes/crosswalk_edges).
--   * Every determination, tool invocation, reporting event and surface binding
--     carries a receipt (audit_receipts chain, fail-closed).
--   * Taxonomy traversal is governed by boundary_rules (fail closed on violation).

-- The MVP's imported-API-schema table was named `sources`; the first-class
-- provenance domain owns that name now. Rename the MVP table (code updated in step).
ALTER TABLE sources RENAME TO api_sources;

-- ============================== Taxonomy boundaries ==============================
CREATE TABLE IF NOT EXISTS code_systems (
  id TEXT PRIMARY KEY,               -- e.g. UDM-GI | ISIC | NAICS | GICS
  name TEXT NOT NULL,
  version TEXT,
  role TEXT NOT NULL,                -- ontology | anchor | bridge | presentation
  rationale TEXT
);
CREATE TABLE IF NOT EXISTS codes (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES code_systems(id),
  code TEXT NOT NULL,
  title TEXT,
  parent_code_id TEXT,
  UNIQUE (system_id, code)
);
CREATE TABLE IF NOT EXISTS crosswalk_edges (
  id TEXT PRIMARY KEY,
  from_code_id TEXT NOT NULL REFERENCES codes(id),
  to_code_id TEXT NOT NULL REFERENCES codes(id),
  edge_type TEXT NOT NULL,           -- ontology_bridge | concordance
  status TEXT DEFAULT 'ontology_bridge',
  source_id TEXT                     -- provenance is mandatory in practice; tests fail closed on NULL
);
CREATE TABLE IF NOT EXISTS boundary_rules (
  id TEXT PRIMARY KEY,
  from_system TEXT NOT NULL,
  to_system TEXT NOT NULL,
  allowed INTEGER NOT NULL,          -- 0 = forbidden (fail closed), 1 = allowed
  via TEXT,                          -- required intermediate path, e.g. 'ISIC>NAICS'
  rationale TEXT
);

-- ============================== Jurisdiction containment ==============================
CREATE TABLE IF NOT EXISTS jurisdictions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- country | state | parish | county | district
  parent_id TEXT REFERENCES jurisdictions(id)
);
CREATE TABLE IF NOT EXISTS regulatory_bodies (
  id TEXT PRIMARY KEY,
  acronym TEXT,
  name TEXT NOT NULL,
  jurisdiction_id TEXT REFERENCES jurisdictions(id),
  filing_system TEXT,
  notes TEXT,
  source_url TEXT
);
CREATE TABLE IF NOT EXISTS authority_scopes (
  id TEXT PRIMARY KEY,
  body_id TEXT NOT NULL REFERENCES regulatory_bodies(id),
  domain TEXT NOT NULL,              -- e.g. oil_gas
  scope_note TEXT
);

-- ============================== Source provenance ==============================
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  publisher TEXT,
  url TEXT,
  license_note TEXT,
  retrieved_at TEXT
);
CREATE TABLE IF NOT EXISTS citations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  subject_type TEXT NOT NULL,        -- code | crosswalk_edge | reporting_form | requirement | determination
  subject_id TEXT NOT NULL,
  locator TEXT                       -- sheet/row/section within the source
);
CREATE TABLE IF NOT EXISTS source_snapshots (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  taken_at TEXT,
  content_hash TEXT
);

-- ============================== Reg Reporting ==============================
CREATE TABLE IF NOT EXISTS reporting_forms (
  id TEXT PRIMARY KEY,
  body_id TEXT NOT NULL REFERENCES regulatory_bodies(id),
  form_code TEXT NOT NULL,
  title TEXT,
  category TEXT,
  submission_channel TEXT,
  expected_format TEXT,
  instructions TEXT,
  source_url TEXT
);
CREATE TABLE IF NOT EXISTS reporting_requirements (
  id TEXT PRIMARY KEY,
  body_id TEXT NOT NULL REFERENCES regulatory_bodies(id),
  form_id TEXT REFERENCES reporting_forms(id),
  name TEXT NOT NULL,
  frequency TEXT NOT NULL,           -- monthly | quarterly | annual | event
  due_rule TEXT,                     -- authoritative textual rule from the matrix
  domain TEXT DEFAULT 'oil_gas',
  source_id TEXT REFERENCES sources(id)
);
CREATE TABLE IF NOT EXISTS reporting_events (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES reporting_requirements(id),
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL,              -- YYYY-MM or YYYY
  due_date TEXT,
  status TEXT DEFAULT 'open',        -- open | draft | submitted | accepted
  receipt_id TEXT NOT NULL,          -- fail closed: no event without a receipt
  UNIQUE (requirement_id, tenant_id, period)
);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES reporting_events(id),
  submitted_at TEXT,
  submitted_by TEXT,                 -- always a human — AI drafts, a person submits
  method TEXT,
  status TEXT DEFAULT 'draft',
  receipt_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence_artifacts (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  kind TEXT,
  uri TEXT,
  content_hash TEXT
);

-- ============================== Receipting ==============================
CREATE TABLE IF NOT EXISTS audit_receipts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- decode | graph_position | determination | report_due | tool_invocation | submission
  subject TEXT,
  tenant_id TEXT,
  input_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  citations_json TEXT,
  prev_receipt_id TEXT,
  chain_hash TEXT NOT NULL,
  created_at REAL
);
CREATE TABLE IF NOT EXISTS receipt_edges (
  id TEXT PRIMARY KEY,
  from_receipt_id TEXT NOT NULL REFERENCES audit_receipts(id),
  to_receipt_id TEXT NOT NULL REFERENCES audit_receipts(id),
  relation TEXT                      -- derived_from | evidences | supersedes
);
CREATE TABLE IF NOT EXISTS audit_invocations (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES audit_receipts(id),
  invocation_id TEXT                 -- links to the MCP invocations receipt log
);

-- ============================== Identity Graph (tenant position) ==============================
CREATE TABLE IF NOT EXISTS ig_tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at REAL
);
CREATE TABLE IF NOT EXISTS ig_nodes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES ig_tenants(id),
  kind TEXT NOT NULL,                -- industry_position | jurisdiction | flag | metric
  key TEXT NOT NULL,
  value_json TEXT,
  code_id TEXT REFERENCES codes(id)  -- when the node is a canonical code position
);

CREATE INDEX IF NOT EXISTS idx_codes_system ON codes(system_id);
CREATE INDEX IF NOT EXISTS idx_xwalk_from ON crosswalk_edges(from_code_id);
CREATE INDEX IF NOT EXISTS idx_bodies_jur ON regulatory_bodies(jurisdiction_id);
CREATE INDEX IF NOT EXISTS idx_forms_body ON reporting_forms(body_id);
CREATE INDEX IF NOT EXISTS idx_reqs_body ON reporting_requirements(body_id);
CREATE INDEX IF NOT EXISTS idx_events_tenant ON reporting_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_receipts_chain ON audit_receipts(prev_receipt_id);
CREATE INDEX IF NOT EXISTS idx_ig_nodes_tenant ON ig_nodes(tenant_id);
