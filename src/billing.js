/* Billing spine (frozen spec, v1).
   Doctrine: integer micro-cents with explicit carry — floats never touch money.
   Deterministic idempotency: rollup and invoice ids derive from (tenant, period),
   so re-running a cron can never double-bill. Finix webhooks are HMAC-verified
   BEFORE any state change, and replay-protected by a UNIQUE external_id.
   past_due pauses NEW provisioning only — reads and live servers keep working.
   Every money movement and every refusal is receipted. */
import { makeReceipt } from "./core.js";
import { newId, now } from "./runtime.js";

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const httpErr = (s, detail) => json({ detail }, s);
const UCENTS_PER_CENT = 1000000;

export function currentPeriod(d = null) {
  const dt = d ? new Date(d) : new Date();
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* ---------------- account state ---------------- */
export async function billingAccount(db, tenantId) {
  let acc = await db.prepare("SELECT * FROM billing_accounts WHERE tenant_id=?").bind(tenantId).first();
  if (!acc) {
    const ts = now();
    const anchor = new Date().toISOString().slice(0, 10);
    await db.prepare(`INSERT INTO billing_accounts (tenant_id,plan_id,status,trial_start,period_anchor,carry_ucents,updated_at,created_at)
      VALUES (?,?,?,?,?,0,?,?)`).bind(tenantId, "plan_free", "trial", ts, anchor, ts, ts).run();
    acc = await db.prepare("SELECT * FROM billing_accounts WHERE tenant_id=?").bind(tenantId).first();
  }
  return acc;
}

/* provisioning gate: called by IGB generate — past_due pauses NEW value only */
export async function provisioningAllowed(db, tenantId) {
  const acc = await db.prepare("SELECT status FROM billing_accounts WHERE tenant_id=?").bind(tenantId).first();
  if (!acc) return { allowed: true };          // no account yet → free-tier defaults apply on first rollup
  if (acc.status === "past_due") return { allowed: false, reason: "Account is past due — existing servers keep answering, new provisioning resumes on payment." };
  if (acc.status === "canceled") return { allowed: false, reason: "Account canceled." };
  return { allowed: true };
}

/* ---------------- rollup: usage → deterministic period record ---------------- */
export async function rollupTenant(db, tenantId, period) {
  const rollId = `roll_${tenantId}_${period}`;                      // idempotency key
  const existing = await db.prepare("SELECT * FROM usage_rollups WHERE id=?").bind(rollId).first();
  if (existing) return { ...existing, idempotent: true };
  const calls = (await db.prepare(
    `SELECT COUNT(*) AS n FROM invocations i JOIN servers s ON s.slug=i.server_slug
     WHERE s.tenant_id=? AND substr(i.ts,1,7)=?`).bind(tenantId, period).first())?.n || 0;
  const servers = (await db.prepare("SELECT COUNT(*) AS n FROM servers WHERE tenant_id=? AND enabled=1").bind(tenantId).first())?.n || 0;
  const tools = (await db.prepare(
    "SELECT COUNT(*) AS n FROM tools t JOIN servers s ON s.id=t.server_id WHERE s.tenant_id=? AND t.enabled=1").bind(tenantId).first())?.n || 0;
  const r = await makeReceipt(db, { kind: "usage_rollup", subject: rollId, tenant_id: tenantId,
    input: { tenant_id: tenantId, period }, output: { calls, servers_live: servers, tools_provisioned: tools } });
  await db.prepare(`INSERT INTO usage_rollups (id,tenant_id,period,calls,tools_provisioned,servers_live,computed_at,receipt_id)
    VALUES (?,?,?,?,?,?,?,?)`).bind(rollId, tenantId, period, calls, tools, servers, now(), r.receipt_id).run();
  return { id: rollId, tenant_id: tenantId, period, calls, servers_live: servers, tools_provisioned: tools, receipt_id: r.receipt_id };
}

/* ---------------- invoice: rollup × plan → integer money ---------------- */
export async function invoiceTenant(db, tenantId, period) {
  const invId = `inv_${tenantId}_${period}`;                        // idempotency key
  const existing = await db.prepare("SELECT * FROM invoices WHERE id=?").bind(invId).first();
  if (existing) return { ...existing, idempotent: true };
  const acc = await billingAccount(db, tenantId);
  const plan = await db.prepare("SELECT * FROM billing_plans WHERE id=?").bind(acc.plan_id).first();
  if (!plan) throw Object.assign(new Error(`Unknown plan ${acc.plan_id} (fail closed — no invoice issued).`), { code: 422 });
  const roll = await rollupTenant(db, tenantId, period);
  const overageCalls = Math.max(0, (roll.calls || 0) - plan.included_calls);
  const overageU = overageCalls * plan.overage_ucents_per_call;
  const carryIn = acc.carry_ucents | 0;
  const totalU = plan.base_ucents + overageU + carryIn;
  // charge whole cents only; the sub-cent remainder carries forward as integers
  const chargeCents = Math.floor(totalU / UCENTS_PER_CENT);
  const carryOut = totalU - chargeCents * UCENTS_PER_CENT;
  const r = await makeReceipt(db, { kind: "invoice", subject: invId, tenant_id: tenantId,
    input: { tenant_id: tenantId, period, plan: plan.id, rollup: roll.id },
    output: { base_ucents: plan.base_ucents, overage_calls: overageCalls, overage_ucents: overageU,
      carry_in_ucents: carryIn, total_ucents: totalU, charge_cents: chargeCents, carry_out_ucents: carryOut } });
  const ts = now();
  await db.prepare(`INSERT INTO invoices (id,tenant_id,period,plan_id,base_ucents,overage_calls,overage_ucents,carry_in_ucents,total_ucents,charge_cents,carry_out_ucents,status,receipt_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(invId, tenantId, period, plan.id, plan.base_ucents, overageCalls, overageU, carryIn, totalU, chargeCents, carryOut,
      chargeCents > 0 ? "open" : "paid", r.receipt_id, ts, ts).run();
  await db.prepare("UPDATE billing_accounts SET carry_ucents=?, updated_at=? WHERE tenant_id=?").bind(carryOut, ts, tenantId).run();
  return { id: invId, tenant_id: tenantId, period, charge_cents: chargeCents, total_ucents: totalU,
    carry_out_ucents: carryOut, status: chargeCents > 0 ? "open" : "paid", receipt_id: r.receipt_id };
}

/* ---------------- monthly cron ---------------- */
export async function billingCron(db) {
  const period = currentPeriod(new Date(Date.now() - 86400000 * 2));  // bill the period just closed
  const tenants = (await db.prepare("SELECT DISTINCT tenant_id FROM servers WHERE tenant_id IS NOT NULL").all()).results;
  const out = [];
  for (const t of tenants) {
    try { out.push(await invoiceTenant(db, t.tenant_id, period)); }
    catch (e) { out.push({ tenant_id: t.tenant_id, error: e.message }); }
  }
  return { period, invoiced: out.length, results: out };
}

/* ---------------- Finix webhook: verify BEFORE any state change ---------------- */
async function hmacValid(secret, bodyText, signature) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  const given = signature.replace(/^sha256=/, "").toLowerCase();
  if (hex.length !== given.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export async function handleBillingWebhook(request, env) {
  const db = env.DB;
  const bodyText = await request.text();
  const sig = request.headers.get("Finix-Signature") || request.headers.get("X-Finix-Signature") || "";
  if (!(await hmacValid(env.FINIX_WEBHOOK_SECRET, bodyText, sig))) {
    // refusal is receipted — unverified payloads change nothing
    await makeReceipt(db, { kind: "billing_webhook_refused", subject: "finix",
      input: { sig_present: !!sig, body_sha256: await sha256hex(bodyText) }, output: { status: "REFUSED", reason: "HMAC verification failed (fail closed)" } });
    return httpErr(401, "signature verification failed");
  }
  let evt; try { evt = JSON.parse(bodyText); } catch { return httpErr(400, "invalid JSON"); }
  const extId = evt.id || evt.entity?.id || null;
  if (!extId) return httpErr(422, "event id missing (fail closed)");
  const dup = await db.prepare("SELECT id FROM billing_events WHERE external_id=?").bind(extId).first();
  if (dup) return json({ status: "already_processed", event: dup.id });   // replay-safe
  const kindMap = { "transfer.created": "charge_submitted", "transfer.succeeded": "charge_settled", "transfer.failed": "charge_failed" };
  const kind = kindMap[evt.type] || "webhook_received";
  const invoiceId = evt.tags?.invoice_id || null;
  const r = await makeReceipt(db, { kind: "billing_event", subject: extId,
    input: { type: evt.type || "unknown", external_id: extId }, output: { kind, invoice_id: invoiceId } });
  await db.prepare(`INSERT INTO billing_events (id,kind,tenant_id,invoice_id,external_id,payload_hash,receipt_id,created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .bind(newId("bev"), kind, evt.tags?.tenant_id || null, invoiceId, extId, await sha256hex(bodyText), r.receipt_id, now()).run();
  if (invoiceId && kind === "charge_settled") {
    await db.prepare("UPDATE invoices SET status='paid', finix_transfer_id=?, updated_at=? WHERE id=?").bind(extId, now(), invoiceId).run();
    const inv = await db.prepare("SELECT tenant_id FROM invoices WHERE id=?").bind(invoiceId).first();
    if (inv) await db.prepare("UPDATE billing_accounts SET status='active', updated_at=? WHERE tenant_id=?").bind(now(), inv.tenant_id).run();
  }
  if (invoiceId && kind === "charge_failed") {
    await db.prepare("UPDATE invoices SET status='failed', updated_at=? WHERE id=?").bind(now(), invoiceId).run();
    const inv = await db.prepare("SELECT tenant_id FROM invoices WHERE id=?").bind(invoiceId).first();
    if (inv) await db.prepare("UPDATE billing_accounts SET status='past_due', updated_at=? WHERE tenant_id=?").bind(now(), inv.tenant_id).run();
  }
  return json({ status: "processed", kind, receipt_id: r.receipt_id });
}

async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

/* ---------------- routes ---------------- */
export async function handleBilling(request, env, url, path, body) {
  const db = env.DB; const method = request.method; let m;
  try {
    if (path === "/api/billing/webhook" && method === "POST") return await handleBillingWebhook(request, env);
    if (path === "/api/billing/plans" && method === "GET")
      return json((await db.prepare("SELECT * FROM billing_plans WHERE active=1").all()).results);
    m = path.match(/^\/api\/billing\/accounts\/([\w-]+)$/);
    if (m && method === "GET") return json(await billingAccount(db, m[1]));
    m = path.match(/^\/api\/billing\/accounts\/([\w-]+)\/rollup$/);
    if (m && method === "POST") return json(await rollupTenant(db, m[1], body?.period || currentPeriod()));
    m = path.match(/^\/api\/billing\/accounts\/([\w-]+)\/invoice$/);
    if (m && method === "POST") return json(await invoiceTenant(db, m[1], body?.period || currentPeriod()));
    if (path === "/api/billing/run" && method === "POST") return json(await billingCron(db));
    m = path.match(/^\/api\/billing\/invoices\/([\w-]+)$/);
    if (m && method === "GET") {
      const inv = await db.prepare("SELECT * FROM invoices WHERE id=?").bind(m[1]).first();
      return inv ? json(inv) : httpErr(404, "invoice not found");
    }
    return null;
  } catch (e) { return httpErr(e.code || 500, e.message); }
}
