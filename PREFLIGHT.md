# Pre-push preflight — IOS+ MCP Server Builder (Worker/D1)

Run this checklist before pushing to `cosudm/saas-admin`. Items 2–4 are automated and were
verified green on this build; item 1 needs your Cloudflare credentials and must be run by you.

## 1. Migration 0006 rename safety (run against LIVE D1 — requires your wrangler auth)

Migration `0006` renames the MVP's imported-API table `sources` → `api_sources` so the
first-class provenance domain owns the `sources` name. Your live `iosmcp-db` reportedly has
53 tables. Before pushing, confirm nothing business-critical already sits in a `sources` table:

```bash
npx wrangler d1 execute DB --remote --command \
  "SELECT name, sql FROM sqlite_master WHERE name IN ('sources','api_sources')"

# if a `sources` table exists, inspect it before the rename:
npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) AS rows FROM sources"
npx wrangler d1 execute DB --remote --command "SELECT * FROM sources LIMIT 3"
```

Decision rule:
- **No `sources` table** → nothing to worry about; pipeline runs 0004 (creates it), 0006 (renames it).
- **`sources` exists and is the MVP/bridge shape** (id, name, protocol, base_url, spec_text…) → safe; 0006 renames it as intended.
- **`sources` exists with different, business-critical content** → edit `0006_first_class_domains.sql`
  first: rename YOUR table to something else, or change the bridge's table name instead
  (the code references `api_sources` in `src/index.js` / `src/mcp.js`).

After 0007, the new provenance `sources` table owns authoritative source metadata
(19 sources: NAICS 2022, ISIC Rev.4, GICS, agency matrices, UDM master workbook).

## 2. Fresh local verification (automated — verified green on this build)

```bash
rm -rf .wrangler/state                       # optional: truly fresh local D1
npx wrangler d1 migrations apply DB --local  # 0004–0008 all ✅
npm test                                     # 61 passed, 0 failed
npm run dev
```

## 3. Deterministic smoke (verified green)

Against `wrangler dev`:
- `POST /mcp/ios-core` `tools/list` → exactly `graph_position, decode, determine, report_due, receipt_verify`
- `GET /api/contracts/openapi.json` → loads (OpenAPI 3.0.3, 10+ paths)
- `graph_position` (Permian Vista LLC) → DETERMINED, GI-005, receipted
- `decode` GI-005 → ISIC B-6 → NAICS 21 → GICS Energy, cited + receipted
- `determine` → 4 obligations (RRC ×3, OCD C-115), 4 citations
- `report_due` 2026-07 → 3 events, every event receipted
- `receipt_verify` → valid, chain depth 11+

## 4. Fail-closed behavior (verified green)

- unknown tenant → `NO_DETERMINATION`
- GICS-origin decode → refused (`NO_DETERMINATION`, refusal receipted)
- reverse traversal (NAICS→ISIC) → never taken (ISIC absent from bridges)
- submission without `submitted_by` → HTTP 422 ("AI drafts, a person submits")
- Identity Graph Builder: generate before approval → fail closed; checker == maker → rejected

## 5. Push

Replace the contents of `cosudm/saas-admin` with this repo, commit, push. The connected
Workers Builds pipeline runs `npm run build` → `npm run deploy` (predeploy applies
migrations 0004–0008 remotely) and ships to
`https://saas-admin.morning-cake-9876.workers.dev`.

**Release note:** Production-aligned IOS+ MCP Server Builder now enforces the five
first-class gates in code — Reg Reporting, jurisdiction containment, source provenance,
receipting, and taxonomy-boundary enforcement — plus the Identity Graph Builder
(INGEST → RESOLVE → APPROVE → GENERATE) with 8 maker-checker gates and fully
receipted package generation.
