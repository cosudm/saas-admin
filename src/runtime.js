/* Runtime execution engine: validation, parameter mapping, auth injection,
   rate limiting, retries, and response post-processing — Workers port. */

export const newId = p => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
export const now = () => Date.now() / 1000;

/* ---------------- rate limiting (token bucket, per-isolate best effort) */
const buckets = new Map();
export function checkRate(server) {
  const rate = Math.max(Number(server.rate_limit_rps) || 10, 0.01);
  const burst = Math.max(Number(server.rate_burst) || 20, 1);
  let b = buckets.get(server.id);
  if (!b || b.rate !== rate || b.burst !== burst) {
    b = { rate, burst, tokens: burst, last: Date.now() };
    buckets.set(server.id, b);
  }
  const t = Date.now();
  b.tokens = Math.min(b.burst, b.tokens + ((t - b.last) / 1000) * b.rate);
  b.last = t;
  if (b.tokens >= 1) { b.tokens -= 1; return true; }
  return false;
}

/* ---------------- auth */
const oauthCache = new Map();
export async function applyAuth(profile, headers, params) {
  if (!profile) return;
  let cfg = profile.config || {};
  if (typeof cfg === "string") { try { cfg = JSON.parse(cfg); } catch { cfg = {}; } }
  const kind = profile.kind || "none";
  if (kind === "bearer") headers.Authorization = `Bearer ${cfg.token || ""}`;
  else if (kind === "basic") headers.Authorization = "Basic " + btoa(`${cfg.username || ""}:${cfg.password || ""}`);
  else if (kind === "apikey") {
    const name = cfg.name || "X-API-Key";
    if ((cfg.in || "header") === "query") params[name] = cfg.key || "";
    else headers[name] = cfg.key || "";
  } else if (kind === "oauth2") {
    headers.Authorization = `Bearer ${await oauth2Token(profile.id, cfg)}`;
  } else if (kind === "cognito") {
    headers.Authorization = `Bearer ${await cognitoToken(profile.id, cfg)}`;
  }
}
async function oauth2Token(pid, cfg) {
  const cached = oauthCache.get(pid);
  if (cached && cached.exp > now() + 30) return cached.tok;
  const data = new URLSearchParams({
    grant_type: cfg.grant_type || "client_credentials",
    client_id: cfg.client_id || "",
    client_secret: cfg.client_secret || "",
  });
  if (cfg.scope) data.set("scope", cfg.scope);
  if (cfg.audience) data.set("audience", cfg.audience);
  const r = await fetch(cfg.token_url || "", { method: "POST", body: data });
  if (!r.ok) throw new Error(`OAuth2 token request failed (${r.status})`);
  const j = await r.json();
  oauthCache.set(pid, { tok: j.access_token || "", exp: now() + (Number(j.expires_in) || 3600) });
  return j.access_token || "";
}
async function cognitoToken(pid, cfg) {
  const cached = oauthCache.get(pid);
  if (cached && cached.exp > now() + 30) return cached.tok;
  const region = cfg.region || "us-east-1";
  const r = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth" },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: cfg.client_id || "",
      AuthParameters: { USERNAME: cfg.username || "", PASSWORD: cfg.password || "" },
    }),
  });
  if (!r.ok) throw new Error(`Cognito auth failed (${r.status}): ${(await r.text()).slice(0, 200)} — the app client must allow USER_PASSWORD_AUTH.`);
  const res = (await r.json()).AuthenticationResult || {};
  const tok = cfg.use_id_token ? res.IdToken : res.AccessToken;
  oauthCache.set(pid, { tok: tok || "", exp: now() + (Number(res.ExpiresIn) || 3300) });
  return tok || "";
}

/* ---------------- validation (lean JSON-schema subset: required + types + enum) */
class ToolError extends Error {
  constructor(message, status = "error", httpStatus = null) { super(message); this.status = status; this.httpStatus = httpStatus; }
}
const TYPE_OK = {
  string: v => typeof v === "string",
  integer: v => Number.isInteger(v),
  number: v => typeof v === "number",
  boolean: v => typeof v === "boolean",
  array: v => Array.isArray(v),
  object: v => v !== null && typeof v === "object" && !Array.isArray(v),
};
export function validateArgs(tool, args) {
  const schema = tool.input_schema || { type: "object" };
  args = args || {};
  for (const rq of schema.required || []) {
    if (!(rq in args)) throw new ToolError(`Input validation failed: '${rq}' is a required property (at root)`, "validation_error");
  }
  for (const [k, v] of Object.entries(args)) {
    const ps = schema.properties?.[k];
    if (!ps) continue;
    const chk = TYPE_OK[ps.type];
    if (chk && !chk(v)) {
      // allow numeric strings for numbers/integers? be strict like jsonschema
      throw new ToolError(`Input validation failed: '${k}' is not of type '${ps.type}' (at ${k})`, "validation_error");
    }
    if (Array.isArray(ps.enum) && !ps.enum.includes(v)) {
      throw new ToolError(`Input validation failed: '${k}' is not one of ${JSON.stringify(ps.enum)} (at ${k})`, "validation_error");
    }
  }
}

/* ---------------- post-processing */
function getPath(obj, path) {
  const parts = path.match(/[^.\[\]]+|\[\*\]|\[\d+\]/g) || [];
  let cur = [obj];
  for (const p of parts) {
    const nxt = [];
    for (const c of cur) {
      if (p === "[*]") { if (Array.isArray(c)) nxt.push(...c); }
      else if (p.startsWith("[")) {
        const i = parseInt(p.slice(1, -1));
        if (Array.isArray(c) && i >= -c.length && i < c.length) nxt.push(c.at(i));
      } else if (c && typeof c === "object" && p in c) nxt.push(c[p]);
    }
    cur = nxt;
  }
  if (!cur.length) return null;
  return cur.length > 1 ? cur : cur[0];
}
const pickF = (o, f) => Array.isArray(o) ? o.map(x => pickF(x, f)) :
  (o && typeof o === "object") ? Object.fromEntries(f.filter(k => k in o).map(k => [k, o[k]])) : o;
const omitF = (o, f) => Array.isArray(o) ? o.map(x => omitF(x, f)) :
  (o && typeof o === "object") ? Object.fromEntries(Object.entries(o).filter(([k]) => !f.includes(k))) : o;

export function postprocess(data, rules) {
  if (!rules) return [data, null];
  const note = [];
  try {
    if (rules.jsonpath) { data = getPath(data, rules.jsonpath); note.push(`path=${rules.jsonpath}`); }
    if (rules.first_n && Array.isArray(data)) { data = data.slice(0, Number(rules.first_n)); note.push(`first ${rules.first_n}`); }
    if (rules.pick?.length) { data = pickF(data, rules.pick); note.push("pick " + rules.pick.join(",")); }
    if (rules.omit?.length) { data = omitF(data, rules.omit); note.push("omit " + rules.omit.join(",")); }
    const agg = rules.aggregate;
    if (agg && Array.isArray(data)) {
      const op = agg.op || "count", field = agg.field;
      const vals = field ? data.map(x => (x && typeof x === "object") ? x[field] : undefined) : data;
      const nums = vals.filter(v => typeof v === "number");
      if (op === "count") data = { count: data.length };
      else if (op === "sum") data = { sum: nums.reduce((a, b) => a + b, 0), count: data.length };
      else if (op === "avg") data = { avg: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null, count: data.length };
      else if (op === "min") data = { min: nums.length ? Math.min(...nums) : null };
      else if (op === "max") data = { max: nums.length ? Math.max(...nums) : null };
      note.push(`aggregate ${op}(${field || "*"})`);
    }
  } catch (e) { note.push(`postprocess error: ${e.message}`); }
  return [data, note.length ? note.join("; ") : null];
}

/* ---------------- request building */
const xmlEscape = v => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildRequest(kind, base, tool, mapping, args, headers, params) {
  if (kind === "rest") {
    let path = tool.path || "/";
    const paramIn = mapping.param_in || {};
    const body = {};
    let content;
    for (const [k, v] of Object.entries(args)) {
      const loc = paramIn[k] || "query";
      if (loc === "path") path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
      else if (loc === "header") headers[k] = String(v);
      else if (loc === "body") {
        const key = (k.startsWith("body_") && (mapping.body_fields || []).includes(k.slice(5))) ? k.slice(5) : k;
        body[key] = v;
      } else if (loc === "rawbody") content = v;
      else params[k] = v;
    }
    const missing = [...path.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    if (missing.length) throw new ToolError(`Missing required path parameter(s): ${missing.join(", ")}`, "validation_error");
    const url = path.startsWith("http") ? path : base + path;
    const method = tool.method || "GET";
    const req = { method, url, headers, params };
    if (content !== undefined) req.json = content;
    else if (Object.keys(body).length && !["GET", "HEAD"].includes(method)) req.json = body;
    return req;
  }
  if (kind === "graphql") {
    const field = mapping.field, op = mapping.operation || "query";
    const argTypes = mapping.arg_types || {};
    const keys = Object.keys(args);
    const varDefs = keys.map(k => `$${k}: ${argTypes[k] || "String"}`).join(", ");
    const argList = keys.map(k => `${k}: $${k}`).join(", ");
    const q = `${op} Bridge${varDefs ? `(${varDefs})` : ""} { ${field}${argList ? `(${argList})` : ""} }`;
    headers["Content-Type"] = "application/json";
    return { method: "POST", url: base || mapping.endpoint || "", headers, params, json: { query: q, variables: args } };
  }
  if (kind === "soap") {
    const ns = mapping.namespace || "urn:bridge";
    const el = mapping.element || mapping.operation;
    const parts = Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join("");
    const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${el} xmlns="${ns}">${parts}</${el}></soap:Body></soap:Envelope>`;
    headers["Content-Type"] = "text/xml; charset=utf-8";
    headers.SOAPAction = `"${mapping.soap_action || ""}"`;
    return { method: "POST", url: base || mapping.endpoint || "", headers, params, content: envelope };
  }
  if (kind === "grpc") {
    headers["Content-Type"] = "application/json";
    return { method: "POST", url: `${base}/${mapping.service}/${mapping.rpc}`, headers, params, json: args };
  }
  throw new ToolError(`Unknown mapping kind '${kind}'`);
}

async function sendWithRetries(req, timeoutS, retries) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const u = new URL(req.url);
      for (const [k, v] of Object.entries(req.params || {})) u.searchParams.set(k, String(v));
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutS * 1000);
      const resp = await fetch(u.toString(), {
        method: req.method,
        headers: req.headers,
        body: req.json !== undefined ? JSON.stringify(req.json) : (req.content ?? undefined),
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if ([429, 502, 503, 504].includes(resp.status) && attempt < retries) {
        await new Promise(r => setTimeout(r, Math.min(2 ** attempt * 500, 4000)));
        continue;
      }
      return resp;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, Math.min(2 ** attempt * 500, 4000)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/* Minimal XML → dict for SOAP responses */
function xmlToDict(xml) {
  xml = xml.replace(/<\?xml[^>]*\?>/, "").trim();
  const parseNode = (s) => {
    const out = {};
    const re = /<([\w:.-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>|<([\w:.-]+)(?:\s[^>]*)?\/>/g;
    let m, found = false;
    while ((m = re.exec(s))) {
      found = true;
      const tag = (m[1] || m[3]).split(":").pop();
      const inner = m[2] ?? "";
      const val = /<[\w:.-]+[\s>]/.test(inner) ? parseNode(inner) : inner.trim();
      if (tag in out) {
        if (!Array.isArray(out[tag])) out[tag] = [out[tag]];
        out[tag].push(val);
      } else out[tag] = val;
    }
    return found ? out : s.trim();
  };
  return parseNode(xml);
}

async function parseResponse(kind, resp) {
  const ctype = resp.headers.get("content-type") || "";
  const text = await resp.text();
  if (kind === "soap" || ctype.includes("xml")) {
    try { return xmlToDict(text); } catch { return text; }
  }
  let data;
  try { data = JSON.parse(text); } catch { return text; }
  if (kind === "graphql" && data && typeof data === "object") {
    if (data.errors) return { errors: data.errors, data: data.data };
    return data.data ?? data;
  }
  return data;
}

/* ---------------- invocation logging (D1) */
async function logInvocation(db, inv) {
  try {
    await db.prepare(`INSERT INTO invocations (id,server_id,server_slug,tool_name,method,path,status,http_status,latency_ms,
      req_bytes,resp_bytes,resp_bytes_raw,tokens_est,tokens_saved_est,error,args,via,ts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(inv.id, inv.server_id ?? null, inv.server_slug ?? null, inv.tool_name ?? null, inv.method ?? null,
        inv.path ?? null, inv.status ?? null, inv.http_status ?? null, inv.latency_ms ?? null,
        inv.req_bytes || 0, inv.resp_bytes || 0, inv.resp_bytes_raw || 0,
        inv.tokens_est || 0, inv.tokens_saved_est || 0,
        inv.error ?? null, inv.args ?? null, inv.via || "mcp", inv.ts).run();
  } catch { /* best effort */ }
}
export async function mcpLog(db, slug, level, logger, message, data) {
  try {
    await db.prepare("INSERT INTO mcp_logs (server_slug,level,logger,message,data,ts) VALUES (?,?,?,?,?,?)")
      .bind(slug, level, logger, message, data ? JSON.stringify(data).slice(0, 2000) : null, now()).run();
  } catch { /* best effort */ }
}

const estTokens = n => Math.max(0, Math.floor(n / 4));

/* ---------------- main execution */
export async function executeTool(db, server, tool, args, authProfile, via = "mcp") {
  const t0 = Date.now();
  const inv = {
    id: newId("inv"), server_id: server.id, server_slug: server.slug,
    tool_name: tool.name, method: tool.method, path: tool.path,
    args: JSON.stringify(args || {}).slice(0, 4000), via, ts: now(),
  };
  const fail = async (status, msg) => {
    inv.status = status; inv.error = msg; inv.latency_ms = Date.now() - t0;
    await logInvocation(db, inv);
    return { ok: false, text: `[${status}] ${msg}`, meta: { latency_ms: inv.latency_ms } };
  };
  try {
    if (!server.enabled) return await fail("denied", "This MCP server is disabled.");
    if (!tool.enabled) return await fail("denied", `Tool \`${tool.name}\` is disabled by the operator.`);
    if (!checkRate(server)) return await fail("rate_limited", "Rate limit exceeded for this MCP server — retry shortly.");
    validateArgs(tool, args);

    const mapping = tool.mapping || {};
    const kind = mapping.kind || "rest";
    const base = (server.base_url || "").replace(/\/$/, "");
    const timeout = Number(server.timeout_s) || 30;
    const retries = Number(server.max_retries) || 0;

    const headers = { Accept: "application/json" };
    const params = {};
    await applyAuth(authProfile, headers, params);

    const req = buildRequest(kind, base, tool, mapping, args || {}, headers, params);
    inv.req_bytes = req.json !== undefined ? JSON.stringify(req.json).length : (req.content ? String(req.content).length : 0);

    const resp = await sendWithRetries(req, timeout, retries);
    inv.http_status = resp.status;
    const respClone = resp.clone();
    const rawLen = (await respClone.arrayBuffer()).byteLength;
    inv.resp_bytes_raw = rawLen;

    let data = await parseResponse(kind, resp);
    let rules = tool.postprocess || null;
    if (typeof rules === "string") { try { rules = JSON.parse(rules); } catch { rules = null; } }
    const [processed, note] = postprocess(data, rules);
    data = processed;

    let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    const maxChars = Number(rules?.max_chars) || 60000;
    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + `\n… [truncated at ${maxChars} chars by the Bridge]`;
      truncated = true;
    }
    const finalBytes = new TextEncoder().encode(text).length;
    inv.resp_bytes = finalBytes;
    inv.tokens_est = estTokens(finalBytes);
    inv.tokens_saved_est = Math.max(0, estTokens(rawLen) - estTokens(finalBytes));
    const ok = resp.status >= 200 && resp.status < 300;
    inv.status = ok ? "ok" : "error";
    if (!ok) inv.error = `HTTP ${resp.status}`;
    inv.latency_ms = Date.now() - t0;
    await logInvocation(db, inv);
    return {
      ok, text,
      meta: { http_status: resp.status, latency_ms: inv.latency_ms, postprocess: note, truncated,
              tokens_est: inv.tokens_est, tokens_saved_est: inv.tokens_saved_est },
    };
  } catch (e) {
    if (e instanceof ToolError) return await fail(e.status, e.message);
    return await fail("error", `${e.name || "Error"}: ${e.message}`);
  }
}
