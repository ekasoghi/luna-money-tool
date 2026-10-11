// Luna Money Tool — membuat tagihan DOKU Checkout untuk langganan, dan memeriksa status pembayaran.
// Dipanggil aplikasi oleh pengguna yang sudah masuk (JWT wajib).
// Secret (Supabase → Edge Functions → Secrets), JANGAN ditaruh di aplikasi/GitHub:
//   DOKU_CLIENT_ID   : Client ID dari DOKU Dashboard (contoh BRN-xxxx-xxxxxxxxxxxxx)
//   DOKU_SECRET_KEY  : Active Secret Key dari DOKU Dashboard (SK-...)
//   DOKU_ENV         : "production" atau "sandbox" (bawaan: production)
//   SITE_URLS        : alamat aplikasi yang diizinkan, pisahkan koma. Contoh: https://money.domainanda.com
import { createClient } from "jsr:@supabase/supabase-js@2";

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const dokuBase = () => (Deno.env.get("DOKU_ENV") || "production").toLowerCase() === "sandbox"
  ? "https://api-sandbox.doku.com" : "https://api.doku.com";
const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";

// Signature non-SNAP DOKU: HMACSHA256=base64(HMAC_SHA256(secret, komponen))
async function dokuSignature(secret: string, clientId: string, requestId: string, ts: string, target: string, body?: string) {
  let comp = `Client-Id:${clientId}\nRequest-Id:${requestId}\nRequest-Timestamp:${ts}\nRequest-Target:${target}`;
  if (body !== undefined) comp += `\nDigest:${b64(await crypto.subtle.digest("SHA-256", enc.encode(body)))}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "HMACSHA256=" + b64(await crypto.subtle.sign("HMAC", key, enc.encode(comp)));
}
async function dokuFetch(method: "GET" | "POST", target: string, payload?: unknown) {
  const clientId = Deno.env.get("DOKU_CLIENT_ID")!, secret = Deno.env.get("DOKU_SECRET_KEY")!;
  const requestId = crypto.randomUUID(), ts = nowIso();
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const res = await fetch(dokuBase() + target, {
    method,
    headers: {
      "Client-Id": clientId, "Request-Id": requestId, "Request-Timestamp": ts,
      "Signature": await dokuSignature(secret, clientId, requestId, ts, target, body),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body,
  });
  return { res, data: await res.json().catch(() => ({})) };
}

function corsFor(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  const origin = (req.headers.get("origin") || "").replace(/\/$/, "");
  const allowed = (Deno.env.get("SITE_URLS") || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  const originOk = allowed.length === 0 || allowed.includes(origin);
  const headers = corsFor(originOk && origin ? origin : (allowed[0] || "null"));

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);
  if (!originOk) return json({ error: "origin_not_allowed" }, 403, headers);
  if (!Deno.env.get("DOKU_CLIENT_ID") || !Deno.env.get("DOKU_SECRET_KEY")) return json({ error: "gateway_not_configured" }, 503, headers);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1) siapa yang memanggil
  const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: "not_authenticated" }, 401, headers);
  if (!user.email_confirmed_at) return json({ error: "email_not_confirmed" }, 403, headers);

  let body: { action?: string; plan_id?: string; return_path?: string } = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400, headers); }
  const admin = createClient(url, service, { auth: { persistSession: false } });

  // ---- A) Periksa status pembayaran terakhir langsung ke DOKU (cadangan bila notifikasi terlambat) ----
  if (body.action === "check") {
    const { data: rows } = await admin.from("luna_payments").select("id, external_id, created_at")
      .eq("user_id", user.id).eq("provider", "doku").eq("status", "pending")
      .order("created_at", { ascending: false }).limit(1);
    const p = rows?.[0];
    if (!p) return json({ status: "none" }, 200, headers);
    const { res, data } = await dokuFetch("GET", `/orders/v1/status/${encodeURIComponent(p.external_id)}`);
    if (!res.ok) return json({ status: "unknown" }, 200, headers);
    const st = String(data?.transaction?.status || "").toUpperCase();
    if (st === "SUCCESS" && data?.order?.invoice_number === p.external_id) {
      const { error } = await admin.rpc("luna_gateway_paid", {
        p_external_id: p.external_id, p_invoice_id: p.external_id,
        p_amount: Math.round(Number(data.order.amount)), p_paid_method: String(data?.channel?.id || data?.service?.id || "DOKU"),
      });
      if (error) { console.error("luna_gateway_paid", error.message); return json({ status: "error" }, 200, headers); }
      return json({ status: "paid" }, 200, headers);
    }
    if (st === "EXPIRED" || st === "FAILED") { await admin.rpc("luna_gateway_expired", { p_external_id: p.external_id }); }
    return json({ status: st.toLowerCase() || "pending" }, 200, headers);
  }

  // ---- B) Buat tagihan baru ----
  const planId = String(body.plan_id || "").slice(0, 40);
  // harga SELALU diambil dari database, bukan dari aplikasi
  const { data: st, error: stErr } = await admin.from("luna_settings").select("plans").eq("id", 1).single();
  if (stErr) return json({ error: "db_error" }, 500, headers);
  const plan = (st?.plans || []).find((p: { id: string }) => p.id === planId);
  if (!plan) return json({ error: "invalid_plan" }, 400, headers);
  const price = Math.round(Number(plan.price));
  const months = Math.round(Number(plan.months));
  if (!(price > 0) || !(months >= 1 && months <= 36)) return json({ error: "invalid_plan" }, 400, headers);

  // pakai ulang tagihan yang masih berlaku untuk paket yang sama
  const { data: open } = await admin.from("luna_payments")
    .select("id, plan_id, invoice_url, expires_at")
    .eq("user_id", user.id).eq("provider", "doku").eq("status", "pending")
    .order("created_at", { ascending: false }).limit(1);
  const ex = open?.[0];
  if (ex && ex.plan_id === planId && ex.invoice_url && ex.expires_at && new Date(ex.expires_at).getTime() > Date.now() + 10 * 60e3) {
    return json({ invoice_url: ex.invoice_url, reused: true }, 200, headers);
  }

  // batas wajar: 10 tagihan per pengguna per 24 jam
  const { count } = await admin.from("luna_payments").select("id", { count: "exact", head: true })
    .eq("user_id", user.id).eq("provider", "doku").gte("created_at", new Date(Date.now() - 864e5).toISOString());
  if ((count || 0) >= 10) return json({ error: "too_many_requests" }, 429, headers);

  const id = crypto.randomUUID();
  // nomor invoice: huruf/angka saja, maks 30 karakter (syarat DOKU bila kartu kredit aktif)
  const invoice = "LUNA" + id.replace(/-/g, "").slice(0, 22).toUpperCase();
  const name = String(user.user_metadata?.name || user.email!.split("@")[0]).replace(/[^\p{L}\p{N} .'-]/gu, "").slice(0, 50) || "Pelanggan";
  const ins = await admin.from("luna_payments").insert({
    id, user_id: user.id, email: user.email, name, plan_id: plan.id, plan_name: plan.name, months,
    plan_price: price, provider: "doku", method: "doku", amount: price, external_id: invoice, invoice_id: invoice, status: "pending",
  });
  if (ins.error) return json({ error: "db_error" }, 500, headers);

  const site = originOk && origin ? origin : (allowed[0] || "");
  const rp = String(body.return_path || "/");
  const path = /^\/[A-Za-z0-9_\-./]*$/.test(rp) ? rp.slice(0, 120) : "/";
  const dueMinutes = 24 * 60;

  const { res, data } = await dokuFetch("POST", "/checkout/v1/payment", {
    order: {
      amount: price,
      invoice_number: invoice,
      currency: "IDR",
      ...(site ? { callback_url: `${site}${path}#bayar-sukses`, callback_url_cancel: `${site}${path}#bayar-gagal`, auto_redirect: true } : {}),
      line_items: [{ name: `Luna Money Tool ${plan.name} (${months} bulan)`.slice(0, 100), price, quantity: 1 }],
    },
    payment: { payment_due_date: dueMinutes },
    customer: { id: user.id.replace(/-/g, "").slice(0, 30), name, email: user.email },
  });
  const payUrl = data?.response?.payment?.url;
  if (!res.ok || !payUrl) {
    const why = Array.isArray(data?.error_messages) ? data.error_messages.join("; ") : (data?.error?.message || res.status);
    await admin.from("luna_payments").update({ status: "expired", admin_note: `Gagal membuat tagihan DOKU: ${String(why).slice(0, 200)}` }).eq("id", id);
    console.error("doku create payment failed", res.status, why);
    return json({ error: "gateway_error" }, 502, headers);
  }
  await admin.from("luna_payments").update({
    invoice_url: payUrl, expires_at: new Date(Date.now() + dueMinutes * 60e3).toISOString(),
  }).eq("id", id);

  return json({ invoice_url: payUrl }, 200, headers);
});
