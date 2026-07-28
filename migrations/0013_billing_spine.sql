-- Billing spine (frozen spec): integer micro-cents everywhere, deterministic
-- idempotency, receipted adjustments. past_due pauses NEW provisioning only —
-- reads and existing servers keep working.

CREATE TABLE IF NOT EXISTS billing_plans (
  id TEXT PRIMARY KEY,                -- plan_free | plan_builder | plan_pro
  name TEXT NOT NULL,
  base_ucents INTEGER NOT NULL DEFAULT 0,        -- monthly base, micro-cents (1e-6 cent)
  included_calls INTEGER NOT NULL DEFAULT 0,     -- invocations included per period
  overage_ucents_per_call INTEGER NOT NULL DEFAULT 0,
  max_servers INTEGER,                            -- NULL = unlimited
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_accounts (
  tenant_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES billing_plans(id),
  status TEXT NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','canceled')),
  finix_identity_id TEXT,             -- buyer identity at Finix (platform/sub-merchant model)
  finix_instrument_id TEXT,           -- tokenized payment instrument; raw card data never stored
  trial_start TEXT,
  period_anchor TEXT,                 -- YYYY-MM-DD the billing month anchors on
  carry_ucents INTEGER NOT NULL DEFAULT 0,   -- sub-cent remainder carried forward (never floats)
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_rollups (
  id TEXT PRIMARY KEY,                -- roll_<tenant>_<period> — DETERMINISTIC (idempotency key)
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL,               -- YYYY-MM
  calls INTEGER NOT NULL DEFAULT 0,
  tools_provisioned INTEGER NOT NULL DEFAULT 0,
  servers_live INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  UNIQUE(tenant_id, period)
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,                -- inv_<tenant>_<period> — DETERMINISTIC (idempotency key)
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  base_ucents INTEGER NOT NULL,
  overage_calls INTEGER NOT NULL DEFAULT 0,
  overage_ucents INTEGER NOT NULL DEFAULT 0,
  carry_in_ucents INTEGER NOT NULL DEFAULT 0,
  total_ucents INTEGER NOT NULL,      -- base + overage + carry_in
  charge_cents INTEGER NOT NULL,      -- floor(total_ucents / 1e6) * 100-cent units actually charged
  carry_out_ucents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','paid','failed','void')),
  finix_transfer_id TEXT,
  receipt_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, period)
);

CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- webhook_received | charge_submitted | charge_settled | charge_failed | adjustment | status_change
  tenant_id TEXT,
  invoice_id TEXT,
  external_id TEXT,                   -- Finix event/transfer id — UNIQUE prevents webhook replay double-apply
  payload_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(external_id)
);

INSERT OR IGNORE INTO billing_plans (id,name,base_ucents,included_calls,overage_ucents_per_call,max_servers,active,created_at) VALUES
 ('plan_free','Free — one governed server',0,500,0,1,1,datetime('now')),
 ('plan_builder','Builder — $49/mo',4900000000,10000,50000,5,1,datetime('now')),
 ('plan_pro','Pro — $199/mo',19900000000,100000,25000,NULL,1,datetime('now'));
