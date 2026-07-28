/* IOS+ MCP Gateway Bridge — Cloudflare Worker entrypoint.
   Console UI     GET  /                    (static asset)
   Admin API      /api/*
   MCP endpoint   POST /mcp/{slug}          (Streamable HTTP JSON-RPC)
   Demo target    /demo-api/*               (bundled WellView-flavored API)  */
import { parseSpec, slugify, INTROSPECTION_QUERY } from "./importers.js";
import { handleRpc, hybridSearch, loadServer, parseToolRow } from "./mcp.js";
import { executeTool, mcpLog, newId, now } from "./runtime.js";
import { handleDemoApi, demoSpec } from "./demo.js";
import { handleFirstClass } from "./firstclass.js";
import { handleIgb } from "./igb.js";
import { handleDeploy } from "./deploy.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id" };
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
const httpErr = (status, detail) => json({ detail }, status);

const J = (row, keys = ["input_schema", "output_schema", "annotations", "mapping", "postprocess", "config", "args"]) => {
  if (!row) return row;
  for (const k of keys) {
    if (typeof row[k] === "string" && row[k]) { try { row[k] = JSON.parse(row[k]); } catch { /* keep */ } }
  }
  return row;
};
const all = r => (r?.results || []).map(x => J(x));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;
    try {
      if (path.startsWith("/demo-api/")) {
        if (path === "/demo-api/openapi-spec.json") return json(demoSpec(url.origin));
        return await handleDemoApi(request, path.slice("/demo-api".length));
      }
      // OAuth discovery probes from connector clients (Claude.ai, ChatGPT, Copilot):
      // a 404 here tells them "no auth required" — the SPA fallback's 200-HTML made them
      // believe an unfinishable auth step existed ("You are not connected yet").
      if (path.startsWith("/.well-known/") || path === "/register") {
        return json({ error: "not_found" }, 404, CORS);
      }
      const mcpMatch = path.match(/^\/mcp\/([\w-]+)$/);
      if (mcpMatch) {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
        if (request.method === "DELETE") return new Response(null, { status: 202, headers: CORS }); // session teardown
        if (request.method === "GET") {
          // Streamable HTTP: offer a server->client SSE stream with keepalive pings
          if ((request.headers.get("Accept") || "").includes("text/event-stream")) {
            const enc = new TextEncoder();
            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(enc.encode(": connected\n\n"));
                const t = setInterval(() => { try { controller.enqueue(enc.encode(": ping\n\n")); } catch { clearInterval(t); } }, 15000);
              },
            });
            return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...CORS } });
          }
          return new Response(null, { status: 405, headers: { Allow: "POST, GET, OPTIONS, DELETE", ...CORS } });
        }
        if (request.method !== "POST") return httpErr(405, "POST only");
        let body;
        try { body = await request.json(); } catch {
          return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
        }
        if (Array.isArray(body)) {
          const results = [];
          for (const msg of body) {
            const r = await handleRpc(db, mcpMatch[1], msg);
            if (r !== null) results.push(r);
          }
          return results.length ? json(results, 200, CORS) : new Response(null, { status: 202, headers: CORS });
        }
        const result = await handleRpc(db, mcpMatch[1], body);
        return result === null ? new Response(null, { status: 202, headers: CORS }) : json(result, 200, CORS);
      }
      if (path.startsWith("/api/")) return await handleApi(request, env, url, path);
      // static console
      return env.ASSETS.fetch(request);
    } catch (e) {
      return httpErr(500, `${e.name || "Error"}: ${e.message}`);
    }
  },
};

/* ============================================================ admin API */
async function handleApi(request, env, url, path) {
  const db = env.DB;
  const method = request.method;
  const body = ["POST", "PATCH", "PUT"].includes(method) ? await request.json().catch(() => ({})) : null;

  /* ---------- Deployment determination + workflow CAPTURE/REPLAY ---------- */
  if (path.startsWith("/api/deploy/") || path.startsWith("/api/workflows")) {
    const dp = await handleDeploy(request, env, url, path, body);
    if (dp) return dp;
  }

  /* ---------- Identity Graph Builder (INGEST → RESOLVE → APPROVE → GENERATE) ---------- */
  if (path.startsWith("/api/igb/")) {
    const igb = await handleIgb(request, env, url, path, body);
    if (igb) return igb;
  }

  /* ---------- first-class domains (IG / UDM / jurisdictions / reg / provenance / receipts) ---------- */
  const fc = await handleFirstClass(request, env, url, path, body);
  if (fc) return fc;

  /* ---------- import ---------- */
  if (path === "/api/import/preview" && method === "POST") {
    const protocol = body.protocol || "rest";
    let text = body.spec_text || "";
    if (body.spec_url && !text) text = await fetchSpec(protocol, body.spec_url);
    if (!text.trim()) return httpErr(400, "Provide spec_text or spec_url.");
    let parsed;
    try { parsed = parseSpec(protocol, text); } catch (e) { return httpErr(422, e.message); }
    parsed.spec_text = text;
    if (body.base_url) parsed.base = body.base_url;
    return json(parsed);
  }
  if (path === "/api/import/commit" && method === "POST") {
    const protocol = body.protocol || "rest";
    const text = body.spec_text || "";
    let parsed;
    try { parsed = parseSpec(protocol, text); } catch (e) { return httpErr(422, e.message); }
    const title = body.name || parsed.title;
    let slug = slugify(body.slug || title);
    if (await db.prepare("SELECT id FROM servers WHERE slug=?").bind(slug).first()) {
      slug = `${slug}-${newId("x").slice(-4)}`;
    }
    const ts = now();
    const srcId = newId("src");
    await db.prepare("INSERT INTO api_sources (id,name,protocol,base_url,spec_text,spec_url,tool_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(srcId, title, protocol, body.base_url || parsed.base || "", text, body.spec_url ?? null, parsed.count, ts, ts).run();
    const srvId = newId("srv");
    const desc = body.description || `Governed MCP bridge for ${title} — ${parsed.count} operations auto-generated as typed tools.`;
    await db.prepare(`INSERT INTO servers (id,slug,name,description,source_id,auth_profile_id,code_mode,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,1,?,?)`)
      .bind(srvId, slug, title + " Bridge", desc, srcId, body.auth_profile_id ?? null, body.code_mode ? 1 : 0, ts, ts).run();
    // batch tool inserts
    const stmts = parsed.tools.map(t => db.prepare(
      `INSERT INTO tools (id,server_id,name,method,path,summary,description,input_schema,output_schema,annotations,governance,mapping,postprocess,enabled,curated,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?,?)`)
      .bind(newId("tool"), srvId, t.name, t.method, t.path ?? null, t.summary ?? null, t.description ?? null,
        JSON.stringify(t.input_schema), t.output_schema ? JSON.stringify(t.output_schema) : null,
        JSON.stringify(t.annotations), t.governance ?? null, JSON.stringify(t.mapping), null, ts, ts));
    await db.batch(stmts);
    await mcpLog(db, slug, "notice", "bridge", `Bridge created: ${parsed.count} tools from ${protocol.toUpperCase()} source \`${title}\``);
    return json({ server_id: srvId, slug, source_id: srcId, tool_count: parsed.count, endpoint: `/mcp/${slug}` });
  }

  /* ---------- servers ---------- */
  const serverOut = async s => {
    const src = s.source_id ? await db.prepare("SELECT name,protocol,base_url,tool_count FROM api_sources WHERE id=?").bind(s.source_id).first() : null;
    const counts = await db.prepare("SELECT COUNT(*) c, SUM(enabled) e FROM tools WHERE server_id=?").bind(s.id).first();
    const stats = await db.prepare("SELECT COUNT(*) calls, AVG(latency_ms) avg_ms FROM invocations WHERE server_id=? AND ts>?")
      .bind(s.id, now() - 86400).first();
    return { ...s, protocol: src?.protocol, base_url: src?.base_url, source_name: src?.name,
      tool_count: counts?.c || 0, tools_enabled: counts?.e || 0,
      calls_24h: stats?.calls || 0, avg_ms_24h: Math.round((stats?.avg_ms || 0) * 10) / 10 };
  };
  const findServer = sid => db.prepare("SELECT * FROM servers WHERE id=? OR slug=?").bind(sid, sid).first();

  if (path === "/api/servers" && method === "GET") {
    const rows = all(await db.prepare("SELECT * FROM servers ORDER BY created_at DESC").all());
    return json(await Promise.all(rows.map(serverOut)));
  }
  let m = path.match(/^\/api\/servers\/([\w-]+)$/);
  if (m) {
    const s = await findServer(m[1]);
    if (!s) return httpErr(404, "server not found");
    if (method === "GET") return json(await serverOut(s));
    if (method === "PATCH") {
      const allowed = ["name", "description", "auth_profile_id", "code_mode", "enabled", "rate_limit_rps", "rate_burst", "max_retries", "timeout_s", "log_level"];
      const sets = [], vals = [];
      for (const [k, v] of Object.entries(body || {})) {
        if (allowed.includes(k)) {
          sets.push(`${k}=?`);
          vals.push(["code_mode", "enabled", "rate_burst", "max_retries"].includes(k) ? Number(v) || 0 : v);
        }
      }
      if (body.base_url !== undefined && s.source_id) {
        await db.prepare("UPDATE api_sources SET base_url=? WHERE id=?").bind(body.base_url, s.source_id).run();
      }
      if (sets.length) {
        await db.prepare(`UPDATE servers SET ${sets.join(", ")}, updated_at=? WHERE id=?`).bind(...vals, now(), s.id).run();
      }
      return json(await serverOut(await db.prepare("SELECT * FROM servers WHERE id=?").bind(s.id).first()));
    }
    if (method === "DELETE") {
      await db.prepare("DELETE FROM tools WHERE server_id=?").bind(s.id).run();
      if (s.source_id) await db.prepare("DELETE FROM api_sources WHERE id=?").bind(s.source_id).run();
      await db.prepare("DELETE FROM servers WHERE id=?").bind(s.id).run();
      return json({ deleted: s.id });
    }
  }

  /* ---------- tools ---------- */
  if (path === "/api/tools" && method === "GET") {
    const serverId = url.searchParams.get("server_id");
    const q = url.searchParams.get("q");
    const limit = Number(url.searchParams.get("limit")) || 500;
    let rows = serverId
      ? all(await db.prepare("SELECT * FROM tools WHERE server_id=? ORDER BY name LIMIT ?").bind(serverId, limit).all())
      : all(await db.prepare("SELECT * FROM tools ORDER BY name LIMIT ?").bind(limit).all());
    if (q) rows = hybridSearch(rows, q, 100);
    const servers = Object.fromEntries(all(await db.prepare("SELECT id,slug,name FROM servers").all()).map(s => [s.id, s]));
    for (const r of rows) {
      r.server_slug = servers[r.server_id]?.slug;
      r.server_name = servers[r.server_id]?.name;
    }
    return json(rows);
  }
  m = path.match(/^\/api\/tools\/([\w-]+)$/);
  if (m && method === "PATCH") {
    const t = await db.prepare("SELECT * FROM tools WHERE id=?").bind(m[1]).first();
    if (!t) return httpErr(404, "tool not found");
    const allowed = ["summary", "description", "enabled", "governance"];
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(body || {})) {
      if (allowed.includes(k)) { sets.push(`${k}=?`); vals.push(k === "enabled" ? Number(v) || 0 : v); }
    }
    if ("postprocess" in (body || {})) { sets.push("postprocess=?"); vals.push(body.postprocess ? JSON.stringify(body.postprocess) : null); }
    if ("input_schema" in (body || {})) { sets.push("input_schema=?"); vals.push(JSON.stringify(body.input_schema)); }
    if (sets.length) {
      sets.push("curated=1");
      await db.prepare(`UPDATE tools SET ${sets.join(", ")}, updated_at=? WHERE id=?`).bind(...vals, now(), m[1]).run();
    }
    return json(J(await db.prepare("SELECT * FROM tools WHERE id=?").bind(m[1]).first()));
  }
  m = path.match(/^\/api\/tools\/([\w-]+)\/test$/);
  if (m && method === "POST") {
    const t = J(await db.prepare("SELECT * FROM tools WHERE id=?").bind(m[1]).first());
    if (!t) return httpErr(404, "tool not found");
    const srv = await db.prepare("SELECT slug FROM servers WHERE id=?").bind(t.server_id).first();
    const [server, , auth] = await loadServer(db, srv.slug);
    const result = await executeTool(db, server, parseToolRow(t), body?.arguments || {}, auth, "console");
    return json(result);
  }

  /* ---------- auth profiles ---------- */
  const mask = cfg => {
    if (!cfg || typeof cfg !== "object") return {};
    return Object.fromEntries(Object.entries(cfg).map(([k, v]) =>
      [k, (["token", "password", "client_secret", "key"].includes(k) && v) ? String(v).slice(0, 3) + "•••" : v]));
  };
  if (path === "/api/auth-profiles" && method === "GET") {
    const rows = all(await db.prepare("SELECT * FROM auth_profiles ORDER BY created_at DESC").all());
    for (const r of rows) r.config = mask(r.config);
    return json(rows);
  }
  if (path === "/api/auth-profiles" && method === "POST") {
    const kind = body.kind || "none";
    if (!["none", "bearer", "basic", "apikey", "oauth2", "cognito"].includes(kind)) {
      return httpErr(422, "kind must be one of none|bearer|basic|apikey|oauth2|cognito");
    }
    const pid = newId("auth");
    const ts = now();
    await db.prepare("INSERT INTO auth_profiles (id,name,kind,config,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind(pid, body.name || kind, kind, JSON.stringify(body.config || {}), ts, ts).run();
    return json({ id: pid });
  }
  m = path.match(/^\/api\/auth-profiles\/([\w-]+)$/);
  if (m && method === "DELETE") {
    await db.prepare("UPDATE servers SET auth_profile_id=NULL WHERE auth_profile_id=?").bind(m[1]).run();
    await db.prepare("DELETE FROM auth_profiles WHERE id=?").bind(m[1]).run();
    return json({ deleted: m[1] });
  }

  /* ---------- analytics / logs / overview ---------- */
  if (path === "/api/analytics" && method === "GET") {
    return json(await analytics(db, Number(url.searchParams.get("hours")) || 24));
  }
  if (path === "/api/invocations" && method === "GET") {
    const limit = Number(url.searchParams.get("limit")) || 50;
    const conds = [], vals = [];
    if (url.searchParams.get("server_slug")) { conds.push("server_slug=?"); vals.push(url.searchParams.get("server_slug")); }
    if (url.searchParams.get("status")) { conds.push("status=?"); vals.push(url.searchParams.get("status")); }
    const sql = "SELECT * FROM invocations" + (conds.length ? " WHERE " + conds.join(" AND ") : "") + " ORDER BY ts DESC LIMIT ?";
    return json(all(await db.prepare(sql).bind(...vals, limit).all()));
  }
  if (path === "/api/mcp-logs" && method === "GET") {
    const limit = Number(url.searchParams.get("limit")) || 100;
    const slug = url.searchParams.get("server_slug");
    const rows = slug
      ? all(await db.prepare("SELECT * FROM mcp_logs WHERE server_slug=? ORDER BY ts DESC LIMIT ?").bind(slug, limit).all())
      : all(await db.prepare("SELECT * FROM mcp_logs ORDER BY ts DESC LIMIT ?").bind(limit).all());
    for (const r of rows) { if (typeof r.data === "string" && r.data) { try { r.data = JSON.parse(r.data); } catch { /* keep */ } } }
    return json(rows);
  }
  if (path === "/api/overview" && method === "GET") {
    const servers = all(await db.prepare("SELECT * FROM servers").all());
    const tools = await db.prepare("SELECT COUNT(*) c, SUM(enabled) e FROM tools").first();
    const a = await analytics(db, 24);
    const recent = all(await db.prepare("SELECT * FROM invocations ORDER BY ts DESC LIMIT 8").all());
    return json({
      servers: servers.length,
      servers_live: servers.filter(s => s.enabled).length,
      tools: tools?.c || 0, tools_enabled: tools?.e || 0,
      sources: (await db.prepare("SELECT COUNT(*) c FROM api_sources").first())?.c || 0,
      auth_profiles: (await db.prepare("SELECT COUNT(*) c FROM auth_profiles").first())?.c || 0,
      analytics: a, recent, base_url: url.origin,
    });
  }
  /* ---------- UDM Registry (Universal Decoding Matrix crosswalk) ---------- */
  if (path === "/api/udm" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    let rows = (await db.prepare("SELECT * FROM udm_crosswalk ORDER BY ontology_id").all()).results;
    if (q) {
      rows = rows.filter(r =>
        ["ontology_id", "industry", "isic_section", "isic_division", "isic_title", "naics_bridge", "gics_sector", "gics_industry"]
          .some(k => String(r[k] || "").toLowerCase().includes(q)));
    }
    const total = (await db.prepare("SELECT COUNT(*) c FROM udm_crosswalk").first())?.c || 0;
    return json({ total, count: rows.length, rows });
  }
  m = path.match(/^\/api\/udm\/([\w-]+)$/);
  if (m && method === "GET") {
    const r = await db.prepare("SELECT * FROM udm_crosswalk WHERE ontology_id=?").bind(m[1]).first();
    return r ? json(r) : httpErr(404, "ontology id not found");
  }

  m = path.match(/^\/api\/export\/([\w-]+)$/);
  if (m && method === "GET") {
    const s = await findServer(m[1]);
    if (!s) return httpErr(404, "server not found");
    const src = s.source_id ? await db.prepare("SELECT * FROM api_sources WHERE id=?").bind(s.source_id).first() : {};
    const tools = all(await db.prepare("SELECT name,method,path,summary,description,input_schema,output_schema,annotations,governance,mapping,postprocess,enabled FROM tools WHERE server_id=?").bind(s.id).all());
    const manifest = {
      iosmcp_bridge_manifest: 1,
      exported_at: new Date().toISOString(),
      server: Object.fromEntries(["slug", "name", "description", "code_mode", "rate_limit_rps", "rate_burst", "max_retries", "timeout_s"].map(k => [k, s[k]])),
      source: { protocol: src?.protocol, base_url: src?.base_url, name: src?.name },
      tools,
    };
    return json(manifest, 200, { "Content-Disposition": `attachment; filename="${s.slug}-manifest.json"` });
  }
  return httpErr(404, "not found");
}

async function fetchSpec(protocol, specUrl) {
  try {
    if (protocol === "graphql") {
      const r = await fetch(specUrl, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: INTROSPECTION_QUERY }) });
      const text = await r.text();
      if (r.ok && text.includes("__schema")) return text;
    }
    const r = await fetch(specUrl);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    throw Object.assign(new Error(`Could not fetch spec from URL: ${e.message}`), { httpStatus: 502 });
  }
}

async function analytics(db, hours) {
  const since = now() - hours * 3600;
  const tot = await db.prepare(`SELECT COUNT(*) calls, SUM(status='ok') ok, SUM(status!='ok') errs,
    AVG(latency_ms) avg_ms, SUM(tokens_est) tokens, SUM(tokens_saved_est) tokens_saved,
    SUM(resp_bytes) bytes_out FROM invocations WHERE ts>?`).bind(since).first() || {};
  const lat = (await db.prepare("SELECT latency_ms FROM invocations WHERE ts>? AND latency_ms IS NOT NULL ORDER BY latency_ms").bind(since).all())
    .results.map(r => r.latency_ms);
  const pct = p => lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] * 10) / 10 : 0;
  const buckets = Array(24).fill(0), errs = Array(24).fill(0), lats = Array.from({ length: 24 }, () => []);
  const span = hours * 3600 / 24;
  for (const r of (await db.prepare("SELECT ts,status,latency_ms FROM invocations WHERE ts>?").bind(since).all()).results) {
    const i = Math.min(23, Math.floor((r.ts - since) / span));
    buckets[i] += 1;
    if (r.status !== "ok") errs[i] += 1;
    if (r.latency_ms) lats[i].push(r.latency_ms);
  }
  const perTool = (await db.prepare(`SELECT tool_name, server_slug, COUNT(*) calls, AVG(latency_ms) avg_ms,
    SUM(status!='ok') errs, SUM(tokens_est) tokens FROM invocations WHERE ts>? GROUP BY tool_name, server_slug ORDER BY calls DESC LIMIT 25`).bind(since).all()).results;
  const statusMix = (await db.prepare("SELECT status, COUNT(*) n FROM invocations WHERE ts>? GROUP BY status").bind(since).all()).results;
  const calls = tot.calls || 0;
  return {
    totals: { calls, ok: tot.ok || 0, errors: tot.errs || 0,
      avg_ms: Math.round((tot.avg_ms || 0) * 10) / 10, p50_ms: pct(0.5), p95_ms: pct(0.95),
      tokens: tot.tokens || 0, tokens_saved: tot.tokens_saved || 0, bytes_out: tot.bytes_out || 0,
      error_rate: Math.round(1000 * (tot.errs || 0) / Math.max(1, calls)) / 10 },
    series: { calls: buckets, errors: errs, avg_ms: lats.map(x => x.length ? Math.round(x.reduce((a, b) => a + b, 0) / x.length * 10) / 10 : 0) },
    per_tool: perTool,
    status_mix: statusMix,
  };
}
