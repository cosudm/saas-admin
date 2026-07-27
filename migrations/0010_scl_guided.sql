-- SCL v0.1 increments: semantic state tuple on receipts + lattice atlas scaffold.
ALTER TABLE audit_receipts ADD COLUMN sst TEXT;
CREATE TABLE IF NOT EXISTS lattice_atlas (
  node_id TEXT PRIMARY KEY,          -- references codes.id / jurisdictions.id / capability key
  node_kind TEXT NOT NULL,           -- code | jurisdiction | capability | entity_type
  text TEXT NOT NULL,                -- description that was embedded
  vector TEXT,                       -- JSON float array (null until atlas build runs)
  atlas_version TEXT
);
CREATE TABLE IF NOT EXISTS scl_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR REPLACE INTO scl_meta VALUES ('scl_version','0.1');
INSERT OR REPLACE INTO scl_meta VALUES ('lattice_version','L1-2026.07');
INSERT OR REPLACE INTO scl_meta VALUES ('atlas_version','none');
