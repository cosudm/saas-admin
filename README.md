# IOS+ MCP Gateway Bridge — Cloudflare Workers Edition

**Intent in. Governed server out.** The Gateway Bridge turns any existing API — REST, GraphQL,
SOAP, or gRPC — into typed, governed MCP tools any LLM client can discover and invoke, running
entirely on Cloudflare Workers + D1. Powered by the Universal Decoding Matrix.

## Deploying over the existing `saas-admin` Worker

This repo is a drop-in replacement for `cosudm/saas-admin`. It keeps the same:

- Worker name (`saas-admin`) — deploys to the same `*.workers.dev` route
- D1 binding (`DB` → `iosmcp-db`, id `771f3439-f3bc-41b3-b498-1f7fc2c4fa19`)
- CI script names (`npm run build` → `npm run deploy`, with `predeploy` running D1 migrations)

So the connected Workers Builds pipeline deploys it with **no configuration changes**: replace
the repo contents with these files, commit, and push. Migrations `0004` (bridge tables) and
`0005` (UDM crosswalk seed) apply on top of the template's `0001–0003` already recorded remotely.

```bash
# local development
npm install
npm run db:migrate:local
npm run dev            # http://localhost:8787

# manual deploy (CI does this on push)
npm run deploy         # runs remote migrations, then wrangler deploy
```

## What's inside

| Route | What it is |
| --- | --- |
| `/` | Governed console (IOSMCP design system, single static file) |
| `/api/*` | Admin API — import/preview/commit, servers, tools, auth profiles, analytics, invocations, MCP logs, UDM registry, manifest export |
| `/mcp/{slug}` | Live MCP endpoint per bridge — JSON-RPC 2.0 over Streamable HTTP (`initialize`, `tools/list`, `tools/call`, `ping`, `logging/setLevel`) |
| `/demo-api/*` | Bundled WellView demo target API + OpenAPI spec, for the zero-dependency end-to-end loop |
| `/api/udm` | Universal Decoding Matrix crosswalk (88 industries: ISIC Rev.4 anchor → NAICS 2022 + GICS bridges), seeded from `Universal Decoding Matrix_Master.xlsx` |

Capabilities (ported 1:1 from the FastAPI MVP): schema importers for OpenAPI 3.x/Swagger 2
(JSON + YAML), GraphQL (SDL + live introspection), WSDL, gRPC `.proto`; typed tool generation
with behavioural annotations and governance labels; runtime validation, parameter mapping,
auth injection (Bearer, Basic, API Key, OAuth2 client-credentials, Cognito), token-bucket rate
limiting, retries with backoff, per-tool response post-processing with token-savings accounting;
Code Mode (3 meta-tools, ~98% less context); analytics (p50/p95 latency, throughput, tokens,
error mix); receipts on every invocation; structured MCP logs.

## The 60-second loop

1. Open the console → **Import API** → *Load the WellView sample* → **Generate governed tools** → **Deploy as MCP server**.
2. Connect a client to the endpoint:
   ```bash
   claude mcp add --transport http wellview https://saas-admin.morning-cake-9876.workers.dev/mcp/wellview-field-api
   ```
3. Or smoke-test:
   ```bash
   curl -s https://saas-admin.morning-cake-9876.workers.dev/mcp/wellview-field-api \
     -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

## First-class domains (production alignment)

Migrations `0006`/`0007` add the five first-class domains from the Universal Decoding Matrix
model, seeded from the master workbook (Industry Crosswalk, Reg Reporting, Jurisdiction
Overlay, Source Notes):

- **Taxonomy boundaries** — `code_systems` (UDM-GI ontology → ISIC anchor → NAICS bridge →
  GICS presentation), `codes`, `crosswalk_edges` (292, all cited), `boundary_rules` (12 gates).
  Traversals that violate a gate (e.g. originating from GICS, or reverse NAICS→ISIC) return
  `NO_DETERMINATION` — the matrix **fails closed**, and the refusal itself is receipted.
- **Jurisdiction containment** — `jurisdictions` tree (country → state → parish/county),
  `regulatory_bodies` (28 state agencies), `authority_scopes`.
- **Reg Reporting** — `reporting_forms` (72), `reporting_requirements` (72),
  `reporting_events`, `submissions`, `evidence_artifacts`. `receipt_id` is NOT NULL on events
  and submissions: no obligation state exists without a receipt. AI drafts; a human submits
  (`submitted_by` is required).
- **Source provenance** — `sources` (19 authoritative), `citations`, `source_snapshots`.
  The `/api/prov/coverage` gate reports `fully_sourced` and tests fail closed on gaps.
- **Receipting** — `audit_receipts` (SHA-256 input/output hashes + chain hash linked to the
  previous receipt), `receipt_edges`, `audit_invocations`. `/api/receipts/{id}/verify`
  recomputes the chain back to genesis; any tamper breaks it.

**`/mcp/ios-core`** exposes the deterministic tool surface to any MCP client:
`graph_position`, `decode`, `determine`, `report_due`, `receipt_verify` — deterministic,
cited, receipted; `_meta` carries the `receipt_id` on every call. AI renders and routes;
this engine originates obligations and decides truth.

Contracts for all IG/UDM/audit objects: `GET /api/contracts/openapi.json` (request/response
schemas + examples). Console screens: **Reg Reporting** (determine → materialize receipted
events → human submit) and **Governance Review** (receipt chain verification + boundary gates).

Run the fail-closed test suite (41 assertions) against a dev server:

```bash
npm run dev            # terminal 1
npm test               # terminal 2 — taxonomy boundaries, receipt chain,
                       # jurisdiction paths, source coverage, reporting completeness
```


## Identity Graph Builder (LENS surface)

Migration `0008` adds the builder pipeline — **INGEST (graph) → RESOLVE (capabilities) →
APPROVE (maker-checker) → GENERATE (package)** — with 11 schema objects (`igb_*`, `mcp_agents`,
`mcp_tool_manifests`, `mcp_prompt_templates`, `mcp_resources`, `ig_surface_bindings`).
The user describes their business in natural language on the LENS screen; deterministic
extraction produces onboarding facts; facts resolve through the UDM into an Identity Graph;
the graph proposes the 10 provisioned object families (agents, obligations, capabilities,
tools, flows, connectors, customer connector configurations, instructions, prompts,
resources). 8 families are approval-gated: **nothing is provisioned until a checker
(distinct from the maker) approves**, generation fails closed otherwise, and every generated
artifact links to a receipt chained back through approval → resolve → ingest.
Console: **Identity Graph Builder** under Gateway Bridge. API: `/api/igb/*`.

See `PREFLIGHT.md` for the pre-push checklist.

## Notes

- Rate limiting is per-isolate (best effort at the edge). For strict global limits, back the
  token bucket with a Durable Object — the `checkRate` seam in `src/runtime.js` is the hook.
- Cognito uses `USER_PASSWORD_AUTH` via the Cognito REST API (the app client must allow it);
  full SRP would come via a DO/service binding.
- gRPC executes through JSON transcoding (Connect protocol / grpc-gateway): point the upstream
  base URL at the gateway endpoint.
- The old template's `customers`/`subscriptions` tables are left untouched in D1.
- Migration `0006` renames the MVP's imported-API table `sources` → `api_sources` so the
  first-class provenance domain owns the `sources` name. **Before pushing**, confirm your live
  D1 doesn't already have a different `sources` table you care about (you mentioned 53 live
  tables) — if it does, adjust the rename in `0006` accordingly.
- D1 is the current dev/admin store and future edge projection layer; the schema is
  Hyperdrive-ready for the planned PlanetScale source-of-truth (plain SQL, no D1-only
  features beyond the migration runner).

© 2026 SME Pro Technologies, Inc. · iosmcp.com · Powered by the Universal Decoding Matrix
