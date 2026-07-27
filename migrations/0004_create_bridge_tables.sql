-- IOS+ MCP Gateway Bridge tables.
-- Numbered 0004 so it applies cleanly after the template's 0001–0003
-- (customers/subscriptions) already recorded on the remote D1 database.
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT,
  spec_text TEXT,
  spec_url TEXT,
  tool_count INTEGER DEFAULT 0,
  created_at REAL,
  updated_at REAL
);
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  source_id TEXT,
  auth_profile_id TEXT,
  code_mode INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  rate_limit_rps REAL DEFAULT 10,
  rate_burst INTEGER DEFAULT 20,
  max_retries INTEGER DEFAULT 2,
  timeout_s REAL DEFAULT 30,
  log_level TEXT DEFAULT 'info',
  created_at REAL,
  updated_at REAL
);
CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  method TEXT,
  path TEXT,
  summary TEXT,
  description TEXT,
  input_schema TEXT,
  output_schema TEXT,
  annotations TEXT,
  governance TEXT,
  mapping TEXT,
  postprocess TEXT,
  enabled INTEGER DEFAULT 1,
  curated INTEGER DEFAULT 0,
  created_at REAL,
  updated_at REAL
);
CREATE TABLE IF NOT EXISTS auth_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  config TEXT,
  created_at REAL,
  updated_at REAL
);
CREATE TABLE IF NOT EXISTS invocations (
  id TEXT PRIMARY KEY,
  server_id TEXT,
  server_slug TEXT,
  tool_name TEXT,
  method TEXT,
  path TEXT,
  status TEXT,
  http_status INTEGER,
  latency_ms REAL,
  req_bytes INTEGER DEFAULT 0,
  resp_bytes INTEGER DEFAULT 0,
  resp_bytes_raw INTEGER DEFAULT 0,
  tokens_est INTEGER DEFAULT 0,
  tokens_saved_est INTEGER DEFAULT 0,
  error TEXT,
  args TEXT,
  via TEXT DEFAULT 'mcp',
  ts REAL
);
CREATE TABLE IF NOT EXISTS mcp_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_slug TEXT,
  level TEXT,
  logger TEXT,
  message TEXT,
  data TEXT,
  ts REAL
);
CREATE INDEX IF NOT EXISTS idx_tools_server ON tools(server_id);
CREATE INDEX IF NOT EXISTS idx_inv_ts ON invocations(ts);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON mcp_logs(ts);
