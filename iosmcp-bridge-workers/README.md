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

## Notes

- Rate limiting is per-isolate (best effort at the edge). For strict global limits, back the
  token bucket with a Durable Object — the `checkRate` seam in `src/runtime.js` is the hook.
- Cognito uses `USER_PASSWORD_AUTH` via the Cognito REST API (the app client must allow it);
  full SRP would come via a DO/service binding.
- gRPC executes through JSON transcoding (Connect protocol / grpc-gateway): point the upstream
  base URL at the gateway endpoint.
- The old template's `customers`/`subscriptions` tables are left untouched in D1.

© 2026 SME Pro Technologies, Inc. · iosmcp.com · Powered by the Universal Decoding Matrix
