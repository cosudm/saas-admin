/* Bundled demo target API (WellView-flavored) so the full Bridge loop works
   with zero external dependencies. Drafted filings persist in D1 settings-free:
   they live per-isolate (ephemeral) — fine for the demo loop. */

const WELLS = [
  { api14: "42-317-40125", name: "Yellow Rose 12H", state: "TX", county: "Martin", operator: "Permian Vista LLC", status: "producing", spud_date: "2024-03-12", oil_bbl_mtd: 18234, gas_mcf_mtd: 40211 },
  { api14: "42-317-40388", name: "Yellow Rose 14H", state: "TX", county: "Martin", operator: "Permian Vista LLC", status: "producing", spud_date: "2024-06-02", oil_bbl_mtd: 16110, gas_mcf_mtd: 35720 },
  { api14: "35-019-27334", name: "Comanche A-3", state: "OK", county: "Carter", operator: "Redbud Energy", status: "shut-in", spud_date: "2021-09-18", oil_bbl_mtd: 0, gas_mcf_mtd: 0 },
  { api14: "30-025-49812", name: "Delaware Basin 7-22", state: "NM", county: "Lea", operator: "Mesa Verde O&G", status: "producing", spud_date: "2023-01-27", oil_bbl_mtd: 22981, gas_mcf_mtd: 61455 },
  { api14: "17-015-24990", name: "Caddo Lake 4", state: "LA", county: "Caddo", operator: "Bayou Operating Co", status: "drilling", spud_date: "2026-06-30", oil_bbl_mtd: 0, gas_mcf_mtd: 0 },
  { api14: "33-053-90112", name: "Bakken Ridge 9-1H", state: "ND", county: "McKenzie", operator: "Northern Plains Res", status: "producing", spud_date: "2022-11-04", oil_bbl_mtd: 30125, gas_mcf_mtd: 28840 },
];
const FILINGS = [
  { id: "fil_8801", api14: "42-317-40125", form: "PR (Production Report)", agency: "TX RRC", period: "2026-06", status: "accepted", submitted_at: "2026-07-05" },
  { id: "fil_8802", api14: "30-025-49812", form: "C-115", agency: "NM OCD", period: "2026-06", status: "pending", submitted_at: "2026-07-10" },
  { id: "fil_8803", api14: "33-053-90112", form: "Form 5", agency: "NDIC", period: "2026-06", status: "accepted", submitted_at: "2026-07-03" },
];

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export function demoSpec(origin) {
  return {
    openapi: "3.0.1",
    info: { title: "WellView Field API", version: "1.2.0",
      description: "Every well, one workspace — wells, production and regulator-ready filings across all 30 oil & gas states." },
    servers: [{ url: origin + "/demo-api" }],
    paths: {
      "/wells": { get: { operationId: "listWells", summary: "List wells with optional state/status/operator filters", parameters: [
        { name: "state", in: "query", schema: { type: "string" }, description: "Two-letter state, e.g. TX" },
        { name: "status", in: "query", schema: { type: "string", enum: ["producing", "shut-in", "drilling"] } },
        { name: "operator", in: "query", schema: { type: "string" }, description: "Operator name contains" }],
        responses: { 200: { description: "OK" } } } },
      "/wells/{api14}": { get: { operationId: "getWell", summary: "Get a well by API-14 number", parameters: [
        { name: "api14", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "OK" } } } },
      "/wells/{api14}/production": { get: { operationId: "getProduction", summary: "Monthly production series for a well", parameters: [
        { name: "api14", in: "path", required: true, schema: { type: "string" } },
        { name: "months", in: "query", schema: { type: "integer", default: 6 } }],
        responses: { 200: { description: "OK" } } } },
      "/filings": {
        get: { operationId: "listFilings", summary: "List regulatory filings", parameters: [
          { name: "agency", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string" } }],
          responses: { 200: { description: "OK" } } },
        post: { operationId: "draftFiling", summary: "Draft a regulatory filing (held for human submission)",
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object",
            properties: {
              api14: { type: "string", description: "Well API-14 number" },
              form: { type: "string", description: "Form name, e.g. PR, W-10, C-115" },
              agency: { type: "string", description: "Agency, e.g. TX RRC, OCC, NM OCD" },
              period: { type: "string", description: "Reporting period YYYY-MM" },
              notes: { type: "string" } },
            required: ["api14", "form", "agency", "period"] } } } },
          responses: { 201: { description: "Created" } } } },
      "/filings/{filing_id}": { delete: { operationId: "withdrawFiling", summary: "Withdraw a draft filing", parameters: [
        { name: "filing_id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "OK" } } } },
    },
  };
}

export async function handleDemoApi(request, path) {
  const url = new URL(request.url);
  const q = k => url.searchParams.get(k);
  const method = request.method;

  if (path === "/wells" && method === "GET") {
    let out = WELLS;
    if (q("state")) out = out.filter(w => w.state.toLowerCase() === q("state").toLowerCase());
    if (q("status")) out = out.filter(w => w.status === q("status"));
    if (q("operator")) out = out.filter(w => w.operator.toLowerCase().includes(q("operator").toLowerCase()));
    return json({ count: out.length, wells: out });
  }
  let m = path.match(/^\/wells\/([^/]+)\/production$/);
  if (m && method === "GET") {
    const w = WELLS.find(x => x.api14 === m[1]);
    if (!w) return json({ detail: "well not found" }, 404);
    const months = Number(q("months")) || 6;
    const baseOil = Math.max(w.oil_bbl_mtd, 100), baseGas = Math.max(w.gas_mcf_mtd, 100);
    const series = [];
    for (let mo = Math.max(1, 7 - months); mo < 7; mo++) {
      series.push({ period: `2026-${String(mo).padStart(2, "0")}`, oil_bbl: Math.floor(baseOil * (0.9 + 0.02 * mo)), gas_mcf: Math.floor(baseGas * (0.88 + 0.025 * mo)) });
    }
    return json({ api14: m[1], months: series });
  }
  m = path.match(/^\/wells\/([^/]+)$/);
  if (m && method === "GET") {
    const w = WELLS.find(x => x.api14 === m[1]);
    return w ? json(w) : json({ detail: "well not found" }, 404);
  }
  if (path === "/filings" && method === "GET") {
    let out = FILINGS;
    if (q("agency")) out = out.filter(f => f.agency.toLowerCase().includes(q("agency").toLowerCase()));
    if (q("status")) out = out.filter(f => f.status === q("status"));
    return json({ count: out.length, filings: out });
  }
  if (path === "/filings" && method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ detail: "invalid JSON body" }, 422); }
    for (const rq of ["api14", "form", "agency", "period"]) {
      if (!body?.[rq]) return json({ detail: `field '${rq}' is required` }, 422);
    }
    const f = { id: "fil_" + crypto.randomUUID().slice(0, 6), api14: body.api14, form: body.form, agency: body.agency,
      period: body.period, status: "draft — awaiting human submission", submitted_at: null,
      notes: body.notes ?? null, created_at: new Date().toISOString().slice(0, 10) };
    FILINGS.push(f);
    return json(f, 201);
  }
  m = path.match(/^\/filings\/([^/]+)$/);
  if (m && method === "DELETE") {
    const i = FILINGS.findIndex(f => f.id === m[1]);
    if (i < 0) return json({ detail: "filing not found" }, 404);
    if (!String(FILINGS[i].status).includes("draft")) return json({ detail: "only draft filings can be withdrawn" }, 409);
    FILINGS.splice(i, 1);
    return json({ withdrawn: m[1] });
  }
  return json({ detail: "not found" }, 404);
}
