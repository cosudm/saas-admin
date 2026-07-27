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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
