/* Identity Graph Builder — INGEST (graph) → RESOLVE (capabilities) → APPROVE (maker-checker) → GENERATE (package).
   The user describes intent in natural language; deterministic extraction turns it into
   onboarding facts; facts resolve through the UDM into an Identity Graph; the graph
   determines the 10 provisioned object families. Nothing is provisioned until approved
   (8 approval gates); every generated artifact links to a receipt.
   AI renders and routes — this engine extracts, resolves and decides deterministically. */
import { decode, determine, makeReceipt, linkReceipts } from "./core.js";
import { newId, now } from "./runtime.js";
import { slugify } from "./importers.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const httpErr = (status, detail) => json({ detail }, status);

/* The 10 provisioned object families; 8 are approval-gated. */
export const FAMILIES = ["agents", "obligations", "capabilities", "tools", "flows", "connectors",
  "customer_connector_configurations", "instructions", "prompts", "resources"];
export const GATED = new Set(["agents", "obligations", "capabilities", "tools", "flows", "connectors",
  "customer_connector_configurations", "prompts"]); // 8 gates — instructions & resources are advisory

/* ---------------- deterministic extraction catalogs ---------------- */
const SYNONYMS = {
  "oil": "oil and gas", "gas": "oil and gas", "wells": "oil and gas", "drilling": "oil and gas",
  "petroleum": "oil and gas", "leases": "oil and gas", "operator": "oil and gas", "oilfield": "oil and gas",
  "university": "education", "college": "education", "students": "education", "registrar": "education",
  "transcripts": "education", "campus": "education",
  "hospital": "health", "clinic": "health", "patients": "health",
  "farm": "farming", "ranch": "farming", "cattle": "farming", "crops": "farming",
  "software": "software", "saas": "software", "app": "software", "platform": "software",
  "bank": "financial", "lending": "financial", "loans": "financial",
  "trucking": "transport", "freight": "transport", "logistics": "warehousing",
  "restaurant": "food and beverage service", "construction": "construction",
  "mining": "mining", "pipeline": "pipelines", "refinery": "petroleum",
};
const ACTIVITIES = ["production reporting", "regulatory filings", "filings", "compliance", "audit", "permitting",
  "transcript evaluation", "transfer credit", "enrollment", "case triage", "vendor readiness", "vendor management",
  "invoicing", "payroll", "scheduling", "inventory", "monitoring", "incident reporting", "plugging", "completions",
  "injection", "disposal", "severance tax", "royalty"];
const INTEGRATIONS = ["enverus", "autocad", "copilot", "salesforce", "quickbooks", "sap", "oracle", "workday", "excel", "sharepoint", "slack",
  "teams", "stripe", "hubspot", "netsuite", "dynamics", "gmail", "outlook", "docusign", "box", "dropbox",
  "snowflake", "postgres", "mysql", "banner", "peoplesoft", "wellview", "sonris", "northstar"];

function extractEntity(text) {
  const m = text.match(/(?:we are|we're|i run|i own|i manage|called|named|at)\s+([A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){0,4})/);
  if (m) return m[1].replace(/\s+(and|in|with|across|operating|based).*$/i, "").trim();
  const caps = text.match(/\b([A-Z][A-Za-z&'-]+(?:\s+[A-Z][A-Za-z&'-]+){1,3}\s+(?:LLC|Inc|Corp|Co|LP|LLP|University|College|Energy|Operating|Resources))\b/);
  return caps ? caps[1] : null;
}

async function matchIndustries(db, text) {
  const lower = " " + text.toLowerCase() + " ";
  const wanted = new Set();
  for (const [word, phrase] of Object.entries(SYNONYMS)) {
    if (new RegExp(`[^a-z]${word}[^a-z]`).test(lower)) wanted.add(phrase);
  }
  const codes = (await db.prepare("SELECT * FROM codes WHERE system_id='UDM-GI' ORDER BY code").all()).results;
  const hits = [];
  for (const c of codes) {
    const title = (c.title || "").toLowerCase();
    let hit = [...wanted].some(p => title.includes(p));
    if (!hit) { // direct title-word match for words ≥ 5 chars (word-boundary safe)
      const words = title.split(/[^a-z]+/).filter(w => w.length >= 5 && !["services", "related", "activities", "support", "other", "product", "products", "production", "general", "management"].includes(w));
      hit = words.some(w => new RegExp(`[^a-z]${w}[^a-z]`).test(lower));
    }
    if (hit && !hits.some(h => h.id === c.id)) hits.push(c);
  }
  // prefer specific extraction over support services when both matched via same synonyms
  return hits.slice(0, 3);
}

async function matchJurisdictions(db, text) {
  const lower = text.toLowerCase();
  const rows = (await db.prepare("SELECT * FROM jurisdictions WHERE kind != 'country'").all()).results;
  return rows.filter(j => lower.includes(j.name.toLowerCase()));
}

/* ================= Stage 1 · INGEST (graph facts) =================
   Two channels into the same receipted pipeline:
   - text/voice: deterministic extraction from a described intent
   - guided: click-selected facts (Jane Doe mode) — the clicks ARE the facts,
     pre-resolved against the lattice, no extraction needed, 100% precision. */
export async function ingest(db, { text, requested_by, channel = "text", selections = null }) {
  if (!selections && !text?.trim()) throw Object.assign(new Error("Describe the business — the intake text is empty."), { code: 422 });
  if (!requested_by?.trim()) throw Object.assign(new Error("requested_by (the maker) is required."), { code: 422 });
  const reqId = newId("igbreq");
  const facts = [];
  if (selections) {
    channel = "guided";
    if (selections.org_name?.trim()) facts.push({ kind: "entity", key: "organization", value: selections.org_name.trim() });
    for (const code of selections.industry_codes || []) {
      const c = await db.prepare("SELECT * FROM codes WHERE system_id='UDM-GI' AND code=?").bind(code).first();
      if (!c) throw Object.assign(new Error(`'${code}' is not in the lattice — guided selections must be valid nodes (fail closed).`), { code: 422 });
      facts.push({ kind: "activity", key: "industry", value: `${c.code} — ${c.title}`, resolved_code_id: c.id });
    }
    for (const st of selections.states || []) {
      const j = await db.prepare("SELECT * FROM jurisdictions WHERE id=? OR name=?").bind(st, st).first();
      if (!j) throw Object.assign(new Error(`'${st}' is not in the jurisdiction tree (fail closed).`), { code: 422 });
      facts.push({ kind: "location", key: "operates_in", value: j.name, resolved_jurisdiction_id: j.id });
    }
    for (const a of selections.activities || []) if (ACTIVITIES.includes(a)) facts.push({ kind: "activity", key: "does", value: a });
    for (const i of selections.integrations || []) if (INTEGRATIONS.includes(i)) facts.push({ kind: "integration", key: "uses", value: i });
    text = text || `[guided intake] ${facts.map(f => f.value).join("; ")}`;
  } else {
    const entity = extractEntity(text);
    if (entity) facts.push({ kind: "entity", key: "organization", value: entity });
    const industries = await matchIndustries(db, text);
    for (const c of industries) facts.push({ kind: "activity", key: "industry", value: `${c.code} — ${c.title}`, resolved_code_id: c.id });
    const jurs = await matchJurisdictions(db, text);
    for (const j of jurs) facts.push({ kind: "location", key: "operates_in", value: j.name, resolved_jurisdiction_id: j.id });
    const lower = text.toLowerCase();
    for (const a of ACTIVITIES) if (lower.includes(a)) facts.push({ kind: "activity", key: "does", value: a });
    for (const i of INTEGRATIONS) if (new RegExp(`[^a-z]${i}[^a-z]?`).test(" " + lower + " ")) facts.push({ kind: "integration", key: "uses", value: i });
    const wellsM = text.match(/(\d+)\s*(?:wells|leases|students|locations|sites|employees)/i);
    if (wellsM) facts.push({ kind: "metric", key: wellsM[0].split(/\s+/).pop().toLowerCase(), value: wellsM[1] });
  }

  const r = await makeReceipt(db, { kind: "igb_ingest", subject: reqId,
    input: { text, requested_by, channel, selections: selections || undefined },
    output: { facts: facts.map(f => ({ kind: f.kind, key: f.key, value: f.value })) },
    citations: [{ source_id: "src_udm_master", source: "Universal Decoding Matrix — Master Workbook", cited_for: channel === "guided" ? "guided selections validated against the lattice" : "extraction catalogs (industries, jurisdictions)" }] });

  await db.prepare("INSERT INTO igb_intake_requests (id,raw_text,channel,requested_by,status,receipt_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(reqId, text, channel, requested_by, "ingested", r.receipt_id, now()).run();
  for (const f of facts) {
    await db.prepare("INSERT INTO igb_intake_facts (id,request_id,kind,key,value,confidence,resolved_code_id,resolved_jurisdiction_id,receipt_id) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(newId("fact"), reqId, f.kind, f.key, f.value ?? null, 1, f.resolved_code_id ?? null, f.resolved_jurisdiction_id ?? null, r.receipt_id).run();
  }
  return { request_id: reqId, status: "ingested", facts, receipt_id: r.receipt_id };
}

/* ================= Stage 2 · RESOLVE (capabilities via UDM + Identity Graph) ================= */
export async function resolve(db, requestId) {
  const req = await db.prepare("SELECT * FROM igb_intake_requests WHERE id=?").bind(requestId).first();
  if (!req) throw Object.assign(new Error("intake request not found"), { code: 404 });
  const facts = (await db.prepare("SELECT * FROM igb_intake_facts WHERE request_id=?").bind(requestId).all()).results;

  // Build the Identity Graph position
  const entity = facts.find(f => f.kind === "entity")?.value || `Tenant ${requestId.slice(-6)}`;
  const tenantId = "ten_" + slugify(entity).replace(/-/g, "").slice(0, 20);
  if (!await db.prepare("SELECT id FROM ig_tenants WHERE id=?").bind(tenantId).first()) {
    await db.prepare("INSERT INTO ig_tenants (id,name,created_at) VALUES (?,?,?)").bind(tenantId, entity, now()).run();
  }
  await db.prepare("DELETE FROM ig_nodes WHERE tenant_id=?").bind(tenantId).run();
  let n = 0;
  const nid = () => `ign_${tenantId.slice(4, 12)}_${++n}`;
  const industryFacts = facts.filter(f => f.resolved_code_id);
  for (const f of industryFacts) {
    await db.prepare("INSERT INTO ig_nodes (id,tenant_id,kind,key,value_json,code_id) VALUES (?,?,?,?,?,?)")
      .bind(nid(), tenantId, "industry_position", "primary_industry", JSON.stringify({ declared: f.value }), f.resolved_code_id).run();
  }
  for (const f of facts.filter(x => x.kind === "location")) {
    await db.prepare("INSERT INTO ig_nodes (id,tenant_id,kind,key,value_json,code_id) VALUES (?,?,?,?,?,NULL)")
      .bind(nid(), tenantId, "jurisdiction", "operates_in", JSON.stringify(f.value)).run();
  }
  for (const f of facts.filter(x => x.kind === "integration")) {
    await db.prepare("INSERT INTO ig_nodes (id,tenant_id,kind,key,value_json,code_id) VALUES (?,?,?,?,?,NULL)")
      .bind(nid(), tenantId, "integration", "uses", JSON.stringify(f.value)).run();
  }
  for (const f of facts.filter(x => x.kind === "metric")) {
    await db.prepare("INSERT INTO ig_nodes (id,tenant_id,kind,key,value_json,code_id) VALUES (?,?,?,?,?,NULL)")
      .bind(nid(), tenantId, "metric", f.key, JSON.stringify(Number(f.value) || f.value)).run();
  }

  // Decode industries through the UDM (receipted, fail-closed) and determine obligations
  const decodes = [];
  for (const f of industryFacts) {
    const c = await db.prepare("SELECT * FROM codes WHERE id=?").bind(f.resolved_code_id).first();
    if (c) decodes.push(await decode(db, { system: "UDM-GI", code: c.code }));
  }
  const det = await determine(db, { tenant_id: tenantId });

  // Candidate families (deterministic derivations, each with provenance)
  const activities = facts.filter(f => f.kind === "activity" && f.key === "does").map(f => f.value);
  const integrations = facts.filter(f => f.kind === "integration").map(f => f.value);
  const cands = [];
  const push = (family, name, description, details, source) =>
    cands.push({ family, name, description, details, source, gated: GATED.has(family) ? 1 : 0 });

  if (det.status === "DETERMINED") {
    for (const d of det.determinations) {
      push("obligations", `${d.body} ${d.form} — ${d.frequency}`, d.name,
        { requirement_id: d.requirement_id, due_rule: d.due_rule, authority: d.authority, jurisdiction_path: d.jurisdiction_path },
        `determine() receipt ${det.receipt_id}`);
    }
  }
  const capSet = new Set(["governed-search", "identity-lookup"]);
  for (const a of activities) capSet.add(slugify(a));
  if (det.status === "DETERMINED") capSet.add("regulatory-reporting");
  for (const cap of capSet) {
    push("capabilities", cap, `Capability derived from ${["governed-search", "identity-lookup"].includes(cap) ? "the governed core" : "declared activities"}.`,
      {}, "intake facts + determination");
  }
  for (const cap of capSet) {
    push("tools", `${cap.replace(/-/g, "_")}_run`, `Typed MCP tool for the '${cap}' capability — schema-validated, receipted.`,
      { input_schema: { type: "object", properties: { query: { type: "string" } } }, governance: "Read · identity-scoped" }, `capability ${cap}`);
  }
  if (det.status === "DETERMINED") {
    push("flows", "monthly-obligation-cycle", "determine → report_due → draft → human review → human submit (receipted at every step).",
      { steps: ["determine", "report_due", "draft", "human_review", "human_submit"] }, `determination ${det.receipt_id}`);
  }
  push("flows", "identity-refresh", "Re-ingest → re-resolve the Identity Graph when the business changes.", { steps: ["ingest", "resolve", "approve"] }, "builder pipeline");
  for (const i of integrations) {
    push("connectors", i, `Connector recommended because the intake mentions ${i}.`, { transport: "mcp" }, "intake integration fact");
    push("customer_connector_configurations", `${i}-config`, `Tenant-scoped configuration for the ${i} connector (credentials held in Vault).`,
      { connector: i, auth: "oauth2_or_apikey", status: "pending-credentials" }, "connector candidate");
  }
  push("prompts", "lead-agent-system-prompt", "System prompt for the lead agent: closed-world answers, citations mandatory, receipts on every action.",
    { template: `You are the lead agent for ${entity}. Answer only from the governed tools. Every answer must cite its authority and carry its receipt. If the matrix cannot determine an answer, say NO_DETERMINATION — never guess. Filings wait for a human.` }, "builder template");
  push("prompts", "specialist-reporting-prompt", "Prompt template for the reporting specialist.",
    { template: "Draft regulatory reports from governed data only. Attach the authoritative due rule and source URL. Route the draft to a human for submission." }, "builder template");
  push("agents", "Overseer (lead)", "Lead agent — routes work, enforces the obligation lattice.", { role: "lead" }, "builder template");
  if (det.status === "DETERMINED") push("agents", "Reporting Specialist", "Drafts obligation filings; never submits.", { role: "specialist" }, "determination");
  push("agents", "Gatekeeper", "Validates every write against obligations; blocks out-of-manifest actions.", { role: "gatekeeper" }, "builder template");
  push("instructions", "server-instructions",
    `Governed MCP server for ${entity}. Deterministic, cited, receipted. AI renders and routes; the matrix decides. Nothing files without a human.`,
    {}, "builder template");
  push("resources", "UDM Registry", "The industry crosswalk this identity resolves through.", { uri: "/api/udm", kind: "reference" }, "udm");
  if (det.status === "DETERMINED") {
    const seen = new Set();
    for (const d of det.determinations) {
      if (d.authority?.source_url && !seen.has(d.authority.source_url)) {
        seen.add(d.authority.source_url);
        push("resources", `${d.body} official forms`, `Authoritative source for ${d.body} filings.`, { uri: d.authority.source_url, kind: "authority" }, "determination citation");
      }
    }
  }

  const r = await makeReceipt(db, { kind: "igb_resolve", subject: requestId, tenant_id: tenantId,
    input: { request_id: requestId, facts: facts.length },
    output: { tenant_id: tenantId, candidates: cands.map(c => ({ family: c.family, name: c.name })), determination: det.status },
    citations: det.citations || [], prev_receipt_id: req.receipt_id });
  await linkReceipts(db, r.receipt_id, req.receipt_id, "derived_from");

  await db.prepare("DELETE FROM igb_capability_candidates WHERE request_id=?").bind(requestId).run();
  for (const c of cands) {
    await db.prepare("INSERT INTO igb_capability_candidates (id,request_id,family,name,description,details_json,source,gated,status,receipt_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(newId("cand"), requestId, c.family, c.name, c.description, JSON.stringify(c.details || {}), c.source, c.gated, "proposed", r.receipt_id).run();
  }
  // open the maker-checker review with one item per gated candidate
  const reviewId = newId("rev");
  await db.prepare("INSERT INTO igb_approval_reviews (id,request_id,maker,status,receipt_id) VALUES (?,?,?,?,?)")
    .bind(reviewId, requestId, req.requested_by, "open", r.receipt_id).run();
  const gatedRows = (await db.prepare("SELECT * FROM igb_capability_candidates WHERE request_id=? AND gated=1").bind(requestId).all()).results;
  for (const g of gatedRows) {
    await db.prepare("INSERT INTO igb_approval_items (id,review_id,candidate_id,family,decision) VALUES (?,?,?,?,'pending')")
      .bind(newId("item"), reviewId, g.id, g.family).run();
  }
  await db.prepare("UPDATE igb_intake_requests SET status='in_review', tenant_id=? WHERE id=?").bind(tenantId, requestId).run();
  return { request_id: requestId, status: "in_review", tenant_id: tenantId, review_id: reviewId,
    candidates: cands.length, gated_items: gatedRows.length, receipt_id: r.receipt_id, determination: det.status };
}

/* ================= Stage 3 · APPROVE (maker-checker) ================= */
export async function decideReview(db, reviewId, { checker, decisions = [], approve_all = false, reject_all = false }) {
  const review = await db.prepare("SELECT * FROM igb_approval_reviews WHERE id=?").bind(reviewId).first();
  if (!review) throw Object.assign(new Error("review not found"), { code: 404 });
  if (!checker?.trim()) throw Object.assign(new Error("checker is required — approvals are maker-checker."), { code: 422 });
  if (checker.trim().toLowerCase() === review.maker.trim().toLowerCase()) {
    throw Object.assign(new Error(`Maker-checker violation (fail closed): '${checker}' is the maker of this request and cannot approve it.`), { code: 422 });
  }
  if (review.status !== "open") throw Object.assign(new Error(`review is already ${review.status}`), { code: 409 });

  const items = (await db.prepare("SELECT * FROM igb_approval_items WHERE review_id=?").bind(reviewId).all()).results;
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  const applied = [];
  const apply = async (item, decision, note) => {
    await db.prepare("UPDATE igb_approval_items SET decision=?, note=?, decided_by=? WHERE id=?").bind(decision, note ?? null, checker, item.id).run();
    await db.prepare("UPDATE igb_capability_candidates SET status=? WHERE id=?").bind(decision, item.candidate_id).run();
    applied.push({ item_id: item.id, family: item.family, decision });
  };
  if (approve_all || reject_all) {
    for (const i of items.filter(x => x.decision === "pending")) await apply(i, approve_all ? "approved" : "rejected", null);
  } else {
    for (const d of decisions) {
      const item = byId[d.item_id];
      if (!item) continue;
      if (!["approved", "rejected"].includes(d.decision)) continue;
      await apply(item, d.decision, d.note);
    }
  }
  const remaining = (await db.prepare("SELECT COUNT(*) c FROM igb_approval_items WHERE review_id=? AND decision='pending'").bind(reviewId).all()).results[0].c;
  let status = review.status;
  if (remaining === 0) {
    const approvedCount = (await db.prepare("SELECT COUNT(*) c FROM igb_approval_items WHERE review_id=? AND decision='approved'").bind(reviewId).all()).results[0].c;
    status = approvedCount > 0 ? "approved" : "rejected";
    const r = await makeReceipt(db, { kind: "igb_approval", subject: reviewId,
      input: { review_id: reviewId, maker: review.maker, checker },
      output: { status, approved: approvedCount, total: items.length },
      prev_receipt_id: review.receipt_id });
    await db.prepare("UPDATE igb_approval_reviews SET status=?, checker=?, decided_at=?, receipt_id=? WHERE id=?")
      .bind(status, checker, now(), r.receipt_id, reviewId).run();
    await db.prepare("UPDATE igb_intake_requests SET status=? WHERE id=?").bind(status, review.request_id).run();
  } else {
    await db.prepare("UPDATE igb_approval_reviews SET checker=? WHERE id=?").bind(checker, reviewId).run();
  }
  return { review_id: reviewId, status, pending: remaining, applied };
}

/* ================= Stage 4 · GENERATE (package) ================= */
export async function generate(db, requestId) {
  const req = await db.prepare("SELECT * FROM igb_intake_requests WHERE id=?").bind(requestId).first();
  if (!req) throw Object.assign(new Error("intake request not found"), { code: 404 });
  const review = await db.prepare("SELECT * FROM igb_approval_reviews WHERE request_id=? ORDER BY rowid DESC LIMIT 1").bind(requestId).first();
  if (!review || review.status !== "approved") {
    throw Object.assign(new Error(`Fail closed: nothing is provisioned until the maker-checker review is approved (current: ${review?.status || "missing"}).`), { code: 409 });
  }
  const cands = (await db.prepare("SELECT * FROM igb_capability_candidates WHERE request_id=?").bind(requestId).all()).results
    .map(c => ({ ...c, details: safeParse(c.details_json) }));
  const usable = cands.filter(c => !c.gated || c.status === "approved");
  const fam = f => usable.filter(c => c.family === f).map(c => ({ name: c.name, description: c.description, ...c.details, source: c.source }));
  const tenant = await db.prepare("SELECT * FROM ig_tenants WHERE id=?").bind(req.tenant_id).first();
  const slug = slugify((tenant?.name || requestId)) + "-server";
  const manifest = {
    identity_graph_builder: 1,
    tenant: { id: req.tenant_id, name: tenant?.name },
    proposed_endpoint: `/mcp/${slug}`,
    families: Object.fromEntries(FAMILIES.map(f => [f, fam(f)])),
    governance: { maker: review.maker, checker: review.checker, review_id: review.id,
      note: "Every artifact below links to a receipt. Filings wait for a human." },
  };
  const pr = await makeReceipt(db, { kind: "igb_generate", subject: requestId, tenant_id: req.tenant_id,
    input: { request_id: requestId, review_id: review.id },
    output: { package_families: FAMILIES.map(f => ({ family: f, count: manifest.families[f].length })) },
    prev_receipt_id: review.receipt_id });
  await linkReceipts(db, pr.receipt_id, review.receipt_id, "derived_from");
  const pkgId = newId("pkg");
  await db.prepare("INSERT INTO igb_generated_packages (id,request_id,review_id,tenant_id,name,manifest_json,receipt_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(pkgId, requestId, review.id, req.tenant_id, (tenant?.name || "Tenant") + " MCP Package", JSON.stringify(manifest), pr.receipt_id, now()).run();

  // materialize artifact rows — each links to the package receipt
  const promptIds = {};
  for (const p of manifest.families.prompts) {
    const pid = newId("ptpl");
    promptIds[p.name] = pid;
    await db.prepare("INSERT INTO mcp_prompt_templates (id,package_id,name,purpose,template,receipt_id) VALUES (?,?,?,?,?,?)")
      .bind(pid, pkgId, p.name, p.description ?? null, p.template ?? null, pr.receipt_id).run();
  }
  for (const a of manifest.families.agents) {
    await db.prepare("INSERT INTO mcp_agents (id,package_id,name,role,intent,prompt_template_id,receipt_id) VALUES (?,?,?,?,?,?,?)")
      .bind(newId("agent"), pkgId, a.name, a.role || "specialist", a.description ?? null,
        promptIds["lead-agent-system-prompt"] ?? null, pr.receipt_id).run();
  }
  for (const t of manifest.families.tools) {
    await db.prepare("INSERT INTO mcp_tool_manifests (id,package_id,name,description,input_schema,governance,receipt_id) VALUES (?,?,?,?,?,?,?)")
      .bind(newId("tman"), pkgId, t.name, t.description ?? null, JSON.stringify(t.input_schema || {}), t.governance || "Read · identity-scoped", pr.receipt_id).run();
  }
  for (const rsc of manifest.families.resources) {
    await db.prepare("INSERT INTO mcp_resources (id,package_id,name,kind,uri,description,receipt_id) VALUES (?,?,?,?,?,?,?)")
      .bind(newId("rsc"), pkgId, rsc.name, rsc.kind || "reference", rsc.uri ?? null, rsc.description ?? null, pr.receipt_id).run();
  }
  // ---- auto-provision the live MCP server from the approved manifest ----
  let liveSlug = slug;
  if (await db.prepare("SELECT id FROM servers WHERE slug=?").bind(liveSlug).first()) {
    liveSlug = `${liveSlug}-${newId("x").slice(-4)}`;
  }
  const ts = now();
  const srcId = newId("src");
  await db.prepare("INSERT INTO api_sources (id,name,protocol,base_url,spec_text,spec_url,tool_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(srcId, (tenant?.name || "Tenant") + " Package", "package", "", null, null, manifest.families.tools.length, ts, ts).run();
  const srvId = newId("srv");
  const instructions = manifest.families.instructions[0]?.description || manifest.families.instructions[0]?.name || "";
  await db.prepare(`INSERT INTO servers (id,slug,name,description,source_id,code_mode,enabled,package_id,tenant_id,created_at,updated_at)
    VALUES (?,?,?,?,?,0,1,?,?,?,?)`)
    .bind(srvId, liveSlug, (tenant?.name || "Tenant") + " Server", instructions, srcId, pkgId, req.tenant_id, ts, ts).run();
  const opFor = cap => {
    if (cap === "identity-lookup") return "graph_position";
    if (cap === "governed-search") return "udm_search";
    if (/report|filing|tax|compliance|severance/.test(cap)) return "report_due";
    return "capability_info";
  };
  const schemaFor = op => op === "udm_search"
    ? { type: "object", properties: { query: { type: "string", description: "Keyword search over the UDM lattice, obligations and forms." } }, required: ["query"] }
    : op === "report_due"
      ? { type: "object", properties: { period: { type: "string", description: "YYYY-MM reporting period (defaults to current month)." } }, required: [] }
      : { type: "object", properties: {}, required: [] };
  for (const t of manifest.families.tools) {
    const cap = t.name.replace(/_run$/, "").replace(/_/g, "-");
    const op = opFor(cap);
    await db.prepare(`INSERT INTO tools (id,server_id,name,method,path,summary,description,input_schema,annotations,governance,mapping,enabled,curated,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?,?)`)
      .bind(newId("tool"), srvId, t.name, "CORE", cap, t.description ?? null,
        (t.description || "") + ` Answers come from the governed core for tenant ${tenant?.name || req.tenant_id}; deterministic, cited, receipted.`,
        JSON.stringify(schemaFor(op)),
        JSON.stringify({ readOnlyHint: op !== "report_due", idempotentHint: true, openWorldHint: false }),
        t.governance || "Read · identity-scoped",
        JSON.stringify({ kind: "core", op, tenant_id: req.tenant_id, capability: cap, package_id: pkgId }),
        ts, ts).run();
  }
  // every provisioned server carries segment_response — the operator's AI client
  // can push any model turn into WATCH, where recurring flows become products
  await db.prepare(`INSERT INTO tools (id,server_id,name,method,path,summary,description,input_schema,annotations,governance,mapping,enabled,curated,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1,?,?)`)
    .bind(newId("tool"), srvId, "segment_response", "CORE", "segment-response",
      "Segment an AI response turn into governed blocks for WATCH.",
      "Deterministically segments a model response turn (scripts, tool calls, instructions, resources, queries) into receipted WATCH segments for this tenant. Fixed grammar — identical turns yield identical segments. Nothing becomes executable without maker-checker approval.",
      JSON.stringify({ type: "object", properties: {
        text: { type: "string", description: "The full response-turn text to segment." },
        conversation_id: { type: "string", description: "Stable conversation id (default 'default')." },
        turn_no: { type: "integer", description: "Turn number within the conversation (default 1)." } }, required: ["text"] }),
      JSON.stringify({ readOnlyHint: false, idempotentHint: true, openWorldHint: false }),
      "Write · identity-scoped · maker-checker gated",
      JSON.stringify({ kind: "core", op: "segment_response", tenant_id: req.tenant_id, capability: "segment-response", package_id: pkgId }),
      ts, ts).run();
  manifest.proposed_endpoint = `/mcp/${liveSlug}`;
  await db.prepare("UPDATE igb_generated_packages SET manifest_json=? WHERE id=?").bind(JSON.stringify(manifest), pkgId).run();
  await db.prepare("INSERT INTO ig_surface_bindings (id,tenant_id,surface,binding_ref,package_id,receipt_id) VALUES (?,?,?,?,?,?)")
    .bind(newId("bind"), req.tenant_id, "mcp_server", `/mcp/${liveSlug}`, pkgId, pr.receipt_id).run();
  await db.prepare("UPDATE igb_intake_requests SET status='generated' WHERE id=?").bind(requestId).run();
  return { package_id: pkgId, request_id: requestId, tenant_id: req.tenant_id,
    manifest, receipt_id: pr.receipt_id, status: "generated",
    endpoint: `/mcp/${liveSlug}`, server_id: srvId, provisioned_tools: manifest.families.tools.length };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

/* ================= request detail ================= */
async function requestDetail(db, id) {
  const req = await db.prepare("SELECT * FROM igb_intake_requests WHERE id=?").bind(id).first();
  if (!req) return null;
  const facts = (await db.prepare("SELECT * FROM igb_intake_facts WHERE request_id=?").bind(id).all()).results;
  const cands = (await db.prepare("SELECT * FROM igb_capability_candidates WHERE request_id=?").bind(id).all()).results
    .map(c => ({ ...c, details: safeParse(c.details_json) }));
  const review = await db.prepare("SELECT * FROM igb_approval_reviews WHERE request_id=? ORDER BY rowid DESC LIMIT 1").bind(id).first();
  const items = review ? (await db.prepare("SELECT * FROM igb_approval_items WHERE review_id=?").bind(review.id).all()).results : [];
  const pkg = await db.prepare("SELECT * FROM igb_generated_packages WHERE request_id=? ORDER BY created_at DESC LIMIT 1").bind(id).first();
  if (pkg) { try { pkg.manifest = JSON.parse(pkg.manifest_json); delete pkg.manifest_json; } catch { /* keep */ } }
  return { request: req, facts, candidates: cands, review, items, package: pkg };
}

/* ================= routes ================= */
export async function handleIgb(request, env, url, path, body) {
  const db = env.DB;
  const method = request.method;
  let m;
  try {
    if (path === "/api/igb/intake" && method === "POST") {
      const ing = await ingest(db, { text: body?.text, requested_by: body?.requested_by, channel: body?.channel, selections: body?.selections });
      const res = await resolve(db, ing.request_id);
      // Guided (consumer) intake: the review screen the user confirms IS the human review;
      // the platform's curated blueprint acts as checker of record (consumer tier —
      // enterprise tier keeps full named maker-checker).
      if (body?.selections && body?.auto_approve) {
        await decideReview(db, res.review_id, { checker: "IOSMCP Curated Blueprint (platform)", approve_all: true });
      }
      return json({ ...res, ingest_receipt_id: ing.receipt_id, facts: ing.facts, detail: await requestDetail(db, ing.request_id) });
    }
    if (path === "/api/igb/options" && method === "GET") {
      const industries = (await db.prepare("SELECT code, title FROM codes WHERE system_id='UDM-GI' ORDER BY title").all()).results;
      const states = (await db.prepare("SELECT id, name FROM jurisdictions WHERE kind='state' ORDER BY name").all()).results;
      return json({ industries, states, activities: ACTIVITIES, integrations: INTEGRATIONS });
    }
    if (path === "/api/igb/requests" && method === "GET") {
      return json((await db.prepare("SELECT * FROM igb_intake_requests ORDER BY created_at DESC LIMIT 50").all()).results);
    }
    m = path.match(/^\/api\/igb\/requests\/([\w-]+)$/);
    if (m && method === "GET") {
      const d = await requestDetail(db, m[1]);
      return d ? json(d) : httpErr(404, "intake request not found");
    }
    m = path.match(/^\/api\/igb\/reviews\/([\w-]+)\/decide$/);
    if (m && method === "POST") return json(await decideReview(db, m[1], body || {}));
    m = path.match(/^\/api\/igb\/requests\/([\w-]+)\/generate$/);
    if (m && method === "POST") return json(await generate(db, m[1]));
    m = path.match(/^\/api\/igb\/packages\/([\w-]+)$/);
    if (m && method === "GET") {
      const pkg = await db.prepare("SELECT * FROM igb_generated_packages WHERE id=?").bind(m[1]).first();
      if (!pkg) return httpErr(404, "package not found");
      const agents = (await db.prepare("SELECT * FROM mcp_agents WHERE package_id=?").bind(m[1]).all()).results;
      const tools = (await db.prepare("SELECT * FROM mcp_tool_manifests WHERE package_id=?").bind(m[1]).all()).results;
      const prompts = (await db.prepare("SELECT * FROM mcp_prompt_templates WHERE package_id=?").bind(m[1]).all()).results;
      const resources = (await db.prepare("SELECT * FROM mcp_resources WHERE package_id=?").bind(m[1]).all()).results;
      const bindings = (await db.prepare("SELECT * FROM ig_surface_bindings WHERE package_id=?").bind(m[1]).all()).results;
      try { pkg.manifest = JSON.parse(pkg.manifest_json); delete pkg.manifest_json; } catch { /* keep */ }
      return json({ ...pkg, artifacts: { agents, tools, prompts, resources, bindings } });
    }
    return null;
  } catch (e) {
    return httpErr(e.code || 500, e.message);
  }
}
