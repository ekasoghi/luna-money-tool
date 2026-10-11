// Luna Money Tool — menerima webhook invoice dari Xendit.
// Dipasang tanpa JWT (Xendit tidak punya akun Supabase), keamanan dijaga dengan:
//   1. Header x-callback-token harus sama persis dengan XENDIT_CALLBACK_TOKEN (dibandingkan waktu-konstan).
//   2. Status invoice DIPERIKSA ULANG langsung ke API Xendit memakai XENDIT_SECRET_KEY,
//      jadi isi webhook palsu tidak pernah dipercaya.
//   3. Nominal, ID invoice, dan external_id dicocokkan dengan data di database.
//   4. Pemrosesan idempoten: webhook yang dikirim ulang tidak menambah masa aktif dua kali.
// Secret: XENDIT_SECRET_KEY, XENDIT_CALLBACK_TOKEN (Xendit Dashboard → Settings → Webhooks → View Webhook Verification Token)
import { createClient } from "jsr:@supabase/supabase-js@2";

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const token = Deno.env.get("XENDIT_CALLBACK_TOKEN");
  const key = Deno.env.get("XENDIT_SECRET_KEY");
  if (!token || !key) return new Response("not configured", { status: 503 });

  if (!(await safeEqual(req.headers.get("x-callback-token") || "", token))) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return new Response("bad request", { status: 400 }); }

  const ext = String(body.external_id || "");
  const invoiceId = String(body.id || "");
  if (!ext.startsWith("luna-") || !/^[A-Za-z0-9_-]{6,80}$/.test(invoiceId)) {
    return new Response("ignored", { status: 200 });
  }

  // Periksa ulang ke Xendit: hanya status dari API resmi yang dipercaya
  const res = await fetch(`https://api.xendit.co/v2/invoices/${encodeURIComponent(invoiceId)}`, {
    headers: { Authorization: "Basic " + btoa(key + ":") },
  });
  if (!res.ok) {
    console.error("xendit verify failed", res.status);
    return new Response("verify failed", { status: 502 }); // Xendit akan mencoba lagi
  }
  const inv = await res.json();
  if (inv.external_id !== ext || inv.id !== invoiceId) return new Response("mismatch", { status: 400 });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  if (inv.status === "PAID" || inv.status === "SETTLED") {
    const { error } = await admin.rpc("luna_gateway_paid", {
      p_external_id: ext,
      p_invoice_id: invoiceId,
      p_amount: Math.round(Number(inv.paid_amount ?? inv.amount)),
      p_paid_method: String(inv.payment_channel || inv.payment_method || "XENDIT"),
    });
    if (error) {
      console.error("luna_gateway_paid", error.message);
      return new Response("db error", { status: 500 });
    }
  } else if (inv.status === "EXPIRED") {
    await admin.rpc("luna_gateway_expired", { p_external_id: ext });
  }
  return new Response("ok", { status: 200 });
});
