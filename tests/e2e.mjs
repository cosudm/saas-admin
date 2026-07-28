/* First-class domain test suite — runs against a live dev server (npm run dev).
   Usage: node tests/e2e.mjs [baseUrl]        (default http://127.0.0.1:8788)
   Every test FAILS CLOSED: uncertain or partial states are failures. */
const BASE = process.argv[2] || "http://127.0.0.1:8788";
let passed = 0, failed = 0;
const ok = (cond, name, detail = "") => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};
const get = async p => (await fetch(BASE + p)).json();
const post = async (p, body) => (await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const rpc = async (slug, method, params) => (await post(`/mcp/${slug}`, { jsonrpc: "2.0", id: 1, method, params })).result;

console.log("\n1. Taxonomy boundaries — fail closed");
{
  const good = await post("/api/udm/decode", { system: "UDM-GI", code: "GI-005" });
  ok(good.status === "DETERMINED", "UDM-GI:GI-005 decodes", good.reason);
  ok(good.bridges?.ISIC?.length >= 1 && good.bridges?.NAICS?.length >= 1 && good.bridges?.GICS?.length >= 1,
    "decode reaches ISIC (anchor), NAICS (bridge), GICS (presentation)");
  ok((good.citations || []).length >= 1, "decode is cited");
  ok(!!good.receipt_id, "decode is receipted");
  const bad = await post("/api/udm/decode", { system: "GICS", code: "Energy" });
  ok(bad.status === "NO_DETERMINATION", "GICS-origin decode FAILS CLOSED", JSON.stringify(bad).slice(0, 120));
  ok(!!bad.receipt_id, "the refusal itself is receipted");
  const unknown = await post("/api/udm/decode", { system: "UDM-GI", code: "GI-999" });
  ok(unknown.status === "NO_DETERMINATION", "unknown code → NO_DETERMINATION (closed world)");
  const badSys = await post("/api/udm/decode", { system: "SIC", code: "1311" });
  ok(badSys.status === "NO_DETERMINATION", "unknown code system → NO_DETERMINATION");
  const rules = await get("/api/udm/boundaries");
  ok(rules.some(r => r.from_system === "GICS" && !r.allowed), "GICS-origin boundary rules exist and are forbidden");
  ok(rules.some(r => r.from_system === "NAICS" && r.to_system === "ISIC" && !r.allowed), "reverse NAICS→ISIC traversal forbidden");
}

console.log("\n2. Receipt chain — deterministic, tamper-evident");
{
  const a = await post("/api/udm/decode", { system: "UDM-GI", code: "GI-002" });
  const b = await post("/api/udm/decode", { system: "UDM-GI", code: "GI-002" });
  ok(a.output_hash === b.output_hash, "same input ⇒ same output hash (deterministic)", `${a.output_hash?.slice(0, 8)} vs ${b.output_hash?.slice(0, 8)}`);
  ok(a.receipt_id !== b.receipt_id, "distinct receipts per call");
  const v = await post(`/api/receipts/${b.receipt_id}/verify`, {});
  ok(v.valid === true, "receipt chain verifies back toward genesis", v.error);
  ok(v.depth >= 2, "chain depth ≥ 2 (receipts are chained)", `depth=${v.depth}`);
  const fake = await post("/api/receipts/rcpt_doesnotexist/verify", {});
  ok(fake.valid === false, "unknown receipt fails verification");
}

console.log("\n3. Jurisdiction containment paths");
{
  const p = await get("/api/jurisdictions/jur_caddo_parish/path");
  ok(p.depth === 3, "Caddo Parish → Louisiana → United States (depth 3)", JSON.stringify(p).slice(0, 120));
  ok(p.path?.[1]?.name === "Louisiana" && p.path?.[2]?.kind === "country", "path order parish→state→country");
  const tx = await get("/api/jurisdictions/jur_texas/path");
  ok(tx.depth === 2 && tx.path[1].id === "jur_us", "Texas → United States (depth 2)");
}

console.log("\n4. Source provenance coverage");
{
  const c = await get("/api/prov/coverage");
  ok(c.crosswalk_edges.total > 200 && c.crosswalk_edges.sourced === c.crosswalk_edges.total,
    "every crosswalk edge carries provenance", JSON.stringify(c.crosswalk_edges));
  ok(c.reporting_forms.sourced === c.reporting_forms.total, "every reporting form carries an official source URL");
  ok(c.reporting_requirements.sourced === c.reporting_requirements.total, "every requirement carries a source");
  ok(c.fully_sourced === true, "coverage gate: fully_sourced === true (fail closed otherwise)");
  const srcs = await get("/api/prov/sources");
  ok(srcs.length >= 15, "authoritative source registry seeded", `${srcs.length} sources`);
}

console.log("\n5. Reporting completeness — determinations and receipted events");
{
  const det = await post("/api/reg/determine", { tenant_id: "ten_permianvista" });
  ok(det.status === "DETERMINED", "demo tenant obligations determined", det.reason);
  const bodies = new Set(det.determinations.map(d => d.body));
  ok(bodies.has("RRC") && bodies.has("OCD"), "TX (RRC) and NM (OCD) obligations attach via jurisdiction containment", [...bodies].join(","));
  ok(det.determinations.every(d => d.form && d.authority?.source_url), "every determination names a form and an official authority URL");
  ok((det.citations || []).length >= 2 && !!det.receipt_id, "determination is cited and receipted");
  const due = await post("/api/reg/report-due", { tenant_id: "ten_permianvista", period: "2026-07" });
  ok(due.status === "DETERMINED" && due.count >= 1, "report_due materializes events", `count=${due.count}`);
  ok(due.events.every(e => !!e.receipt_id), "EVERY reporting event carries a receipt_id (fail closed)");
  const evs = await get("/api/reg/events?tenant_id=ten_permianvista");
  ok(evs.length >= 1 && evs.every(e => !!e.receipt_id), "persisted events all receipted");
  const ver = await post(`/api/receipts/${due.events[0].receipt_id}/verify`, {});
  ok(ver.valid === true, "event receipt chains back through determination → position", ver.error);
  // unknown tenant fails closed
  const nd = await post("/api/reg/determine", { tenant_id: "ten_nobody" });
  ok(nd.status === "NO_DETERMINATION", "unknown tenant → NO_DETERMINATION");
}

console.log("\n6. ios-core MCP surface");
{
  const init = await rpc("ios-core", "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "e2e" }, capabilities: {} });
  ok(init?.serverInfo?.title?.includes("IOS+ Core"), "ios-core initializes");
  const tl = await rpc("ios-core", "tools/list", {});
  const names = (tl?.tools || []).map(t => t.name);
  ok(["graph_position", "decode", "determine", "report_due", "receipt_verify"].every(n => names.includes(n)),
    "all five core tools exposed", names.join(","));
  const gp = await rpc("ios-core", "tools/call", { name: "graph_position", arguments: { tenant_id: "ten_permianvista" } });
  const gpBody = JSON.parse(gp.content[0].text);
  ok(gpBody.status === "DETERMINED" && gpBody.industry_positions?.[0]?.code === "GI-005", "graph_position returns canonical position");
  ok(!!gp._meta?.["iosmcp.core"]?.receipt_id, "MCP tool invocation carries receipt_id in _meta");
  const dec = await rpc("ios-core", "tools/call", { name: "decode", arguments: { system: "GICS", code: "Energy" } });
  ok(JSON.parse(dec.content[0].text).status === "NO_DETERMINATION", "core decode fails closed over MCP too");
  const rv = await rpc("ios-core", "tools/call", { name: "receipt_verify", arguments: { receipt_id: gp._meta["iosmcp.core"].receipt_id } });
  ok(JSON.parse(rv.content[0].text).valid === true, "receipt_verify over MCP validates the invocation receipt");
}

console.log("\n7. MVP protocol preserved");
{
  const contracts = await get("/api/contracts/openapi.json");
  ok(contracts.openapi === "3.0.3" && Object.keys(contracts.paths).length >= 9, "OpenAPI contract document served");
  const ov = await get("/api/overview");
  ok(typeof ov.servers === "number" && ov.analytics, "MVP admin API intact");
  const spec = await get("/demo-api/openapi-spec.json");
  ok(spec.info.title === "WellView Field API", "demo API intact");
}

console.log("\n8. Identity Graph Builder — INGEST → RESOLVE → APPROVE → GENERATE");
{
  const text = "We are Yellow Rose Operating LLC, an oil and gas operator with 40 wells in Texas and New Mexico. " +
    "We handle monthly production reporting and regulatory filings, and we use Excel and QuickBooks.";
  const intake = await post("/api/igb/intake", { text, requested_by: "J. Hayes" });
  ok(intake.status === "in_review", "intake lands in maker-checker review", intake.detail && intake.status);
  const kinds = Object.fromEntries((intake.facts || []).map(f => [f.kind, true]));
  ok(kinds.entity && kinds.location && kinds.activity && kinds.integration,
    "facts extracted: entity, locations, activities, integrations", JSON.stringify(kinds));
  ok(intake.facts.some(f => String(f.value).includes("GI-005")), "industry resolves to GI-005 through the UDM");
  ok(!!intake.receipt_id && !!intake.ingest_receipt_id, "INGEST and RESOLVE both receipted");
  const reqId = intake.request_id, reviewId = intake.review_id;
  const detail = await get(`/api/igb/requests/${reqId}`);
  const fams = new Set(detail.candidates.map(c => c.family));
  ok(fams.size === 10, "all 10 provisioned object families proposed", [...fams].join(","));
  const gatedFams = new Set(detail.candidates.filter(c => c.gated).map(c => c.family));
  ok(gatedFams.size === 8, "8 approval gates (gated families)", [...gatedFams].join(","));
  ok(detail.candidates.some(c => c.family === "obligations" && c.name.startsWith("RRC")), "obligations derived from determination (RRC)");
  // fail closed: generate before approval
  const early = await post(`/api/igb/requests/${reqId}/generate`, {});
  ok(!!early.detail && /Fail closed/i.test(early.detail), "GENERATE before approval FAILS CLOSED", JSON.stringify(early).slice(0, 100));
  // fail closed: maker cannot check their own work
  const selfCheck = await post(`/api/igb/reviews/${reviewId}/decide`, { checker: "J. Hayes", approve_all: true });
  ok(!!selfCheck.detail && /Maker-checker/i.test(selfCheck.detail), "checker == maker REJECTED (maker-checker)");
  // proper approval
  const decided = await post(`/api/igb/reviews/${reviewId}/decide`, { checker: "C. Miguez", approve_all: true });
  ok(decided.status === "approved" && decided.pending === 0, "distinct checker approves all gates");
  const gen = await post(`/api/igb/requests/${reqId}/generate`, {});
  ok(gen.status === "generated" && !!gen.receipt_id, "package generated after approval, receipted");
  ok(Object.keys(gen.manifest.families).length === 10, "manifest carries the 10 families");
  ok(gen.manifest.families.agents.length >= 2 && gen.manifest.families.tools.length >= 1, "agents + tools materialized");
  const pkg = await get(`/api/igb/packages/${gen.package_id}`);
  const arts = pkg.artifacts;
  const allReceipted = [...arts.agents, ...arts.tools, ...arts.prompts, ...arts.resources, ...arts.bindings]
    .every(a => !!a.receipt_id);
  ok(allReceipted, "EVERY generated artifact links to a receipt");
  ok(arts.bindings.length === 1 && arts.bindings[0].binding_ref.startsWith("/mcp/"), "ig_surface_bindings proposes the MCP endpoint");
  const rv = await post(`/api/receipts/${gen.receipt_id}/verify`, {});
  ok(rv.valid === true, "package receipt chains back through approval → resolve → ingest", rv.error);
  // ---- auto-provisioned live MCP server ----
  ok(!!gen.endpoint && gen.endpoint.startsWith("/mcp/"), "GENERATE auto-provisions a live MCP endpoint", gen.endpoint);
  const slug = gen.endpoint.split("/").pop();
  const tl2 = await rpc(slug, "tools/list", {});
  ok((tl2?.tools || []).length >= 3, "provisioned server lists its governed tools", (tl2?.tools || []).map(t => t.name).join(","));
  const gp2 = await rpc(slug, "tools/call", { name: "identity_lookup_run", arguments: {} });
  const gpBody = JSON.parse(gp2.content[0].text);
  ok(gpBody.status === "DETERMINED" && gpBody.industry_positions?.some(p => p.code === "GI-005"),
    "identity_lookup_run answers from the tenant's Identity Graph");
  ok(!!gp2._meta?.["iosmcp.core"]?.receipt_id, "provisioned tool calls are receipted");
  const rr = await rpc(slug, "tools/call", { name: "regulatory_reporting_run", arguments: { period: "2026-08" } });
  const rrBody = JSON.parse(rr.content[0].text);
  ok(rrBody.status === "DETERMINED" && rrBody.events?.length >= 1 && rrBody.events.every(e => e.receipt_id),
    "reporting tool materializes receipted events via the core engine", rrBody.reason);
  const gs = await rpc(slug, "tools/call", { name: "governed_search_run", arguments: { query: "production" } });
  const gsBody = JSON.parse(gs.content[0].text);
  ok(gsBody.status === "DETERMINED" && (gsBody.obligation_matches?.length || gsBody.lattice_matches?.length),
    "governed_search_run searches the closed world only");
  const bindTool = (tl2.tools || []).find(t => !["identity_lookup_run","governed_search_run","segment_response"].includes(t.name) && !/report|filing|tax/.test(t.name));
  if (bindTool) {
    const ci = await rpc(slug, "tools/call", { name: bindTool.name, arguments: {} });
    const ciBody = JSON.parse(ci.content[0].text);
    ok(ciBody.status === "PROVISIONED_PENDING_BINDING" && !!ciBody.receipt_id,
      "unbound capability reports pending connector binding (receipted, never guesses)", bindTool.name);
  }
}

console.log("\n9. Extraction precision — weak-token regression");
{
  // "production reporting" in oil/gas context must reinforce GI-005 only — never GI-052/GI-087
  const og = await post("/api/igb/intake", {
    text: "We are Caddo Basin Energy LLC, an oil and gas operator with 25 wells in Louisiana and Texas. We handle monthly production reporting and severance tax, and we use Excel and SAP.",
    requested_by: "Regression" });
  const ogInd = og.facts.filter(f => f.resolved_code_id).map(f => String(f.value).split(" — ")[0]);
  ok(ogInd.length === 1 && ogInd[0] === "GI-005", "oil/gas 'production reporting' → GI-005 only", ogInd.join(","));
  ok(!ogInd.includes("GI-052") && !ogInd.includes("GI-087"), "no GI-052 (media) or GI-087 (household) false positives");
  // media context still reaches GI-052 via its own strong terms
  const media = await post("/api/igb/intake", {
    text: "We are Lone Star Studios, a film and television production company in Texas making music and video content.",
    requested_by: "Regression" });
  const mInd = media.facts.filter(f => f.resolved_code_id).map(f => String(f.value).split(" — ")[0]);
  ok(mInd.includes("GI-052"), "media context still maps to GI-052 via film/video/television/music terms", mInd.join(","));
  ok(!mInd.includes("GI-005"), "media context does not leak into GI-005");
}

console.log("\n10. Guided intake (Easy Setup) — clicks are facts, SST pinned");
{
  const opts = await get("/api/igb/options");
  ok(opts.industries.length >= 80 && opts.states.length >= 25, "options serve the full lattice pick-lists",
    `${opts.industries.length} industries, ${opts.states.length} states`);
  const g = await post("/api/igb/intake", { requested_by: "Jane Doe", auto_approve: true,
    selections: { org_name: "Jane's Corner Store", industry_codes: ["GI-046"], states: ["jur_texas"],
      activities: ["invoicing", "scheduling"], integrations: ["quickbooks"] } });
  ok(g.status === "approved" || g.status === "in_review", "guided intake runs the same pipeline", g.detail?.request?.status);
  ok(g.facts.some(f => f.resolved_code_id) || g.facts.some(f => String(f.value).includes("GI-046")),
    "clicked industry lands as pre-resolved lattice fact");
  const gen = await post(`/api/igb/requests/${g.request_id}/generate`, {});
  ok(gen.status === "generated" && gen.endpoint, "guided flow generates a live endpoint", gen.detail || gen.endpoint);
  const bad = await post("/api/igb/intake", { requested_by: "Jane Doe",
    selections: { industry_codes: ["GI-999"], states: ["jur_texas"] } });
  ok(!!bad.detail && /not in the lattice/.test(bad.detail), "invalid clicked node FAILS CLOSED");
  const rc = await get(`/api/receipts/${gen.receipt_id}`);
  ok(!!rc.sst && JSON.parse(typeof rc.sst === "string" ? rc.sst : JSON.stringify(rc.sst)).scl === "0.1",
    "receipts carry the Semantic State Tuple (SST)");
}

console.log("\n11. Deployment determination + workflow CAPTURE/REPLAY");
{
  // Chris Carter-style guided intake with a profiled tool (enverus), an add-in tool (excel), and an unprofiled one (dynamics)
  const g = await post("/api/igb/intake", { requested_by: "Chris Carter", auto_approve: true,
    selections: { org_name: "Carter Operating", industry_codes: ["GI-005"], states: ["jur_texas"],
      activities: ["production reporting"], integrations: ["enverus", "excel", "dynamics"] } });
  const gen = await post(`/api/igb/requests/${g.request_id}/generate`, {});
  ok(gen.status === "generated", "operator intake generates", gen.detail);
  const rec = await post("/api/deploy/recommend", { tenant_id: g.tenant_id });
  ok(rec.status === "DETERMINED" && rec.paths[0].artifact.includes("MCP connector"), "MCP connector ranks first (zero integration)");
  const env = rec.paths.find(p => p.technology === "enverus");
  ok(env && /web service/i.test(env.artifact), "Enverus → web service sync (APIs, no plugin host)", env?.artifact);
  const xl = rec.paths.find(p => p.technology === "excel");
  ok(xl && /add-in/i.test(xl.artifact), "Excel → Office add-in");
  const dyn = rec.paths.find(p => p.technology === "dynamics");
  ok(dyn && dyn.status === "NO_PROFILE" && dyn.demand_signal, "unprofiled tool FAILS CLOSED as demand signal");
  ok((rec.citations || []).length >= 2 && !!rec.receipt_id, "deployment determination is cited and receipted");
  // CAPTURE from a real trace, REPLAY for a new period
  const due = await post("/api/reg/report-due", { tenant_id: g.tenant_id, period: "2026-09" });
  ok(due.status === "DETERMINED", "trace to capture exists", due.reason);
  const cap = await post("/api/workflows/capture", { receipt_id: due.receipt_id, name: "Monthly obligation cycle" });
  ok(cap.status === "captured" && cap.steps.length >= 2 && !!cap.receipt_id, "receipt chain captured as generalized package", JSON.stringify(cap.steps));
  const rp = await post(`/api/workflows/${cap.package_id}/replay`, { tenant_id: g.tenant_id, period: "2026-10" });
  ok(rp.status === "DETERMINED" && rp.steps.every(s => s.receipt_id), "replay executes for a new period, every step receipted");
  const bad = await post(`/api/workflows/${cap.package_id}/replay`, { tenant_id: "ten_nobody", period: "2026-10" });
  ok(bad.status === "INCOMPLETE", "replay for unknown tenant FAILS CLOSED mid-chain");
}

console.log("\n12. Segment Response + WATCH");
{
  const RUN = Math.random().toString(36).slice(2, 8); // unique conversation ids so local re-runs don't collide with dedup
  const TURN = [
    "Deploy landed. Here's what to do next:",
    "1. Run the deploy from the site folder.",
    "2. Verify production picked it up.",
    "```powershell",
    "cd C:\\work\\site",
    "wrangler pages deploy . --project-name ediefile --branch main",
    "```",
    "Then check https://ediefile.pages.dev/data/tx/dir.json and https://dash.cloudflare.com for status.",
    "```json",
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"report_due","arguments":{"period":"2026-09"}}}',
    "```",
    "Does the Google sign-in work on the custom domain?",
  ].join("\n");
  const s1 = await post("/api/watch/segment", { text: TURN, conversation_id: "conv-a-"+RUN, turn_no: 1, source: "test" });
  ok(s1.status === "SEGMENTED", "turn segments", s1.detail);
  ok((s1.counts.script || 0) >= 1, "code fence → script", JSON.stringify(s1.counts));
  ok((s1.counts.tool_call || 0) >= 1, "JSON-RPC fence → tool_call");
  ok((s1.counts.resource || 0) >= 2, "URLs → resources");
  ok((s1.counts.instruction || 0) >= 1, "numbered/imperative lines → instructions");
  ok((s1.counts.query || 0) >= 1, "question line → query");
  ok(!!s1.receipt_id, "segmentation is receipted");
  const s1b = await post("/api/watch/segment", { text: TURN, conversation_id: "conv-a-"+RUN, turn_no: 1, source: "test" });
  ok(s1b.stored === 0 && s1b.skipped_duplicates >= 5, "identical re-segmentation stores nothing (deterministic hashes dedup)");
  const s2 = await post("/api/watch/segment", { text: TURN, conversation_id: "conv-b-"+RUN, turn_no: 3, source: "test" });
  ok(s2.stored >= 5, "same turn in a second conversation stores fresh segments");
  const mm = await get("/api/watch/matches");
  ok(mm.matches.length >= 3, "recurring segments across conversations surface in WATCH", `got ${mm.matches.length}`);
  const empty = await (await fetch(BASE + "/api/watch/segment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "   " }) })).json();
  ok(!!empty.detail && /fail closed/i.test(empty.detail), "empty turn FAILS CLOSED");
  // compile + maker-checker
  const comp = await post("/api/watch/compile", { name: "Deploy & verify flow", segment_ids: s1.segment_ids.slice(0, 3), created_by: "console" });
  ok(comp.status === "draft" && !!comp.receipt_id, "selection compiles to a draft package", comp.detail);
  const selfApprove = await (await fetch(BASE + `/api/watch/compilations/${comp.compilation_id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approver: "console" }) })).json();
  ok(!!selfApprove.detail && /checker must differ/i.test(selfApprove.detail), "creator cannot approve own compilation (maker-checker FAILS CLOSED)");
  const appr = await post(`/api/watch/compilations/${comp.compilation_id}/approve`, { approver: "governance@iosmcp.com" });
  ok(appr.status === "approved" && !!appr.receipt_id, "distinct checker approves, receipted");
  const badComp = await (await fetch(BASE + "/api/watch/compile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x", segment_ids: ["seg_nope"] }) })).json();
  ok(!!badComp.detail && /not found/i.test(badComp.detail), "compiling unknown segment FAILS CLOSED");
  // segment_response as a live tool on a provisioned server
  const g = await post("/api/igb/intake", { requested_by: "Watch Tester", auto_approve: true,
    selections: { org_name: "Watch Test Co", industry_codes: ["GI-005"], states: ["jur_texas"], activities: ["production reporting"], integrations: [] } });
  const gen = await post(`/api/igb/requests/${g.request_id}/generate`, {});
  const slug = gen.endpoint.replace("/mcp/", "");
  const tl = await rpc(slug, "tools/list", {});
  ok(tl.tools.some(t => t.name === "segment_response"), "every provisioned server exposes segment_response");
  const call = await rpc(slug, "tools/call", { name: "segment_response", arguments: { text: TURN, conversation_id: "conv-mcp-"+RUN, turn_no: 1 } });
  const body = JSON.parse(call.content[0].text);
  ok(body.status === "SEGMENTED" && body.stored >= 5, "AI client turn → segments via MCP, tenant-scoped", call.content[0].text.slice(0, 120));
  ok(!!call._meta?.["iosmcp.core"]?.receipt_id, "MCP segmentation carries the receipt in _meta");
  const segs = await get(`/api/watch/segments?tenant_id=${g.tenant_id}`);
  ok(segs.length >= 5 && segs.every(x => x.tenant_id === g.tenant_id), "segments landed under the server's tenant identity graph");
}

console.log("\n13. Billing spine — integer money, idempotency, HMAC fail-closed, past_due gate");
{
  const { createHmac } = await import("node:crypto");
  const RB = Math.random().toString(36).slice(2, 8);
  const plans = await get("/api/billing/plans");
  ok(plans.length >= 3 && plans.every(p => Number.isInteger(p.base_ucents)), "plans seeded with integer micro-cents");
  // tenant with real usage from earlier sections
  const g = await post("/api/igb/intake", { requested_by: "Bill Payer", auto_approve: true,
    selections: { org_name: "Billing Test Co", industry_codes: ["GI-005"], states: ["jur_texas"], activities: ["production reporting"], integrations: [] } });
  const gen1 = await post(`/api/igb/requests/${g.request_id}/generate`, {});
  ok(gen1.status === "generated", "billing test tenant provisions while account is in good standing", gen1.detail);
  const period = "2026-07";
  const r1 = await post(`/api/billing/accounts/${g.tenant_id}/rollup`, { period });
  const r2 = await post(`/api/billing/accounts/${g.tenant_id}/rollup`, { period });
  ok(!!r1.receipt_id && r2.idempotent === true, "rollup is receipted and idempotent (deterministic id)");
  const inv = await post(`/api/billing/accounts/${g.tenant_id}/invoice`, { period });
  ok(Number.isInteger(inv.total_ucents) && Number.isInteger(inv.charge_cents) && Number.isInteger(inv.carry_out_ucents),
    "invoice money is integers end to end");
  ok(inv.total_ucents === inv.charge_cents * 1000000 + inv.carry_out_ucents, "charge + carry reconstructs total exactly (no float drift)");
  const inv2 = await post(`/api/billing/accounts/${g.tenant_id}/invoice`, { period });
  ok(inv2.idempotent === true, "invoice is idempotent — re-running a cron cannot double-bill");
  // webhook: unsigned → refused before any state change
  const bad = await fetch(BASE + "/api/billing/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "evt_forged_"+RB, type: "transfer.succeeded" }) });
  ok(bad.status === 401, "unsigned webhook FAILS CLOSED with 401");
  const sign = body => "sha256=" + createHmac("sha256", "devtestsecret").update(body).digest("hex");
  const failBody = JSON.stringify({ id: "evt_fail_"+RB, type: "transfer.failed", tags: { invoice_id: inv.id || inv2.id, tenant_id: g.tenant_id } });
  const wf = await fetch(BASE + "/api/billing/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Finix-Signature": sign(failBody) }, body: failBody });
  ok((await wf.json()).status === "processed", "HMAC-verified charge_failed webhook processes");
  const acct = await get(`/api/billing/accounts/${g.tenant_id}`);
  ok(acct.status === "past_due", "failed charge marks the account past_due");
  // past_due pauses NEW provisioning only
  const g2 = await post("/api/igb/intake", { requested_by: "Bill Payer", auto_approve: true,
    selections: { org_name: "Billing Test Co", industry_codes: ["GI-005"], states: ["jur_texas"], activities: ["compliance"], integrations: [] } });
  const blocked = await (await fetch(BASE + `/api/igb/requests/${g2.request_id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  ok(!!blocked.detail && /past due/i.test(blocked.detail), "past_due tenant cannot provision NEW servers (402, fail closed)");
  const gp = await rpc(gen1.endpoint.replace("/mcp/", ""), "tools/list", {});
  ok((gp.tools || []).length > 0, "existing servers keep answering while past_due (reads never pause)");
  const okBody = JSON.stringify({ id: "evt_ok_"+RB, type: "transfer.succeeded", tags: { invoice_id: inv.id || inv2.id, tenant_id: g.tenant_id } });
  await fetch(BASE + "/api/billing/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Finix-Signature": sign(okBody) }, body: okBody });
  const acct2 = await get(`/api/billing/accounts/${g.tenant_id}`);
  ok(acct2.status === "active", "settled charge restores the account to active");
  const gen2 = await post(`/api/igb/requests/${g2.request_id}/generate`, {});
  ok(gen2.status === "generated", "provisioning resumes on payment");
  const replay = await fetch(BASE + "/api/billing/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Finix-Signature": sign(okBody) }, body: okBody });
  ok((await replay.json()).status === "already_processed", "webhook replay is inert (UNIQUE external_id)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
