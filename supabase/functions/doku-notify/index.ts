// Luna Money Tool — menerima HTTP Notification dari DOKU.
// Dipasang tanpa JWT (DOKU tidak punya akun Supabase). Keamanan dijaga dengan:
//   1. Header Client-Id harus sama dengan DOKU_CLIENT_ID.
//   2. Header Signature diverifikasi (HMAC-SHA256 dengan DOKU_SECRET_KEY atas Client-Id, Request-Id,
//      Request-Timestamp, Request-Target, dan Digest isi pesan), dibandingkan waktu-konstan.
//   3. Status DIPERIKSA ULANG ke Check Status API DOKU sebelum langganan diperpanjang.
//   4. Nominal & nomor invoice dicocokkan dengan database; pemrosesan idempoten (notifikasi ganda aman).
// URL untuk DOKU Dashboard → Settings → Notification URL:
//   https://PROJECT.supabase.co/functions/v1/doku-notify
import { createClient } from "jsr:@supabase/supabase-js@2";

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const dokuBase = () => (Deno.env.get("DOKU_ENV") || "production").toLowerCase() === "sandbox"
  ? "https://api-sandbox.doku.com" : "https://api.doku.com";

async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "HMACSHA256=" + b64(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function sign(secret: string, clientId: string, requestId: string, ts: string, target: string, body?: string) {
  let comp = `Client-Id:${clientId}\nRequest-Id:${requestId}\nRequest-Timestamp:${ts}\nRequest-Target:${target}`;
  if (body !== undefined) comp += `\nDigest:${b64(await crypto.subtle.digest("SHA-256", enc.encode(body)))}`;
  return hmac(secret, comp);
}
async function safeEqual(a: string, b: string) {
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = a.length === b.length ? 0 : 1;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const clientId = Deno.env.get("DOKU_CLIENT_ID"), secret = Deno.env.get("DOKU_SECRET_KEY");
  if (!clientId || !secret) return new Response("not configured", { status: 503 });

  const raw = await req.text();
  const hCid = req.headers.get("client-id") || "";
  const hRid = req.headers.get("request-id") || "";
  const hTs = req.headers.get("request-timestamp") || "";
  const hSig = req.headers.get("signature") || "";
  if (!(await safeEqual(hCid, clientId)) || !hRid || !hTs || !hSig) return new Response("unauthorized", { status: 401 });

  // Request-Target = path Notification URL. Supabase bisa meneruskan path dengan/tanpa /functions/v1.
  const p = new URL(req.url).pathname;
  const targets = Array.from(new Set([p, "/functions/v1/doku-notify", "/doku-notify"]));
  let ok = false;
  for (const t of targets) if (await safeEqual(hSig, await sign(secret, clientId, hRid, hTs, t, raw))) { ok = true; break; }
  if (!ok) return new Response("invalid signature", { status: 401 });

  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }
  const invoice = String(body?.order?.invoice_number || "");
  const status = String(body?.transaction?.status || "").toUpperCase();
  if (!/^LUNA[A-Z0-9]{10,26}$/.test(invoice)) return new Response("ignored", { status: 200 });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  if (status === "SUCCESS") {
    // Periksa ulang ke DOKU. Jika DOKU tegas menyatakan bukan SUCCESS, tolak.
    let amount = Math.round(Number(body?.order?.amount));
    try {
      const target = `/orders/v1/status/${encodeURIComponent(invoice)}`;
      const rid = crypto.randomUUID(), ts = new Date().toISOString().slice(0, 19) + "Z";
      const r = await fetch(dokuBase() + target, { headers: { "Client-Id": clientId, "Request-Id": rid, "Request-Timestamp": ts, "Signature": await sign(secret, clientId, rid, ts, target) } });
      if (r.ok) {
        const d = await r.json();
        const s2 = String(d?.transaction?.status || "").toUpperCase();
        if (d?.order?.invoice_number === invoice && ["FAILED", "EXPIRED", "REFUNDED"].includes(s2)) return new Response("status mismatch", { status: 200 });
        if (s2 === "SUCCESS" && d?.order?.amount != null) amount = Math.round(Number(d.order.amount));
      }
    } catch (e) { console.warn("doku status check skipped", String(e)); }

    const { error } = await admin.rpc("luna_gateway_paid", {
      p_external_id: invoice, p_invoice_id: invoice, p_amount: amount,
      p_paid_method: String(body?.channel?.id || body?.service?.id || "DOKU"),
    });
    if (error) {
      console.error("luna_gateway_paid", error.message);
      // not_found/amount_mismatch: jangan diulang terus oleh DOKU
      return new Response(/not_found|mismatch|not_gateway/.test(error.message) ? "rejected" : "db error", { status: /not_found|mismatch|not_gateway/.test(error.message) ? 200 : 500 });
    }
  } else if (status === "EXPIRED" || status === "FAILED") {
    await admin.rpc("luna_gateway_expired", { p_external_id: invoice });
  }
  return new Response("OK", { status: 200 });
});
