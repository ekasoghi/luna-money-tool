// Luna Money Tool — membuat invoice Xendit untuk langganan.
// Dipanggil aplikasi oleh pengguna yang sudah masuk (JWT wajib).
// Secret yang dibutuhkan (Supabase → Edge Functions → Secrets):
//   XENDIT_SECRET_KEY  : secret API key Xendit (izin Write untuk Money-In)
//   SITE_URLS          : alamat aplikasi yang diizinkan, pisahkan koma. Contoh: https://money.domainanda.com
import { createClient } from "jsr:@supabase/supabase-js@2";

const XENDIT = "https://api.xendit.co";

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

  const key = Deno.env.get("XENDIT_SECRET_KEY");
  if (!key) return json({ error: "gateway_not_configured" }, 503, headers);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1) siapa yang memanggil
  const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: "not_authenticated" }, 401, headers);
  if (!user.email_confirmed_at) return json({ error: "email_not_confirmed" }, 403, headers);

  let body: { plan_id?: string; return_path?: string } = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400, headers); }
  const planId = String(body.plan_id || "").slice(0, 40);

  const admin = createClient(url, service, { auth: { persistSession: false } });

  // 2) harga SELALU diambil dari database, bukan dari aplikasi
  const { data: st, error: stErr } = await admin.from("luna_settings").select("plans").eq("id", 1).single();
  if (stErr) return json({ error: "db_error" }, 500, headers);
  const plan = (st?.plans || []).find((p: { id: string }) => p.id === planId);
  if (!plan) return json({ error: "invalid_plan" }, 400, headers);
  const price = Math.round(Number(plan.price));
  const months = Math.round(Number(plan.months));
  if (!(price > 0) || !(months >= 1 && months <= 36)) return json({ error: "invalid_plan" }, 400, headers);

  // 3) pakai ulang invoice yang masih berlaku untuk paket yang sama
  const { data: open } = await admin.from("luna_payments")
    .select("id, plan_id, invoice_url, expires_at")
    .eq("user_id", user.id).eq("provider", "xendit").eq("status", "pending")
    .order("created_at", { ascending: false }).limit(1);
  const ex = open?.[0];
  if (ex && ex.plan_id === planId && ex.invoice_url && ex.expires_at && new Date(ex.expires_at).getTime() > Date.now() + 10 * 60e3) {
    return json({ invoice_url: ex.invoice_url, reused: true }, 200, headers);
  }

  // 4) batas wajar: 10 invoice per pengguna per 24 jam
  const { count } = await admin.from("luna_payments").select("id", { count: "exact", head: true })
    .eq("user_id", user.id).eq("provider", "xendit").gte("created_at", new Date(Date.now() - 864e5).toISOString());
  if ((count || 0) >= 10) return json({ error: "too_many_requests" }, 429, headers);

  const id = crypto.randomUUID();
  const externalId = `luna-${id}`;
  const name = String(user.user_metadata?.name || user.email!.split("@")[0]).slice(0, 50);
  const ins = await admin.from("luna_payments").insert({
    id, user_id: user.id, email: user.email, name, plan_id: plan.id, plan_name: plan.name, months,
    plan_price: price, provider: "xendit", method: "xendit", amount: price, external_id: externalId, status: "pending",
  });
  if (ins.error) return json({ error: "db_error" }, 500, headers);

  const site = originOk && origin ? origin : (allowed[0] || "");
  const rp = String(body.return_path || "/");
  const path = /^\/[A-Za-z0-9_\-./]*$/.test(rp) ? rp.slice(0, 120) : "/";

  // 5) buat invoice di Xendit
  const res = await fetch(`${XENDIT}/v2/invoices`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(key + ":"), "Content-Type": "application/json" },
    body: JSON.stringify({
      external_id: externalId,
      amount: price,
      currency: "IDR",
      description: `Langganan Luna Money Tool - ${plan.name} (${months} bulan)`,
      invoice_duration: 86400,
      customer: { given_names: name, email: user.email },
      items: [{ name: `Luna Money Tool ${plan.name}`, quantity: 1, price, category: "Subscription" }],
      ...(site ? { success_redirect_url: `${site}${path}#bayar-sukses`, failure_redirect_url: `${site}${path}#bayar-gagal` } : {}),
    }),
  });
  const inv = await res.json().catch(() => ({}));
  if (!res.ok || !inv.invoice_url) {
    await admin.from("luna_payments").update({ status: "expired", admin_note: `Gagal membuat invoice: ${inv.error_code || res.status}` }).eq("id", id);
    console.error("xendit create invoice failed", res.status, inv.error_code, inv.message);
    return json({ error: "gateway_error", detail: inv.error_code || res.status }, 502, headers);
  }
  await admin.from("luna_payments").update({
    invoice_id: inv.id, invoice_url: inv.invoice_url,
    expires_at: inv.expiry_date || new Date(Date.now() + 864e5).toISOString(),
  }).eq("id", id);

  return json({ invoice_url: inv.invoice_url }, 200, headers);
});
