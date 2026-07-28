/* IOS+ deterministic core engine.
   Principles enforced here:
     * Same inputs + same lattice ⇒ same outputs (deterministic, hash-stable).
     * Every answer is cited (source-of-truth rows) and receipted (hash chain).
     * Taxonomy traversal fails CLOSED on any boundary_rules violation.
     * AI may render or route; this engine originates obligations and decides truth. */
import { newId, now } from "./runtime.js";

/* ---------------- canonical hashing ---------------- */
export function canonical(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonical).join(",") + "]";
  return "{" + Object.keys(obj).sort().map(k => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}
export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ---------------- receipt chain ---------------- */
let lastReceiptCache = null; // per-isolate hint only; the DB row is the truth

/* Semantic State Tuple — pinned into every receipt (SCL §6). Atlas/engine fields
   update when the embedding atlas ships; the tuple makes lineage reproducible. */
export const SST = { scl: "0.1", lattice: "L1-2026.07", atlas: "none", engine: "deterministic-core" };

export async function makeReceipt(db, { kind, subject, tenant_id = null, input, output, citations = [], prev_receipt_id = null, invocation_id = null }) {
  const inputJson = canonical(input ?? {});
  const outputJson = canonical(output ?? {});
  const inputHash = await sha256(inputJson);
  const outputHash = await sha256(outputJson);
  if (!prev_receipt_id) {
    const tip = lastReceiptCache || await db.prepare("SELECT id, chain_hash FROM audit_receipts ORDER BY created_at DESC, id DESC LIMIT 1").first();
    if (tip) prev_receipt_id = tip.id;
  }
  const prev = prev_receipt_id ? await db.prepare("SELECT chain_hash FROM audit_receipts WHERE id=?").bind(prev_receipt_id).first() : null;
  const chainHash = await sha256((prev?.chain_hash || "genesis") + inputHash + outputHash);
  const id = newId("rcpt");
  await db.prepare(`INSERT INTO audit_receipts (id,kind,subject,tenant_id,input_json,output_json,input_hash,output_hash,citations_json,prev_receipt_id,chain_hash,created_at,sst)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, kind, subject ?? null, tenant_id, inputJson, outputJson, inputHash, outputHash,
      JSON.stringify(citations), prev_receipt_id ?? null, chainHash, now(), JSON.stringify(SST)).run();
  if (invocation_id) {
    await db.prepare("INSERT INTO audit_invocations (id,receipt_id,invocation_id) VALUES (?,?,?)")
      .bind(newId("ainv"), id, invocation_id).run();
  }
  lastReceiptCache = { id, chain_hash: chainHash };
  return { receipt_id: id, chain_hash: chainHash, input_hash: inputHash, output_hash: outputHash, prev_receipt_id };
}

export async function linkReceipts(db, fromId, toId, relation) {
  await db.prepare("INSERT INTO receipt_edges (id,from_receipt_id,to_receipt_id,relation) VALUES (?,?,?,?)")
    .bind(newId("redge"), fromId, toId, relation).run();
}

export async function receiptVerify(db, receiptId, maxDepth = 100) {
  const chain = [];
  let cur = await db.prepare("SELECT * FROM audit_receipts WHERE id=?").bind(receiptId).first();
  if (!cur) return { valid: false, error: `No receipt ${receiptId}`, chain: [] };
  let depth = 0;
  while (cur && depth < maxDepth) {
    const inputHash = await sha256(cur.input_json);
    const outputHash = await sha256(cur.output_json);
    const prev = cur.prev_receipt_id ? await db.prepare("SELECT chain_hash FROM audit_receipts WHERE id=?").bind(cur.prev_receipt_id).first() : null;
    const expectChain = await sha256((prev?.chain_hash || "genesis") + inputHash + outputHash);
    const ok = inputHash === cur.input_hash && outputHash === cur.output_hash && expectChain === cur.chain_hash;
    chain.push({ receipt_id: cur.id, kind: cur.kind, subject: cur.subject, created_at: cur.created_at,
      hashes_valid: inputHash === cur.input_hash && outputHash === cur.output_hash,
      chain_valid: expectChain === cur.chain_hash, valid: ok });
    if (!ok) return { valid: false, error: `Receipt ${cur.id} failed verification`, depth, chain };
    if (!cur.prev_receipt_id) break;
    cur = await db.prepare("SELECT * FROM audit_receipts WHERE id=?").bind(cur.prev_receipt_id).first();
    depth += 1;
  }
  return { valid: true, depth: chain.length, chain };
}

/* ---------------- taxonomy: fail-closed decode ---------------- */
async function boundaryRules(db) {
  return (await db.prepare("SELECT * FROM boundary_rules").all()).results;
}

export async function decode(db, { system, code }, opts = {}) {
  const input = { system, code };
  const sys = await db.prepare("SELECT * FROM code_systems WHERE id=?").bind(system).first();
  if (!sys) {
    const out = { status: "NO_DETERMINATION", reason: `Unknown code system '${system}'. Closed world: ${["UDM-GI", "ISIC", "NAICS", "GICS"].join(", ")}.` };
    const r = await makeReceipt(db, { kind: "decode", subject: `${system}:${code}`, input, output: out, invocation_id: opts.invocation_id });
    return { ...out, ...r };
  }
  const rules = await boundaryRules(db);
  const originRule = rules.filter(r => r.from_system === system);
  const anyAllowed = originRule.some(r => r.allowed);
  const start = await db.prepare("SELECT * FROM codes WHERE system_id=? AND code=?").bind(system, code).first();
  if (!start) {
    const out = { status: "NO_DETERMINATION", reason: `Code '${code}' is not in the ${system} lattice. The matrix answers only from its closed world.` };
    const r = await makeReceipt(db, { kind: "decode", subject: `${system}:${code}`, input, output: out, invocation_id: opts.invocation_id });
    return { ...out, ...r };
  }
  if (!anyAllowed) {
    const why = originRule[0]?.rationale || `${system} may not originate traversals`;
    const out = { status: "NO_DETERMINATION", reason: `Boundary violation (fail closed): ${why}.`,
      boundary: originRule.map(r => ({ from: r.from_system, to: r.to_system, allowed: !!r.allowed, rationale: r.rationale })) };
    const r = await makeReceipt(db, { kind: "decode", subject: `${system}:${code}`, input, output: out, invocation_id: opts.invocation_id });
    return { ...out, ...r };
  }
  // BFS along crosswalk_edges, only crossing allowed system boundaries
  const allowedPairs = new Set(rules.filter(r => r.allowed).map(r => r.from_system + ">" + r.to_system));
  const visited = new Set([start.id]);
  const resolved = { [system]: [{ code: start.code, title: start.title }] };
  const path = [];
  const citations = [];
  let frontier = [start];
  for (let hop = 0; hop < 6 && frontier.length; hop++) {
    const next = [];
    for (const node of frontier) {
      const edges = (await db.prepare(
        `SELECT e.id edge_id, e.source_id, c.* FROM crosswalk_edges e JOIN codes c ON c.id = e.to_code_id WHERE e.from_code_id=?`)
        .bind(node.id).all()).results;
      for (const e of edges) {
        if (!allowedPairs.has(node.system_id + ">" + e.system_id)) continue; // fail closed: skip forbidden crossings
        if (visited.has(e.id)) continue;
        visited.add(e.id);
        (resolved[e.system_id] ||= []).push({ code: e.code, title: e.title });
        path.push({ from: `${node.system_id}:${node.code}`, to: `${e.system_id}:${e.code}`, edge_id: e.edge_id });
        if (e.source_id) {
          const src = await db.prepare("SELECT id,name,publisher,url FROM sources WHERE id=?").bind(e.source_id).first();
          if (src && !citations.some(c => c.source_id === src.id)) {
            citations.push({ source_id: src.id, source: src.name, publisher: src.publisher, url: src.url, cited_for: "crosswalk edge" });
          }
        }
        next.push(e);
      }
    }
    frontier = next;
  }
  const out = { status: "DETERMINED", origin: { system, code: start.code, title: start.title },
    bridges: resolved, path, boundary_note: "Traversal constrained by boundary_rules; forbidden crossings are never taken." };
  const r = await makeReceipt(db, { kind: "decode", subject: `${system}:${code}`, input, output: out, citations, invocation_id: opts.invocation_id });
  return { ...out, citations, ...r };
}

/* ---------------- identity graph position ---------------- */
export async function graphPosition(db, { tenant_id }, opts = {}) {
  const input = { tenant_id };
  const tenant = await db.prepare("SELECT * FROM ig_tenants WHERE id=? OR name=?").bind(tenant_id, tenant_id).first();
  if (!tenant) {
    const out = { status: "NO_DETERMINATION", reason: `Unknown tenant '${tenant_id}'.` };
    const r = await makeReceipt(db, { kind: "graph_position", subject: tenant_id, input, output: out, invocation_id: opts.invocation_id });
    return { ...out, ...r };
  }
  const nodes = (await db.prepare("SELECT * FROM ig_nodes WHERE tenant_id=?").bind(tenant.id).all()).results
    .map(n => ({ ...n, value: safeParse(n.value_json) }));
  const citations = [{ source_id: "src_udm_master", source: "Universal Decoding Matrix — Master Workbook", cited_for: "identity graph position schema" }];
  // resolve canonical industry positions
  const positions = [];
  for (const n of nodes.filter(x => x.kind === "industry_position" && x.code_id)) {
    const c = await db.prepare("SELECT c.*, s.role FROM codes c JOIN code_systems s ON s.id=c.system_id WHERE c.id=?").bind(n.code_id).first();
    if (c) positions.push({ key: n.key, system: c.system_id, code: c.code, title: c.title, system_role: c.role });
  }
  const out = {
    status: "DETERMINED",
    tenant: { id: tenant.id, name: tenant.name },
    industry_positions: positions,
    jurisdictions: nodes.filter(n => n.kind === "jurisdiction").map(n => n.value),
    flags: Object.fromEntries(nodes.filter(n => n.kind === "flag").map(n => [n.key, n.value])),
    metrics: Object.fromEntries(nodes.filter(n => n.kind === "metric").map(n => [n.key, n.value])),
  };
  const r = await makeReceipt(db, { kind: "graph_position", subject: tenant.id, tenant_id: tenant.id, input, output: out, citations, invocation_id: opts.invocation_id });
  return { ...out, citations, ...r };
}

/* ---------------- jurisdiction containment ---------------- */
export async function jurisdictionPath(db, jurId) {
  const path = [];
  let cur = await db.prepare("SELECT * FROM jurisdictions WHERE id=? OR name=?").bind(jurId, jurId).first();
  let depth = 0;
  while (cur && depth < 8) {
    path.push({ id: cur.id, name: cur.name, kind: cur.kind });
    if (!cur.parent_id) break;
    cur = await db.prepare("SELECT * FROM jurisdictions WHERE id=?").bind(cur.parent_id).first();
    depth += 1;
  }
  return path;
}

/* ---------------- determination (obligations, closed world) ---------------- */
const OIL_GAS_GI = new Set(["GI-005", "GI-008"]); // extraction + mining support services

export async function determine(db, { tenant_id, domain = "oil_gas" }, opts = {}) {
  const input = { tenant_id, domain };
  const pos = await graphPosition(db, { tenant_id });
  if (pos.status !== "DETERMINED") {
    const out = { status: "NO_DETERMINATION", reason: pos.reason };
    const r = await makeReceipt(db, { kind: "determination", subject: tenant_id, input, output: out, invocation_id: opts.invocation_id });
    return { ...out, ...r };
  }
  const inDomain = pos.industry_positions.some(p => p.system === "UDM-GI" && OIL_GAS_GI.has(p.code));
  if (!inDomain) {
    const out = { status: "NO_DETERMINATION",
      reason: `Tenant industry position (${pos.industry_positions.map(p => p.code).join(", ") || "none"}) does not decode into the '${domain}' authority domain. The matrix does not guess outside its closed world.` };
    const r = await makeReceipt(db, { kind: "determination", subject: tenant_id, tenant_id: pos.tenant.id, input, output: out, prev_receipt_id: pos.receipt_id, invocation_id: opts.invocation_id });
    return { ...out, ...r };
  }
  // jurisdictions → bodies with authority in domain
  const citations = [...(pos.citations || [])];
  const determinations = [];
  for (const jname of pos.jurisdictions) {
    const jpath = await jurisdictionPath(db, jname);
    if (!jpath.length) continue;
    const jids = jpath.map(j => j.id);
    const bodies = (await db.prepare(
      `SELECT b.*, s.domain, s.scope_note FROM regulatory_bodies b JOIN authority_scopes s ON s.body_id=b.id
       WHERE s.domain=? AND b.jurisdiction_id IN (${jids.map(() => "?").join(",")})`)
      .bind(domain, ...jids).all()).results;
    for (const b of bodies) {
      const reqs = (await db.prepare(
        `SELECT r.*, f.form_code, f.title form_title, f.submission_channel, f.source_url form_url
         FROM reporting_requirements r LEFT JOIN reporting_forms f ON f.id=r.form_id
         WHERE r.body_id=? AND r.frequency IN ('monthly','quarterly','annual')`).bind(b.id).all()).results;
      for (const rq of reqs) {
        determinations.push({
          requirement_id: rq.id, body: b.acronym, body_name: b.name,
          jurisdiction: jname, jurisdiction_path: jpath.map(j => j.name),
          form: rq.form_code, name: rq.name, frequency: rq.frequency, due_rule: rq.due_rule,
          authority: { filing_system: b.filing_system, source_url: b.source_url },
        });
        if (rq.form_url && !citations.some(c => c.url === rq.form_url)) {
          citations.push({ source_id: rq.source_id, source: `${b.acronym} official forms page`, url: rq.form_url, cited_for: `${rq.form_code} — ${rq.name}` });
        }
      }
    }
  }
  const out = { status: determinations.length ? "DETERMINED" : "NO_DETERMINATION",
    tenant: pos.tenant, domain,
    reason: determinations.length ? undefined : "Tenant jurisdictions carry no seeded authority scopes for this domain.",
    determinations, count: determinations.length };
  const r = await makeReceipt(db, { kind: "determination", subject: tenant_id, tenant_id: pos.tenant.id, input, output: out, citations, prev_receipt_id: pos.receipt_id, invocation_id: opts.invocation_id });
  await linkReceipts(db, r.receipt_id, pos.receipt_id, "derived_from");
  return { ...out, citations, ...r };
}

/* ---------------- report_due (creates receipted reporting events) ---------------- */
export async function reportDue(db, { tenant_id, period }, opts = {}) {
  period = period || new Date().toISOString().slice(0, 7);
  const input = { tenant_id, period };
  const det = await determine(db, { tenant_id });
  if (det.status !== "DETERMINED") {
    const out = { status: det.status, reason: det.reason, period };
    const r = await makeReceipt(db, { kind: "report_due", subject: tenant_id, input, output: out, prev_receipt_id: det.receipt_id, invocation_id: opts.invocation_id });
    return { ...out, ...r };
  }
  const events = [];
  for (const d of det.determinations) {
    if (d.frequency === "monthly" || (d.frequency === "annual" && period.length === 4) || d.frequency === "quarterly") {
      const evId = `evt_${await sha256(d.requirement_id + "|" + det.tenant.id + "|" + period)}`.slice(0, 24);
      const existing = await db.prepare("SELECT * FROM reporting_events WHERE requirement_id=? AND tenant_id=? AND period=?")
        .bind(d.requirement_id, det.tenant.id, period).first();
      if (existing) {
        events.push({ ...d, event_id: existing.id, period, due_date: existing.due_date, status: existing.status, receipt_id: existing.receipt_id });
        continue;
      }
      const due = dueDateFor(d.frequency, period);
      const er = await makeReceipt(db, { kind: "reporting_event", subject: d.requirement_id, tenant_id: det.tenant.id,
        input: { requirement_id: d.requirement_id, tenant_id: det.tenant.id, period },
        output: { due_date: due, status: "open", due_rule: d.due_rule }, citations: det.citations, prev_receipt_id: det.receipt_id });
      await db.prepare("INSERT INTO reporting_events (id,requirement_id,tenant_id,period,due_date,status,receipt_id) VALUES (?,?,?,?,?,?,?)")
        .bind(evId, d.requirement_id, det.tenant.id, period, due, "open", er.receipt_id).run();
      await linkReceipts(db, er.receipt_id, det.receipt_id, "derived_from");
      events.push({ ...d, event_id: evId, period, due_date: due, status: "open", receipt_id: er.receipt_id });
    }
  }
  const out = { status: "DETERMINED", tenant: det.tenant, period, events, count: events.length,
    note: "Events are receipted determinations. AI may draft; a human submits every filing." };
  const r = await makeReceipt(db, { kind: "report_due", subject: tenant_id, tenant_id: det.tenant.id, input, output: out, citations: det.citations, prev_receipt_id: det.receipt_id, invocation_id: opts.invocation_id });
  await linkReceipts(db, r.receipt_id, det.receipt_id, "derived_from");
  return { ...out, citations: det.citations, ...r };
}

function dueDateFor(frequency, period) {
  if (frequency === "monthly" && /^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split("-").map(Number);
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    // last day of the following month — conservative default; due_rule text remains authoritative
    const last = new Date(Date.UTC(nm === 12 ? ny + 1 : ny, nm === 12 ? 0 : nm, 0)).getUTCDate();
    return `${ny}-${String(nm).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  }
  if (frequency === "annual") return `${Number(period.slice(0, 4)) + 1}-04-15`;
  return null;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return s; } }

/* ---------------- ios-core MCP tool surface ---------------- */
export const CORE_TOOLS = [
  { name: "graph_position",
    summary: "Tenant-specific Identity Graph position: industry codes, jurisdictions, flags, metrics.",
    description: "Returns the tenant's canonical position in the Identity Graph — declared industry positions resolved to lattice codes, operating jurisdictions, flags and metrics. Deterministic, cited, receipted.",
    input_schema: { type: "object", properties: { tenant_id: { type: "string", description: "Tenant id or exact name, e.g. ten_permianvista" } }, required: ["tenant_id"] },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "decode",
    summary: "Decode a code through the UDM lattice (fail-closed taxonomy boundaries).",
    description: "Resolves a code through the Universal Decoding Matrix: UDM-GI → ISIC (anchor) → NAICS (bridge) → GICS (presentation). Traversals that violate boundary_rules (e.g. originating from GICS) return NO_DETERMINATION — the matrix fails closed. Every decode is cited and receipted.",
    input_schema: { type: "object", properties: {
      system: { type: "string", enum: ["UDM-GI", "ISIC", "NAICS", "GICS"], description: "Code system of the input code" },
      code: { type: "string", description: "Code within that system, e.g. GI-005" } }, required: ["system", "code"] },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "determine",
    summary: "Deterministic obligation determination for a tenant (closed world, cited, receipted).",
    description: "Determines which regulatory reporting obligations attach to a tenant, from Identity Graph position × jurisdiction containment × authority scopes × the Reg Reporting matrix. Never guesses: outside the closed world it returns NO_DETERMINATION with the reason.",
    input_schema: { type: "object", properties: {
      tenant_id: { type: "string" }, domain: { type: "string", default: "oil_gas" } }, required: ["tenant_id"] },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "report_due",
    summary: "Reporting events due for a tenant and period — each event is a receipted determination.",
    description: "Materializes the tenant's reporting obligations for a period into receipted reporting_events (status open). AI may draft; a human submits every filing. Returns due dates, authoritative due rules, filing channels and citations.",
    input_schema: { type: "object", properties: {
      tenant_id: { type: "string" }, period: { type: "string", description: "YYYY-MM (monthly) or YYYY (annual). Defaults to current month." } }, required: ["tenant_id"] },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "receipt_verify",
    summary: "Verify a receipt and its hash chain back to genesis.",
    description: "Recomputes input/output hashes and the chain hash for the given receipt and every ancestor. Any tamper breaks verification. Returns the verified chain.",
    input_schema: { type: "object", properties: { receipt_id: { type: "string" } }, required: ["receipt_id"] },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "segment_response",
    summary: "Segment an AI response turn into governed blocks (scripts, tool calls, instructions, resources) for WATCH.",
    description: "Deterministically segments a model response turn: fenced code becomes scripts (tool-call JSON becomes tool_calls), URLs become resources, imperative and numbered lines become instructions, questions become queries. The grammar is fixed — no model in the loop — so identical turns yield identical segments and hashes. Captured segments feed WATCH, where recurring flows across conversations compile into packages; nothing becomes executable without maker-checker approval. Receipted.",
    input_schema: { type: "object", properties: {
      text: { type: "string", description: "The full response-turn text to segment." },
      conversation_id: { type: "string", description: "Stable id for the conversation this turn belongs to (default 'default')." },
      turn_no: { type: "integer", description: "Turn number within the conversation (default 1)." } }, required: ["text"] },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false } },
];

export async function callCoreTool(db, name, args, opts = {}) {
  switch (name) {
    case "graph_position": return await graphPosition(db, args, opts);
    case "decode": return await decode(db, args, opts);
    case "determine": return await determine(db, args, opts);
    case "report_due": return await reportDue(db, args, opts);
    case "receipt_verify": return await receiptVerify(db, args.receipt_id);
    case "segment_response": {
      const { segmentAndStore } = await import("./segment.js");
      try { return await segmentAndStore(db, { tenant_id: args.tenant_id, conversation_id: args.conversation_id, turn_no: args.turn_no, text: args.text, source: opts.source || "mcp" }); }
      catch (e) { return { status: "NO_DETERMINATION", reason: e.message }; }
    }
    default: return { status: "NO_DETERMINATION", reason: `Unknown core tool ${name}` };
  }
}
