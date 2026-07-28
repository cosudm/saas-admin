/* Segment Response + WATCH (SCL v0.2).
   Deterministically segments an AI model's response turn into governed blocks:
     fenced code -> script          (tool-call JSON -> tool_call)
     URLs        -> resource
     imperative / numbered lines -> instruction
     question lines -> query
   No model in the loop: the segmenter is a fixed grammar, so the same turn
   always yields the same segments (same hashes). Everything is receipted.
   Nothing captured here is executable until a compilation is approved by a
   checker distinct from the capture source (maker-checker), mirroring IGB. */
import { makeReceipt, linkReceipts } from "./core.js";
import { newId, now } from "./runtime.js";

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const httpErr = (s, detail) => json({ detail }, s);

async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

const IMPERATIVES = /^(run|click|open|set|create|deploy|verify|check|add|remove|paste|install|push|promote|purge|test|confirm|bind|configure|rename|navigate|select|enter|copy|save|update|delete|restart|enable|disable|apply|commit|stage|fetch|download|upload|type|go to|use)\b/i;
const NUMBERED = /^\s*(step\s+\d+|\d+[.)]\s+)/i;

/* ---------------- the deterministic grammar ---------------- */
export function segmentTurn(text) {
  const segs = [];
  let rest = String(text || "");

  // 1. fenced code blocks -> script (or tool_call when the payload is a tool invocation)
  rest = rest.replace(/```([\w+-]*)\r?\n([\s\S]*?)```/g, (_, lang, body) => {
    const content = body.trim();
    if (!content) return "\n";
    let kind = "script";
    let l = (lang || "").toLowerCase() || guessLang(content);
    try {
      const j = JSON.parse(content);
      if (j && (j.jsonrpc || (j.name && (j.arguments || j.params)) || j.method)) { kind = "tool_call"; l = "json"; }
    } catch { /* not JSON */ }
    const title = firstLine(content);
    segs.push({ seg_kind: kind, lang: l, title, content });
    return "\n";
  });

  // 2. URLs -> resource (deduplicated, order-preserving)
  const seen = new Set();
  for (const m of rest.matchAll(/https?:\/\/[^\s)"'<>\],]+/g)) {
    const u = m[0].replace(/[.;:]+$/, "");
    if (!seen.has(u)) { seen.add(u); segs.push({ seg_kind: "resource", lang: null, title: new URL(u).hostname, content: u }); }
  }

  // 3. inline `code` that looks like a shell command -> script
  for (const m of rest.matchAll(/`([^`\n]{8,})`/g)) {
    const c = m[1].trim();
    if (/^(wrangler|git|npm|npx|node|python3?|curl|cd|copy-item|invoke-webrequest|expand-archive|pip|docker|kubectl)\b/i.test(c)) {
      segs.push({ seg_kind: "script", lang: /invoke-webrequest|copy-item|expand-archive/i.test(c) ? "powershell" : "sh", title: firstLine(c), content: c });
    }
  }

  // 4. instruction lines (numbered steps or imperative sentences), grouped consecutively; question lines -> query
  let block = [];
  const flush = () => {
    if (block.length) { const content = block.join("\n"); segs.push({ seg_kind: "instruction", lang: null, title: firstLine(content), content }); block = []; }
  };
  for (const raw of rest.split(/\r?\n/)) {
    const line = raw.replace(/^[\s>*-]+/, "").trim();
    if (!line) { flush(); continue; }
    if (line.length < 500 && line.endsWith("?") && !NUMBERED.test(line)) { flush(); segs.push({ seg_kind: "query", lang: null, title: firstLine(line), content: line }); continue; }
    if (NUMBERED.test(line) || IMPERATIVES.test(line)) block.push(line); else flush();
  }
  flush();
  return segs;
}
const firstLine = s => s.split(/\r?\n/)[0].slice(0, 80);
function guessLang(c) {
  if (/^\s*(import |def |from \w+ import|print\()/m.test(c)) return "python";
  if (/^\s*(function |const |let |=>|import .* from)/m.test(c)) return "javascript";
  if (/^\s*(SELECT|INSERT|CREATE TABLE|UPDATE)\b/im.test(c)) return "sql";
  if (/invoke-webrequest|copy-item|expand-archive|\$\w+\s*=/i.test(c)) return "powershell";
  return "sh";
}

/* ---------------- capture: segment + store + receipt ---------------- */
export async function segmentAndStore(db, { tenant_id, conversation_id, turn_no, text, source }) {
  if (!text || !String(text).trim()) throw Object.assign(new Error("Empty turn text (fail closed) — nothing to segment."), { code: 422 });
  const conv = conversation_id || "default";
  const turn = Number(turn_no) || 1;
  const segs = segmentTurn(text);
  if (!segs.length) throw Object.assign(new Error("No segmentable blocks found (fail closed) — the grammar matched nothing, so nothing was stored."), { code: 422 });
  const stored = [], skipped = [];
  const ts = now();
  for (const s of segs) {
    const hash = await sha256hex(`${s.seg_kind}\n${s.content}`);
    const dup = await db.prepare("SELECT id FROM turn_segments WHERE content_hash=? AND conversation_id=? AND turn_no=? AND (tenant_id IS ? OR tenant_id=?)")
      .bind(hash, conv, turn, tenant_id ?? null, tenant_id ?? null).first();
    if (dup) { skipped.push(dup.id); continue; }
    stored.push({ id: newId("seg"), ...s, content_hash: hash });
  }
  const counts = {};
  for (const s of stored) counts[s.seg_kind] = (counts[s.seg_kind] || 0) + 1;
  const r = await makeReceipt(db, { kind: "turn_segmentation", subject: `${conv}#${turn}`, tenant_id: tenant_id || null,
    input: { conversation_id: conv, turn_no: turn, text_sha256: await sha256hex(text), source: source || "segment_response" },
    output: { stored: stored.map(s => ({ id: s.id, kind: s.seg_kind, hash: s.content_hash.slice(0, 16) })), skipped_duplicates: skipped.length, counts } });
  for (const s of stored) {
    await db.prepare(`INSERT INTO turn_segments (id,tenant_id,conversation_id,turn_no,seg_kind,lang,title,content,content_hash,source,status,receipt_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'captured',?,?)`)
      .bind(s.id, tenant_id || null, conv, turn, s.seg_kind, s.lang, s.title, s.content, s.content_hash, source || "segment_response", r.receipt_id, ts).run();
  }
  return { status: "SEGMENTED", conversation_id: conv, turn_no: turn, counts, stored: stored.length,
    skipped_duplicates: skipped.length, segment_ids: stored.map(s => s.id), receipt_id: r.receipt_id, chain_hash: r.chain_hash,
    note: "Segments are captured, not executable. Compile a selection in WATCH and a checker approves it before anything runs or ships." };
}

/* ---------------- WATCH: cross-conversation matches, compile, approve ---------------- */
export async function watchMatches(db, tenantId) {
  const rows = (await db.prepare(
    `SELECT content_hash, seg_kind, MIN(title) AS title, COUNT(DISTINCT conversation_id) AS conversations, COUNT(*) AS occurrences
     FROM turn_segments WHERE (? IS NULL OR tenant_id=?) AND status!='discarded'
     GROUP BY content_hash, seg_kind HAVING COUNT(DISTINCT conversation_id) > 1
     ORDER BY conversations DESC, occurrences DESC LIMIT 50`).bind(tenantId ?? null, tenantId ?? null).all()).results;
  return { matches: rows, note: "Identical segments recurring across conversations — the strongest signal that a flow wants to become a packaged product." };
}

export async function compileSegments(db, { tenant_id, name, segment_ids, created_by }) {
  if (!Array.isArray(segment_ids) || !segment_ids.length) throw Object.assign(new Error("segment_ids required (fail closed)."), { code: 422 });
  const segs = [];
  for (const id of segment_ids) {
    const s = await db.prepare("SELECT * FROM turn_segments WHERE id=?").bind(id).first();
    if (!s) throw Object.assign(new Error(`Segment ${id} not found (fail closed — compilations only reference receipted segments).`), { code: 422 });
    if (tenant_id && s.tenant_id && s.tenant_id !== tenant_id) throw Object.assign(new Error(`Segment ${id} belongs to another tenant (fail closed).`), { code: 422 });
    segs.push(s);
  }
  const kinds = {};
  for (const s of segs) kinds[s.seg_kind] = (kinds[s.seg_kind] || 0) + 1;
  const id = newId("cmp");
  const r = await makeReceipt(db, { kind: "watch_compilation", subject: id, tenant_id: tenant_id || null,
    input: { name, segment_ids }, output: { kinds, status: "draft" }, prev_receipt_id: segs[0].receipt_id });
  await linkReceipts(db, r.receipt_id, segs[0].receipt_id, "derived_from");
  await db.prepare(`INSERT INTO turn_compilations (id,tenant_id,name,segment_ids_json,kinds_json,status,created_by,receipt_id,created_at)
    VALUES (?,?,?,?,?,'draft',?,?,?)`)
    .bind(id, tenant_id || null, name || `Compilation ${id.slice(-6)}`, JSON.stringify(segment_ids), JSON.stringify(kinds),
      created_by || "console", r.receipt_id, now()).run();
  return { compilation_id: id, kinds, status: "draft", receipt_id: r.receipt_id,
    note: "Draft compiled. A checker distinct from the creator must approve before this becomes a deployable package." };
}

export async function approveCompilation(db, compId, { approver }) {
  const c = await db.prepare("SELECT * FROM turn_compilations WHERE id=?").bind(compId).first();
  if (!c) throw Object.assign(new Error("compilation not found"), { code: 404 });
  if (!approver || !String(approver).trim()) throw Object.assign(new Error("approver identity required (fail closed)."), { code: 422 });
  if (String(approver).trim().toLowerCase() === String(c.created_by || "").trim().toLowerCase())
    throw Object.assign(new Error("Checker must differ from maker (fail closed) — the creator cannot approve their own compilation."), { code: 422 });
  if (c.status !== "draft") throw Object.assign(new Error(`Compilation is '${c.status}', not draft.`), { code: 422 });
  const r = await makeReceipt(db, { kind: "watch_approval", subject: compId, tenant_id: c.tenant_id,
    input: { compilation_id: compId, approver }, output: { status: "approved" }, prev_receipt_id: c.receipt_id });
  await linkReceipts(db, r.receipt_id, c.receipt_id, "derived_from");
  await db.prepare("UPDATE turn_compilations SET status='approved', approved_by=? WHERE id=?").bind(approver, compId).run();
  await db.prepare("UPDATE turn_segments SET status='promoted' WHERE id IN (SELECT value FROM json_each(?))").bind(c.segment_ids_json).run();
  return { compilation_id: compId, status: "approved", approved_by: approver, receipt_id: r.receipt_id,
    note: "Approved. Deployment determination (Workflows → Deployment paths) ranks where this package lands best." };
}

/* ---------------- routes ---------------- */
export async function handleWatch(request, env, url, path, body) {
  const db = env.DB; const method = request.method; let m;
  try {
    if (path === "/api/watch/segment" && method === "POST")
      return json(await segmentAndStore(db, body || {}));
    if (path === "/api/watch/segments" && method === "GET") {
      const t = url.searchParams.get("tenant_id"), c = url.searchParams.get("conversation_id");
      const rows = (await db.prepare(
        `SELECT id,tenant_id,conversation_id,turn_no,seg_kind,lang,title,content,content_hash,status,receipt_id,created_at
         FROM turn_segments WHERE (? IS NULL OR tenant_id=?) AND (? IS NULL OR conversation_id=?) AND status!='discarded'
         ORDER BY created_at DESC, turn_no DESC LIMIT 200`).bind(t, t, c, c).all()).results;
      return json(rows);
    }
    if (path === "/api/watch/matches" && method === "GET")
      return json(await watchMatches(db, url.searchParams.get("tenant_id")));
    if (path === "/api/watch/compile" && method === "POST")
      return json(await compileSegments(db, body || {}));
    if (path === "/api/watch/compilations" && method === "GET")
      return json((await db.prepare("SELECT * FROM turn_compilations ORDER BY created_at DESC LIMIT 50").all()).results
        .map(c => ({ ...c, segment_ids: JSON.parse(c.segment_ids_json), kinds: JSON.parse(c.kinds_json) })));
    m = path.match(/^\/api\/watch\/compilations\/([\w-]+)\/approve$/);
    if (m && method === "POST") return json(await approveCompilation(db, m[1], body || {}));
    return null;
  } catch (e) { return httpErr(e.code || 500, e.message); }
}
