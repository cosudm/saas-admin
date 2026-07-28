-- Segment Response + WATCH: every AI turn segmented into governed, receipted blocks.
-- Segments are captured raw; nothing becomes executable without maker-checker approval.

CREATE TABLE IF NOT EXISTS turn_segments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  conversation_id TEXT NOT NULL,
  turn_no INTEGER NOT NULL DEFAULT 1,
  seg_kind TEXT NOT NULL CHECK (seg_kind IN ('script','tool_call','instruction','resource','query')),
  lang TEXT,
  title TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'segment_response',
  status TEXT NOT NULL DEFAULT 'captured' CHECK (status IN ('captured','reviewed','promoted','discarded')),
  receipt_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seg_tenant_conv ON turn_segments(tenant_id, conversation_id, turn_no);
CREATE INDEX IF NOT EXISTS idx_seg_hash ON turn_segments(content_hash);

CREATE TABLE IF NOT EXISTS turn_compilations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  name TEXT NOT NULL,
  segment_ids_json TEXT NOT NULL,
  kinds_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','packaged')),
  created_by TEXT NOT NULL DEFAULT 'segment_response',
  approved_by TEXT,
  target_surface TEXT,
  receipt_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comp_tenant ON turn_compilations(tenant_id, status);
