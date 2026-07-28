/* MCP protocol (Streamable HTTP, JSON-RPC 2.0) with Code Mode meta-tools
   and hybrid keyword search — Workers port. */
import { executeTool, mcpLog, newId, now } from "./runtime.js";
import { CORE_TOOLS, callCoreTool, makeReceipt } from "./core.js";

export const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "iosmcp-gateway-bridge", version: "1.0.0" };
const LOG_LEVELS = { debug: 0, info: 1, notice: 2, warning: 3, error: 4 };

/* ---------------- hybrid search: keyword TF + substring boosts + bigram similarity */
const terms = s => (String(s || "").match(/[a-zA-Z0-9]+/g) || []).map(w => w.toLowerCase());
function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}
export function hybridSearch(tools, query, limit = 10) {
  const qt = terms(query);
  if (!qt.length) return tools.slice(0, limit);
  const scored = [];
  for (const t of tools) {
    const hay = `${t.name} ${t.summary || ""} ${t.description || ""} ${t.path || ""} ${t.method || ""}`;
    const ht = terms(hay);
    const counts = {};
    for (const w of ht) counts[w] = (counts[w] || 0) + 1;
    const kw = qt.reduce((a, w) => a + (counts[w] || 0), 0);
    const name = t.name.toLowerCase();
    const q = query.toLowerCase();
    const boost = q === name ? 4 : name.includes(q) ? 2 : 0;
    const fuzzy = similarity(qt.join(" "), ht.join(" ").slice(0, 400));
    const score = kw + boost + fuzzy * 1.5;
    if (kw || boost || fuzzy > 0.28) scored.push([score, t]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(x => x[1]);
}

/* ---------------- code-mode meta tools */
export function codeModeTools(server, count) {
  return [
    {
      name: "list_apis",
      summary: `Discover endpoints across ${count} bridged operations by keyword search.`,
      description: `Search the ${count} bridged operations of \`${server.name}\` by keyword/semantic query. Returns matching tool names, methods and one-line summaries. Call \`describe_api\` to get the full input schema before invoking.`,
      input_schema: { type: "object", properties: {
        query: { type: "string", description: "Keyword or natural-language search over names, paths and docs." },
        limit: { type: "integer", description: "Max results (default 10).", default: 10 },
      }, required: ["query"] },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "describe_api",
      summary: "Fetch the full typed input/output schema and docs for one endpoint.",
      description: "Returns the complete JSON input schema, output schema, annotations and governance for a named operation discovered via `list_apis`.",
      input_schema: { type: "object", properties: {
        name: { type: "string", description: "Exact tool name from `list_apis`." },
      }, required: ["name"] },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "invoke_api",
      summary: "Execute any discovered endpoint by name with validated arguments.",
      description: "Executes a named operation with the given arguments. Inputs are schema-validated, mapped to the upstream call, authenticated, rate-limited and post-processed by the Bridge.",
      input_schema: { type: "object", properties: {
        name: { type: "string", description: "Exact tool name from `list_apis`." },
        arguments: { type: "object", description: "Arguments matching the schema from `describe_api`." },
      }, required: ["name"] },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ];
}

function toolToMcp(t) {
  const d = {
    name: t.name,
    description: (t.description || t.summary || "").slice(0, 1000) || t.name,
    inputSchema: t.input_schema || { type: "object", properties: {} },
  };
  if (t.annotations) {
    d.annotations = Object.fromEntries(Object.entries(t.annotations)
      .filter(([k]) => ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint", "title"].includes(k)));
  }
  if (t.output_schema) d.outputSchema = t.output_schema;
  return d;
}

/* ---------------- server context (D1) */
const J = (row, keys) => {
  if (!row) return row;
  for (const k of keys) {
    if (typeof row[k] === "string" && row[k]) { try { row[k] = JSON.parse(row[k]); } catch { /* keep */ } }
  }
  return row;
};
export const parseToolRow = t => J(t, ["input_schema", "output_schema", "annotations", "mapping", "postprocess"]);

export async function loadServer(db, slug) {
  const s = await db.prepare("SELECT * FROM servers WHERE slug=?").bind(slug).first();
  if (!s) return [null, null, null];
  const src = s.source_id ? await db.prepare("SELECT * FROM api_sources WHERE id=?").bind(s.source_id).first() : null;
  s.base_url = src?.base_url || "";
  const auth = s.auth_profile_id
    ? J(await db.prepare("SELECT * FROM auth_profiles WHERE id=?").bind(s.auth_profile_id).first(), ["config"])
    : null;
  const tools = (await db.prepare("SELECT * FROM tools WHERE server_id=? ORDER BY name").bind(s.id).all()).results.map(parseToolRow);
  return [s, tools, auth];
}

async function log(db, server, level, message, data) {
  if ((LOG_LEVELS[level] ?? 1) >= (LOG_LEVELS[server.log_level || "info"] ?? 1)) {
    await mcpLog(db, server.slug, level, "bridge", message, data);
  }
}

/* ---------------- JSON-RPC */
const err = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const res = (id, result) => ({ jsonrpc: "2.0", id: id ?? null, result });
const toolResult = r => {
  const out = { content: [{ type: "text", text: r.text }], isError: !r.ok };
  if (r.meta) out._meta = { "iosmcp.bridge": r.meta };
  return out;
};
const toolError = msg => ({ content: [{ type: "text", text: msg }], isError: true });

/* ---------------- ios-core: the governed deterministic tool surface ---------------- */
async function handleCoreRpc(db, body) {
  const method = body.method, id = body.id, params = body.params || {};
  if (method === "initialize") {
    await mcpLog(db, "ios-core", "info", "core", `initialize from client ${params.clientInfo?.name || "unknown"}`);
    return res(id, {
      protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true }, logging: {} },
      serverInfo: { name: "iosmcp-gateway-bridge", version: "1.0.0", title: "IOS+ Core — Identity Graph × UDM" },
      instructions: "Deterministic, cited, receipted answers from the Identity Graph and the Universal Decoding Matrix. " +
        "This server originates obligations and decides truth; AI clients render and route. " +
        "Outside the closed world it returns NO_DETERMINATION — it never guesses.",
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "ping") return res(id, {});
  if (method === "tools/list") return res(id, { tools: CORE_TOOLS.map(toolToMcp) });
  if (method === "tools/call") {
    const name = params.name, args = params.arguments || {};
    const t0 = Date.now();
    const invId = newId("inv");
    try {
      const result = await callCoreTool(db, name, args, { invocation_id: invId });
      const failed = result.status === "NO_DETERMINATION" || result.valid === false;
      const text = JSON.stringify(result, null, 2);
      await db.prepare(`INSERT INTO invocations (id,server_id,server_slug,tool_name,method,path,status,http_status,latency_ms,resp_bytes,tokens_est,via,ts)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(invId, "ios-core", "ios-core", name, "CORE", name, failed ? "no_determination" : "ok", 200,
          Date.now() - t0, text.length, Math.floor(text.length / 4), "mcp", now()).run();
      const out = { content: [{ type: "text", text }], isError: false };
      if (result.receipt_id) out._meta = { "iosmcp.core": { receipt_id: result.receipt_id, chain_hash: result.chain_hash, status: result.status } };
      return res(id, out);
    } catch (e) {
      return res(id, toolError(`Core engine error: ${e.message}`));
    }
  }
  if (method && method.startsWith("notifications/")) return null;
  if (method === "resources/list") return res(id, { resources: [] });
  if (method === "prompts/list") return res(id, { prompts: [] });
  return err(id, -32601, `Method not found: ${method}`);
}

export async function handleRpc(db, slug, body) {
  if (slug === "ios-core") return await handleCoreRpc(db, body);
  const [server, tools, auth] = await loadServer(db, slug);
  if (!server) return err(body.id, -32001, `No MCP server found at /mcp/${slug}`);
  const method = body.method;
  const id = body.id;
  const params = body.params || {};

  if (method === "initialize") {
    await log(db, server, "info", `initialize from client ${params.clientInfo?.name || "unknown"}`);
    return res(id, {
      protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true }, logging: {} },
      serverInfo: { ...SERVER_INFO, title: server.name },
      instructions: (server.description || "") +
        "\nThis server is a governed IOS+ Gateway Bridge: every call is schema-validated, authenticated, rate-limited, receipted and post-processed.",
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "ping") return res(id, {});
  if (method === "logging/setLevel") {
    await db.prepare("UPDATE servers SET log_level=? WHERE id=?").bind(params.level || "info", server.id).run();
    await log(db, server, "notice", `log level set to ${params.level || "info"}`);
    return res(id, {});
  }

  const enabled = tools.filter(t => t.enabled);
  if (method === "tools/list") {
    const listed = server.code_mode
      ? codeModeTools(server, enabled.length).map(toolToMcp)
      : enabled.map(toolToMcp);
    await log(db, server, "debug", `tools/list → ${listed.length} tools (code_mode=${!!server.code_mode})`);
    return res(id, { tools: listed });
  }
  if (method === "tools/call") {
    const name = params.name;
    const args = params.arguments || {};
    await log(db, server, "info", `tools/call ${name}`, { args_keys: Object.keys(args) });
    if (server.code_mode && ["list_apis", "describe_api", "invoke_api"].includes(name)) {
      return await callMeta(db, server, enabled, auth, id, name, args);
    }
    const tool = enabled.find(t => t.name === name);
    if (!tool) return res(id, toolError(`Unknown tool \`${name}\`. Use tools/list to see available tools.`));
    if (tool.mapping?.kind === "core") return res(id, await executeCoreMapped(db, server, tool, args));
    const result = await executeTool(db, server, tool, args, auth, "mcp");
    if (!result.ok) await log(db, server, "warning", `${name} failed: ${result.text.slice(0, 200)}`);
    return res(id, toolResult(result));
  }
  if (method && method.startsWith("notifications/")) return null;
  if (method === "resources/list") return res(id, { resources: [] });
  if (method === "prompts/list") return res(id, { prompts: [] });
  return err(id, -32601, `Method not found: ${method}`);
}

/* ---------------- package-provisioned tools: execute against the governed core ----------------
   Identity Graph Builder packages provision servers whose tools map to core engine
   operations for a fixed tenant — deterministic, cited, receipted. No upstream API needed. */
async function executeCoreMapped(db, server, tool, args) {
  const t0 = Date.now();
  const invId = newId("inv");
  const m = tool.mapping || {};
  let result;
  try {
    if (["graph_position", "determine", "report_due", "segment_response"].includes(m.op)) {
      const coreArgs = { tenant_id: m.tenant_id };
      if (m.op === "report_due" && args?.period) coreArgs.period = args.period;
      if (m.op === "segment_response") Object.assign(coreArgs, { text: args?.text, conversation_id: args?.conversation_id, turn_no: args?.turn_no });
      result = await callCoreTool(db, m.op, coreArgs, { invocation_id: invId, source: "mcp:" + server.slug });
    } else if (m.op === "udm_search") {
      const q = `%${(args?.query || "").toLowerCase()}%`;
      const codes = (await db.prepare(
        "SELECT system_id, code, title FROM codes WHERE lower(code) LIKE ? OR lower(title) LIKE ? LIMIT 15").bind(q, q).all()).results;
      const reqs = (await db.prepare(
        `SELECT r.name, r.frequency, b.acronym, f.form_code FROM reporting_requirements r
         JOIN regulatory_bodies b ON b.id=r.body_id LEFT JOIN reporting_forms f ON f.id=r.form_id
         WHERE lower(r.name) LIKE ? LIMIT 15`).bind(q).all()).results;
      const out = { status: (codes.length || reqs.length) ? "DETERMINED" : "NO_DETERMINATION",
        query: args?.query || "", lattice_matches: codes, obligation_matches: reqs,
        note: "Governed search answers only from the UDM lattice and the reporting matrix — the closed world." };
      const citations = [{ source_id: "src_udm_master", source: "Universal Decoding Matrix — Master Workbook", cited_for: "lattice search" }];
      const r = await makeReceipt(db, { kind: "tool_invocation", subject: tool.name, tenant_id: m.tenant_id,
        input: { tool: tool.name, args: args || {} }, output: out, citations, invocation_id: invId });
      result = { ...out, citations, ...r };
    } else { // capability_info — provisioned capability awaiting an upstream connector binding
      const out = { status: "PROVISIONED_PENDING_BINDING", capability: m.capability, package_id: m.package_id,
        note: `The '${m.capability}' capability is provisioned and governed, but its upstream data source is not yet bound. ` +
          "Bind a connector (Gateway Bridge → Import API) to activate live execution. Until then this tool reports its manifest only.",
        governance: tool.governance };
      const r = await makeReceipt(db, { kind: "tool_invocation", subject: tool.name, tenant_id: m.tenant_id,
        input: { tool: tool.name, args: args || {} }, output: out, invocation_id: invId });
      result = { ...out, ...r };
    }
    const failed = result.status === "NO_DETERMINATION" || result.valid === false;
    const text = JSON.stringify(result, null, 2);
    await db.prepare(`INSERT INTO invocations (id,server_id,server_slug,tool_name,method,path,status,http_status,latency_ms,resp_bytes,tokens_est,via,ts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(invId, server.id, server.slug, tool.name, "CORE", m.op || tool.name,
        failed ? "no_determination" : "ok", 200, Date.now() - t0, text.length, Math.floor(text.length / 4), "mcp", now()).run();
    const out = { content: [{ type: "text", text }], isError: false };
    if (result.receipt_id) out._meta = { "iosmcp.core": { receipt_id: result.receipt_id, chain_hash: result.chain_hash, status: result.status } };
    return out;
  } catch (e) {
    return toolError(`Core-mapped execution error: ${e.message}`);
  }
}

async function callMeta(db, server, tools, auth, id, name, args) {
  if (name === "list_apis") {
    const hits = hybridSearch(tools, args.query || "", Number(args.limit) || 10);
    const lines = hits.map(t => ({ name: t.name, method: t.method, path: t.path, summary: t.summary, governance: t.governance }));
    return res(id, { content: [{ type: "text", text: JSON.stringify({ matches: lines, total_searched: tools.length }, null, 2) }], isError: false });
  }
  if (name === "describe_api") {
    const t = tools.find(x => x.name === args.name);
    if (!t) return res(id, toolError(`No operation named \`${args.name}\`. Use list_apis first.`));
    return res(id, { content: [{ type: "text", text: JSON.stringify({
      name: t.name, method: t.method, path: t.path, summary: t.summary, description: t.description,
      inputSchema: t.input_schema, outputSchema: t.output_schema, annotations: t.annotations, governance: t.governance,
    }, null, 2) }], isError: false });
  }
  if (name === "invoke_api") {
    const t = tools.find(x => x.name === args.name);
    if (!t) return res(id, toolError(`No operation named \`${args.name}\`. Use list_apis first.`));
    const result = await executeTool(db, server, t, args.arguments || {}, auth, "mcp");
    return res(id, toolResult(result));
  }
  return res(id, toolError(`Unknown meta tool ${name}`));
}
