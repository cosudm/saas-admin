/* First-class domain API routes: Identity Graph, UDM lattice, jurisdictions,
   Reg Reporting, provenance, receipts — with an OpenAPI contract document. */
import { decode, determine, graphPosition, jurisdictionPath, makeReceipt, receiptVerify, reportDue } from "./core.js";
import { newId, now } from "./runtime.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const httpErr = (status, detail) => json({ detail }, status);

export async function handleFirstClass(request, env, url, path, body) {
  const db = env.DB;
  const method = request.method;
  let m;

  /* ---------- Identity Graph ---------- */
  if (path === "/api/ig/tenants" && method === "GET") {
    const tenants = (await db.prepare("SELECT * FROM ig_tenants ORDER BY name").all()).results;
    return json(tenants);
  }
  m = path.match(/^\/api\/ig\/([\w-]+)\/position$/);
  if (m && method === "GET") return json(await graphPosition(db, { tenant_id: m[1] }));

  /* ---------- UDM lattice ---------- */
  if (path === "/api/udm/systems" && method === "GET") {
    return json((await db.prepare("SELECT * FROM code_systems").all()).results);
  }
  if (path === "/api/udm/codes" && method === "GET") {
    const system = url.searchParams.get("system");
    const q = (url.searchParams.get("q") || "").toLowerCase();
    let rows = system
      ? (await db.prepare("SELECT * FROM codes WHERE system_id=? ORDER BY code LIMIT 500").bind(system).all()).results
      : (await db.prepare("SELECT * FROM codes ORDER BY system_id, code LIMIT 500").all()).results;
    if (q) rows = rows.filter(r => (r.code + " " + (r.title || "")).toLowerCase().includes(q));
    return json(rows);
  }
  if (path === "/api/udm/boundaries" && method === "GET") {
    return json((await db.prepare("SELECT * FROM boundary_rules ORDER BY allowed DESC, from_system").all()).results);
  }
  if (path === "/api/udm/decode" && method === "POST") {
    if (!body?.system || !body?.code) return httpErr(422, "system and code are required");
    return json(await decode(db, { system: body.system, code: body.code }));
  }

  /* ---------- jurisdictions ---------- */
  if (path === "/api/jurisdictions" && method === "GET") {
    const rows = (await db.prepare("SELECT * FROM jurisdictions ORDER BY kind, name").all()).results;
    return json(rows);
  }
  m = path.match(/^\/api\/jurisdictions\/([\w-]+)\/path$/);
  if (m && method === "GET") {
    const p = await jurisdictionPath(db, decodeURIComponent(m[1]));
    return p.length ? json({ path: p, depth: p.length }) : httpErr(404, "jurisdiction not found");
  }
  if (path === "/api/regulatory-bodies" && method === "GET") {
    const rows = (await db.prepare(
      `SELECT b.*, j.name jurisdiction_name, group_concat(s.domain) domains
       FROM regulatory_bodies b LEFT JOIN jurisdictions j ON j.id=b.jurisdiction_id
       LEFT JOIN authority_scopes s ON s.body_id=b.id GROUP BY b.id ORDER BY j.name`).all()).results;
    return json(rows);
  }

  /* ---------- Reg Reporting ---------- */
  if (path === "/api/reg/forms" && method === "GET") {
    const rows = (await db.prepare(
      `SELECT f.*, b.acronym, b.name body_name FROM reporting_forms f JOIN regulatory_bodies b ON b.id=f.body_id ORDER BY b.acronym, f.form_code LIMIT 500`).all()).results;
    return json(rows);
  }
  if (path === "/api/reg/requirements" && method === "GET") {
    const rows = (await db.prepare(
      `SELECT r.*, b.acronym, f.form_code, f.source_url form_url FROM reporting_requirements r
       JOIN regulatory_bodies b ON b.id=r.body_id LEFT JOIN reporting_forms f ON f.id=r.form_id ORDER BY b.acronym LIMIT 500`).all()).results;
    return json(rows);
  }
  if (path === "/api/reg/events" && method === "GET") {
    const tenant = url.searchParams.get("tenant_id");
    const rows = tenant
      ? (await db.prepare(`SELECT e.*, r.name req_name, r.frequency, b.acronym FROM reporting_events e
          JOIN reporting_requirements r ON r.id=e.requirement_id JOIN regulatory_bodies b ON b.id=r.body_id
          WHERE e.tenant_id=? ORDER BY e.due_date`).bind(tenant).all()).results
      : (await db.prepare(`SELECT e.*, r.name req_name, r.frequency, b.acronym FROM reporting_events e
          JOIN reporting_requirements r ON r.id=e.requirement_id JOIN regulatory_bodies b ON b.id=r.body_id
          ORDER BY e.due_date LIMIT 200`).all()).results;
    return json(rows);
  }
  if (path === "/api/reg/report-due" && method === "POST") {
    if (!body?.tenant_id) return httpErr(422, "tenant_id is required");
    return json(await reportDue(db, { tenant_id: body.tenant_id, period: body.period }));
  }
  if (path === "/api/reg/determine" && method === "POST") {
    if (!body?.tenant_id) return httpErr(422, "tenant_id is required");
    return json(await determine(db, { tenant_id: body.tenant_id, domain: body.domain || "oil_gas" }));
  }
  m = path.match(/^\/api\/reg\/events\/([\w-]+)\/submit$/);
  if (m && method === "POST") {
    const ev = await db.prepare("SELECT * FROM reporting_events WHERE id=?").bind(m[1]).first();
    if (!ev) return httpErr(404, "reporting event not found");
    if (!body?.submitted_by) return httpErr(422, "submitted_by (a human) is required — AI drafts, a person submits");
    const sr = await makeReceipt(db, { kind: "submission", subject: ev.id, tenant_id: ev.tenant_id,
      input: { event_id: ev.id, submitted_by: body.submitted_by, method: body.method || "manual" },
      output: { status: "submitted", submitted_at: new Date().toISOString() },
      prev_receipt_id: ev.receipt_id });
    const sid = newId("sub");
    await db.prepare("INSERT INTO submissions (id,event_id,submitted_at,submitted_by,method,status,receipt_id) VALUES (?,?,?,?,?,?,?)")
      .bind(sid, ev.id, new Date().toISOString(), body.submitted_by, body.method || "manual", "submitted", sr.receipt_id).run();
    for (const a of body.evidence || []) {
      await db.prepare("INSERT INTO evidence_artifacts (id,submission_id,kind,uri,content_hash) VALUES (?,?,?,?,?)")
        .bind(newId("evd"), sid, a.kind || "document", a.uri || "", a.content_hash || null).run();
    }
    await db.prepare("UPDATE reporting_events SET status='submitted' WHERE id=?").bind(ev.id).run();
    return json({ submission_id: sid, receipt_id: sr.receipt_id, status: "submitted" });
  }

  /* ---------- provenance ---------- */
  if (path === "/api/prov/sources" && method === "GET") {
    return json((await db.prepare("SELECT * FROM sources ORDER BY name").all()).results);
  }
  if (path === "/api/prov/coverage" && method === "GET") {
    const edges = await db.prepare("SELECT COUNT(*) total, SUM(source_id IS NOT NULL AND source_id != '') sourced FROM crosswalk_edges").first();
    const forms = await db.prepare("SELECT COUNT(*) total, SUM(source_url IS NOT NULL AND source_url != '') sourced FROM reporting_forms").first();
    const reqs = await db.prepare("SELECT COUNT(*) total, SUM(source_id IS NOT NULL AND source_id != '') sourced FROM reporting_requirements").first();
    return json({ crosswalk_edges: edges, reporting_forms: forms, reporting_requirements: reqs,
      fully_sourced: edges.total === edges.sourced && forms.total === forms.sourced && reqs.total === reqs.sourced });
  }

  /* ---------- receipts ---------- */
  if (path === "/api/receipts" && method === "GET") {
    const limit = Number(url.searchParams.get("limit")) || 50;
    const rows = (await db.prepare(
      "SELECT id,kind,subject,tenant_id,input_hash,output_hash,prev_receipt_id,chain_hash,created_at FROM audit_receipts ORDER BY created_at DESC LIMIT ?")
      .bind(limit).all()).results;
    return json(rows);
  }
  m = path.match(/^\/api\/receipts\/([\w-]+)$/);
  if (m && method === "GET") {
    const r = await db.prepare("SELECT * FROM audit_receipts WHERE id=?").bind(m[1]).first();
    if (!r) return httpErr(404, "receipt not found");
    for (const k of ["input_json", "output_json", "citations_json"]) { try { r[k] = JSON.parse(r[k]); } catch { /* keep */ } }
    return json(r);
  }
  m = path.match(/^\/api\/receipts\/([\w-]+)\/verify$/);
  if (m && method === "POST") return json(await receiptVerify(db, m[1]));

  /* ---------- OpenAPI contract ---------- */
  if (path === "/api/contracts/openapi.json" && method === "GET") return json(contractDoc(url.origin));

  return null; // not a first-class route
}

/* ============================ OpenAPI contract for the IG/UDM/audit objects ============================ */
function contractDoc(origin) {
  const receipt = { type: "object", properties: {
    receipt_id: { type: "string", example: "rcpt_9f2a1c04d1" }, chain_hash: { type: "string" },
    input_hash: { type: "string" }, output_hash: { type: "string" }, prev_receipt_id: { type: "string", nullable: true } } };
  const citation = { type: "object", properties: {
    source_id: { type: "string" }, source: { type: "string" }, url: { type: "string" }, cited_for: { type: "string" } } };
  const noDetermination = { type: "object", properties: {
    status: { type: "string", enum: ["NO_DETERMINATION"] }, reason: { type: "string" } } };
  const ok = (schema, desc, example) => ({ 200: { description: desc, content: { "application/json": { schema, ...(example ? { example } : {}) } } } });
  return {
    openapi: "3.0.3",
    info: { title: "IOS+ First-Class Domain Contracts", version: "1.0.0",
      description: "Identity Graph, UDM lattice, jurisdiction containment, Reg Reporting, provenance and receipt-chain contracts. Every determination is deterministic, cited and receipted; taxonomy traversal fails closed on boundary violations." },
    servers: [{ url: origin }],
    paths: {
      "/api/ig/tenants": { get: { summary: "List Identity Graph tenants", responses: ok({ type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } }, "Tenants") } },
      "/api/ig/{tenant_id}/position": { get: { summary: "Tenant graph position (deterministic, cited, receipted)",
        parameters: [{ name: "tenant_id", in: "path", required: true, schema: { type: "string" }, example: "ten_permianvista" }],
        responses: ok({ type: "object", properties: { status: { type: "string" }, tenant: { type: "object" },
          industry_positions: { type: "array" }, jurisdictions: { type: "array" }, citations: { type: "array", items: citation }, ...receipt.properties } }, "Position",
          { status: "DETERMINED", tenant: { id: "ten_permianvista", name: "Permian Vista LLC" },
            industry_positions: [{ system: "UDM-GI", code: "GI-005", title: "Oil and gas extraction" }],
            jurisdictions: ["Texas", "New Mexico"], receipt_id: "rcpt_…" }) } },
      "/api/udm/decode": { post: { summary: "Decode a code through the lattice — fails closed on boundary violations",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["system", "code"],
          properties: { system: { type: "string", enum: ["UDM-GI", "ISIC", "NAICS", "GICS"] }, code: { type: "string" } } },
          examples: { determined: { value: { system: "UDM-GI", code: "GI-005" } }, failClosed: { value: { system: "GICS", code: "Energy" } } } } } },
        responses: ok({ oneOf: [{ type: "object", properties: { status: { type: "string", enum: ["DETERMINED"] }, origin: { type: "object" }, bridges: { type: "object" }, path: { type: "array" }, citations: { type: "array", items: citation }, ...receipt.properties } }, noDetermination] },
          "Decode result — NO_DETERMINATION (still receipted) when the traversal is forbidden or the code is outside the closed world") } },
      "/api/udm/boundaries": { get: { summary: "Taxonomy boundary rules (the fail-closed gate list)", responses: ok({ type: "array", items: { type: "object", properties: { from_system: { type: "string" }, to_system: { type: "string" }, allowed: { type: "integer" }, via: { type: "string", nullable: true }, rationale: { type: "string" } } } }, "Rules") } },
      "/api/jurisdictions/{id}/path": { get: { summary: "Containment path from a jurisdiction up to the country root",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, example: "jur_caddo_parish" }],
        responses: ok({ type: "object", properties: { depth: { type: "integer" }, path: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, kind: { type: "string" } } } } } }, "Path",
          { depth: 3, path: [{ id: "jur_caddo_parish", name: "Caddo Parish", kind: "parish" }, { id: "jur_louisiana", name: "Louisiana", kind: "state" }, { id: "jur_us", name: "United States", kind: "country" }] }) } },
      "/api/reg/determine": { post: { summary: "Deterministic obligation determination (closed world)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["tenant_id"], properties: { tenant_id: { type: "string" }, domain: { type: "string", default: "oil_gas" } } } } } },
        responses: ok({ type: "object", properties: { status: { type: "string" }, determinations: { type: "array" }, count: { type: "integer" }, citations: { type: "array", items: citation }, ...receipt.properties } }, "Determinations with citations and a receipt") } },
      "/api/reg/report-due": { post: { summary: "Materialize receipted reporting events for a period",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["tenant_id"], properties: { tenant_id: { type: "string" }, period: { type: "string", example: "2026-07" } } } } } },
        responses: ok({ type: "object", properties: { status: { type: "string" }, period: { type: "string" }, events: { type: "array" }, count: { type: "integer" }, ...receipt.properties } }, "Events — each carries its own receipt_id (fail closed: no event without a receipt)") } },
      "/api/reg/events/{id}/submit": { post: { summary: "Record a human submission for a reporting event",
        description: "AI drafts; a person submits. submitted_by is required and the submission is receipted and chained to the event's receipt.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["submitted_by"], properties: { submitted_by: { type: "string" }, method: { type: "string" }, evidence: { type: "array", items: { type: "object", properties: { kind: { type: "string" }, uri: { type: "string" }, content_hash: { type: "string" } } } } } } } } },
        responses: ok({ type: "object", properties: { submission_id: { type: "string" }, receipt_id: { type: "string" }, status: { type: "string" } } }, "Submission recorded") } },
      "/api/prov/coverage": { get: { summary: "Source-provenance coverage over crosswalk edges, forms and requirements",
        responses: ok({ type: "object", properties: { fully_sourced: { type: "boolean" } } }, "Coverage — tests fail closed unless fully_sourced is true") } },
      "/api/receipts/{id}/verify": { post: { summary: "Verify a receipt's hash chain back to genesis",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: ok({ type: "object", properties: { valid: { type: "boolean" }, depth: { type: "integer" }, chain: { type: "array" } } }, "Verification result — any tampered ancestor breaks the chain") } },
    },
  };
}
