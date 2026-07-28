/* Deployment determination + workflow CAPTURE/REPLAY (SCL v0.2).
   Deployment compatibility is a determination: meet(package × tenant technologies
   × binding affordances) → ranked runtimes, receipted, fail-closed on unknown tech. */
import { callCoreTool, makeReceipt, linkReceipts } from "./core.js";
import { newId, now } from "./runtime.js";

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const httpErr = (s, detail) => json({ detail }, s);

/* surface → concrete artifact + friction rank (lower = easier landing) */
const SURFACE_MAP = {
  connector: ["Copilot Studio / AI-client connector", 1], bot: ["Chat bot (Slack/Teams)", 1],
  addin: ["Office add-in (Office.js)", 2], addon: ["Workspace add-on", 2], lti: ["LTI tool", 2],
  api: ["REST web service / scheduled sync", 3], webhook: ["Event webhook", 3],
  app_store: ["Marketplace app", 4], managed_package: ["Marketplace app", 4], suiteapp: ["Marketplace app", 4], app: ["Marketplace app", 4], native_app: ["Marketplace app", 4],
  plugin_sdk: ["Native plugin (vendor SDK)", 5],
  file_export: ["File exchange (import/export)", 6], file_drop: ["File exchange (import/export)", 6], direct_db: ["Database integration", 6],
  portal: ["Assisted filing — portal has no automation surface", 9],
};

export async function recommendDeployment(db, tenantId) {
  const tenant = await db.prepare("SELECT * FROM ig_tenants WHERE id=? OR name=?").bind(tenantId, tenantId).first();
  if (!tenant) throw Object.assign(new Error("tenant not found"), { code: 404 });
  const facts = (await db.prepare("SELECT * FROM ig_nodes WHERE tenant_id=? AND kind='integration'").bind(tenant.id).all()).results;
  const paths = [{ rank: 0, technology: "any AI client", artifact: "MCP connector (Claude / ChatGPT / Copilot)", rationale: "Zero-integration path — the provisioned endpoint is a standard MCP server.", status: "AVAILABLE" }];
  const citations = [];
  const misses = [];
  for (const f of facts) {
    const name = String(JSON.parse(f.value_json || '""') || "").toLowerCase();
    const p = await db.prepare("SELECT * FROM technology_profiles WHERE name=?").bind(name).first();
    if (!p) { misses.push(name); paths.push({ technology: name, status: "NO_PROFILE", demand_signal: true, rationale: "This tool's binding surfaces are not yet profiled — a curation signal, not a guess." }); continue; }
    const surfaces = JSON.parse(p.surfaces);
    const best = surfaces.map(s => ({ s, m: SURFACE_MAP[s] || [s, 7] })).sort((a, b) => a.m[1] - b.m[1])[0];
    paths.push({ technology: p.name, vendor: p.vendor, artifact: best.m[0], surface: best.s, rank: best.m[1], all_surfaces: surfaces, rationale: p.notes, source_url: p.source_url, status: "DETERMINED" });
    citations.push({ source_id: p.id, source: `${p.vendor} developer documentation`, url: p.source_url, cited_for: `binding affordances for ${p.name}` });
  }
  paths.push({ rank: 8, technology: "any website", artifact: "Embedded web widget", rationale: "Universal fallback — a script tag hosting the governed assistant on the tenant's own site.", status: "AVAILABLE" });
  paths.sort((a, b) => (a.rank ?? 7) - (b.rank ?? 7));
  const out = { status: "DETERMINED", tenant: { id: tenant.id, name: tenant.name }, paths, unprofiled: misses,
    note: "Ranked easiest-successful-landing first. Every artifact is a thin shell around the governed endpoint — execution and receipts stay on the runtime." };
  const r = await makeReceipt(db, { kind: "deployment_determination", subject: tenant.id, tenant_id: tenant.id,
    input: { tenant_id: tenantId }, output: { paths: paths.map(p => ({ technology: p.technology, artifact: p.artifact, status: p.status })) }, citations });
  return { ...out, citations, ...r };
}

/* ---------------- CAPTURE: receipt chain → generalized workflow package ---------------- */
const STEP_OPS = { igb_ingest: null, igb_resolve: null, graph_position: "graph_position", decode: "decode", determination: "determine", report_due: "report_due", reporting_event: null };

export async function captureWorkflow(db, { receipt_id, name }) {
  let cur = await db.prepare("SELECT * FROM audit_receipts WHERE id=?").bind(receipt_id).first();
  if (!cur) throw Object.assign(new Error("receipt not found"), { code: 404 });
  const chain = [];
  for (let i = 0; cur && i < 15; i++) {
    chain.push({ kind: cur.kind, subject: cur.subject });
    cur = cur.prev_receipt_id ? await db.prepare("SELECT * FROM audit_receipts WHERE id=?").bind(cur.prev_receipt_id).first() : null;
  }
  chain.reverse();
  // generalize: keep ordered, de-duplicated executable kinds; tenant/period become parameters
  const seen = new Set(); const steps = [];
  for (const c of chain) if (STEP_OPS[c.kind] && !seen.has(c.kind)) { seen.add(c.kind); steps.push({ kind: c.kind, op: STEP_OPS[c.kind] }); }
  if (!steps.length) throw Object.assign(new Error("No replayable steps in this chain (fail closed)."), { code: 422 });
  const src = await db.prepare("SELECT * FROM audit_receipts WHERE id=?").bind(receipt_id).first();
  const r = await makeReceipt(db, { kind: "workflow_capture", subject: receipt_id, tenant_id: src.tenant_id,
    input: { receipt_id, name }, output: { steps, params: ["tenant_id", "period"] }, prev_receipt_id: receipt_id });
  const id = newId("wfp");
  await db.prepare("INSERT INTO workflow_packages (id,name,tenant_id,source_receipt_id,cell,steps_json,params_json,status,receipt_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(id, name || `Captured workflow ${id.slice(-6)}`, src.tenant_id, receipt_id, null, JSON.stringify(steps), JSON.stringify(["tenant_id", "period"]), "captured", r.receipt_id, now()).run();
  await linkReceipts(db, r.receipt_id, receipt_id, "derived_from");
  return { package_id: id, steps, receipt_id: r.receipt_id, status: "captured",
    note: "Generalized: tenant and period are parameters; concrete values from the source trace are not stored." };
}

export async function replayWorkflow(db, pkgId, { tenant_id, period }) {
  const pkg = await db.prepare("SELECT * FROM workflow_packages WHERE id=?").bind(pkgId).first();
  if (!pkg) throw Object.assign(new Error("workflow package not found"), { code: 404 });
  if (!tenant_id) throw Object.assign(new Error("tenant_id parameter required"), { code: 422 });
  const results = [];
  for (const s of JSON.parse(pkg.steps_json)) {
    const args = { tenant_id }; if (s.op === "report_due" && period) args.period = period;
    const res = await callCoreTool(db, s.op, args, {});
    results.push({ step: s.kind, op: s.op, status: res.status || (res.valid !== undefined ? "VERIFIED" : "OK"), receipt_id: res.receipt_id });
    if (res.status === "NO_DETERMINATION") break; // fail closed: stop the chain at the first refusal
  }
  const ok = results.length && results.every(x => x.status === "DETERMINED");
  const r = await makeReceipt(db, { kind: "workflow_replay", subject: pkgId, tenant_id,
    input: { package_id: pkgId, tenant_id, period }, output: { steps: results, complete: ok }, prev_receipt_id: pkg.receipt_id });
  await linkReceipts(db, r.receipt_id, pkg.receipt_id, "derived_from");
  return { package_id: pkgId, status: ok ? "DETERMINED" : "INCOMPLETE", steps: results, receipt_id: r.receipt_id };
}

/* ---------------- routes ---------------- */
export async function handleDeploy(request, env, url, path, body) {
  const db = env.DB; const method = request.method; let m;
  try {
    if (path === "/api/deploy/profiles" && method === "GET")
      return json((await db.prepare("SELECT * FROM technology_profiles ORDER BY name").all()).results.map(p => ({ ...p, surfaces: JSON.parse(p.surfaces) })));
    if (path === "/api/deploy/recommend" && method === "POST") return json(await recommendDeployment(db, body?.tenant_id));
    if (path === "/api/workflows" && method === "GET")
      return json((await db.prepare("SELECT id,name,tenant_id,status,source_receipt_id,created_at FROM workflow_packages ORDER BY created_at DESC LIMIT 50").all()).results);
    if (path === "/api/workflows/capture" && method === "POST") return json(await captureWorkflow(db, body || {}));
    m = path.match(/^\/api\/workflows\/([\w-]+)\/replay$/);
    if (m && method === "POST") return json(await replayWorkflow(db, m[1], body || {}));
    return null;
  } catch (e) { return httpErr(e.code || 500, e.message); }
}
