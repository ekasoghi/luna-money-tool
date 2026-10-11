-- =====================================================================
-- Luna Money Tool — database cloud + sistem LANGGANAN (subscription)
-- Pembayaran utama: payment gateway DOKU Checkout (QRIS, Virtual Account, e-wallet, kartu, gerai) → lunas otomatis.
-- Cadangan opsional: transfer manual yang diverifikasi super admin.
-- Jalankan sekali di Supabase: SQL Editor → New query → tempel → Run.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- Data keuangan pengguna ----------
create table if not exists public.luna_data (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  key        text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------- Langganan ----------
create table if not exists public.luna_admins (
  email text primary key
);

create table if not exists public.luna_settings (
  id             int primary key default 1 check (id = 1),
  plans          jsonb not null default '[{"id":"bulanan","name":"Bulanan","months":1,"price":49000},{"id":"tahunan","name":"Tahunan","months":12,"price":399000}]'::jsonb,
  trial_days     int not null default 7 check (trial_days between 0 and 60),
  bank_name      text,
  bank_account   text,
  bank_holder    text,
  qris_path      text,
  admin_whatsapp text,
  payment_note   text,
  manual_enabled boolean not null default false,
  updated_at     timestamptz not null default now()
);
insert into public.luna_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.luna_subscriptions (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  plan       text not null,
  status     text not null check (status in ('trial','active')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.luna_payments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  email       text,
  name        text,
  phone       text,
  plan_id     text not null,
  plan_name   text not null,
  months      int  not null check (months between 1 and 36),
  plan_price  bigint not null,
  provider    text not null default 'manual' check (provider in ('doku','manual')),
  method      text not null check (method in ('doku','qris','transfer')),
  amount      bigint not null check (amount > 0),
  external_id text unique,
  invoice_id  text unique,
  invoice_url text,
  paid_method text,
  paid_at     timestamptz,
  expires_at  timestamptz,
  paid_on     date,
  sender_name text,
  proof_path  text,
  note        text,
  status      text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  admin_note  text,
  period_end  timestamptz,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  uuid
);
create index if not exists luna_payments_status_idx on public.luna_payments (status, created_at desc);
create index if not exists luna_payments_user_idx on public.luna_payments (user_id, created_at desc);

create table if not exists public.luna_vouchers (
  code       text primary key,
  months     int  not null check (months between 1 and 36),
  status     text not null default 'available' check (status in ('available','used','revoked')),
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid,
  used_by    uuid references auth.users (id) on delete set null,
  used_at    timestamptz
);

create table if not exists public.luna_redeem_attempts (
  id      bigserial primary key,
  user_id uuid not null,
  at      timestamptz not null default now(),
  ok      boolean not null
);
create index if not exists luna_redeem_attempts_idx on public.luna_redeem_attempts (user_id, at desc);

alter table public.luna_data            enable row level security;
alter table public.luna_admins          enable row level security;
alter table public.luna_settings        enable row level security;
alter table public.luna_subscriptions   enable row level security;
alter table public.luna_payments        enable row level security;
alter table public.luna_vouchers        enable row level security;
alter table public.luna_redeem_attempts enable row level security;

-- ---------- Fungsi inti ----------
create or replace function public.luna_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.luna_admins a
    join auth.users u on lower(u.email) = lower(a.email)
    where u.id = auth.uid() and u.email_confirmed_at is not null
  );
$$;

create or replace function public.luna_is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    exists (select 1 from public.luna_subscriptions s where s.user_id = auth.uid() and s.expires_at > now())
    or public.luna_is_admin()
  );
$$;

create or replace function public.luna_new_code() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v text;
begin
  v := upper(encode(extensions.gen_random_bytes(8), 'hex'));
  return 'LUNA-' || substr(v,1,4) || '-' || substr(v,5,4) || '-' || substr(v,9,4) || '-' || substr(v,13,4);
end $$;

create or replace function public.luna_extend(p_user uuid, p_months int, p_plan text) returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare v_exp timestamptz;
begin
  insert into public.luna_subscriptions as s (user_id, plan, status, started_at, expires_at)
  values (p_user, p_plan, 'active', now(), now() + make_interval(months => p_months))
  on conflict (user_id) do update
     set plan = excluded.plan, status = 'active',
         expires_at = greatest(s.expires_at, now()) + make_interval(months => p_months),
         updated_at = now()
  returning expires_at into v_exp;
  return v_exp;
end $$;

-- ---------- Kebijakan akses (RLS) ----------
drop policy if exists "luna_select_own" on public.luna_data;
drop policy if exists "luna_insert_own" on public.luna_data;
drop policy if exists "luna_update_own" on public.luna_data;
drop policy if exists "luna_delete_own" on public.luna_data;
-- data cloud hanya untuk pemiliknya DAN hanya selama langganan aktif
create policy "luna_select_own" on public.luna_data for select to authenticated
  using ((select auth.uid()) = user_id and (select public.luna_is_active()));
create policy "luna_insert_own" on public.luna_data for insert to authenticated
  with check ((select auth.uid()) = user_id and (select public.luna_is_active()));
create policy "luna_update_own" on public.luna_data for update to authenticated
  using ((select auth.uid()) = user_id and (select public.luna_is_active()))
  with check ((select auth.uid()) = user_id and (select public.luna_is_active()));
create policy "luna_delete_own" on public.luna_data for delete to authenticated
  using ((select auth.uid()) = user_id and (select public.luna_is_active()));

drop policy if exists "luna_settings_read" on public.luna_settings;
create policy "luna_settings_read" on public.luna_settings for select to authenticated using (true);

drop policy if exists "luna_payments_read" on public.luna_payments;
create policy "luna_payments_read" on public.luna_payments for select to authenticated
  using ((select auth.uid()) = user_id or (select public.luna_is_admin()));

drop policy if exists "luna_subs_read" on public.luna_subscriptions;
create policy "luna_subs_read" on public.luna_subscriptions for select to authenticated
  using ((select auth.uid()) = user_id or (select public.luna_is_admin()));
-- luna_admins, luna_vouchers, luna_redeem_attempts: tanpa kebijakan = tertutup total.
-- Semua perubahan langganan/pembayaran hanya lewat fungsi di bawah.

revoke all on public.luna_data, public.luna_admins, public.luna_settings, public.luna_subscriptions,
  public.luna_payments, public.luna_vouchers, public.luna_redeem_attempts from anon;
revoke insert, update, delete on public.luna_settings, public.luna_subscriptions, public.luna_payments from authenticated;
grant select, insert, update, delete on public.luna_data to authenticated;
grant select on public.luna_settings, public.luna_payments, public.luna_subscriptions to authenticated;

-- ---------- Fungsi pengguna ----------
-- Status langganan; membuat masa coba gratis sekali untuk akun baru yang emailnya sudah terverifikasi.
create or replace function public.luna_status()
returns table (active boolean, plan text, status text, expires_at timestamptz, days_left int, is_admin boolean, trial_days int)
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_trial int; v_conf timestamptz;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select s.trial_days into v_trial from public.luna_settings s where s.id = 1;
  select u.email_confirmed_at into v_conf from auth.users u where u.id = v_uid;
  if v_conf is not null and coalesce(v_trial,0) > 0
     and not exists (select 1 from public.luna_subscriptions where user_id = v_uid) then
    insert into public.luna_subscriptions (user_id, plan, status, expires_at)
    values (v_uid, 'Coba gratis', 'trial', now() + make_interval(days => v_trial))
    on conflict (user_id) do nothing;
  end if;
  return query
    select public.luna_is_active(), s.plan, s.status, s.expires_at,
           greatest(0, ceil(extract(epoch from (s.expires_at - now())) / 86400))::int,
           public.luna_is_admin(), coalesce(v_trial,0)
      from (select 1) x
      left join public.luna_subscriptions s on s.user_id = v_uid;
end $$;

create or replace function public.luna_submit_payment(
  p_plan_id text, p_method text, p_amount bigint, p_paid_on date, p_sender_name text,
  p_phone text, p_name text, p_proof_path text, p_note text
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_email text; v_plan jsonb;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if (select count(*) from public.luna_payments where user_id = v_uid and created_at > now() - interval '1 day') >= 5 then
    raise exception 'too_many_requests';
  end if;
  if not (select manual_enabled from public.luna_settings where id = 1) then raise exception 'manual_disabled'; end if;
  if exists (select 1 from public.luna_payments where user_id = v_uid and status = 'pending' and provider = 'manual') then raise exception 'pending_exists'; end if;
  select p into v_plan from public.luna_settings s, jsonb_array_elements(s.plans) p where s.id = 1 and p->>'id' = p_plan_id;
  if v_plan is null then raise exception 'invalid_plan'; end if;
  if p_method not in ('qris','transfer') then raise exception 'invalid_method'; end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'invalid_amount'; end if;
  if p_proof_path is null or split_part(p_proof_path,'/',1) <> v_uid::text then raise exception 'invalid_proof'; end if;
  select email into v_email from auth.users where id = v_uid;
  insert into public.luna_payments (user_id, email, name, phone, plan_id, plan_name, months, plan_price, method, amount,
                                    paid_on, sender_name, proof_path, note)
  values (v_uid, v_email, left(p_name,80), left(p_phone,30), p_plan_id, v_plan->>'name', (v_plan->>'months')::int,
          (v_plan->>'price')::bigint, p_method, p_amount, p_paid_on, left(p_sender_name,80), p_proof_path, left(p_note,300))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.luna_redeem_voucher(p_code text) returns json
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_c text; v_row public.luna_vouchers; v_exp timestamptz;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if (select count(*) from public.luna_redeem_attempts where user_id = v_uid and ok = false and at > now() - interval '1 hour') >= 10 then
    return json_build_object('ok', false, 'error', 'too_many_attempts');
  end if;
  v_c := upper(regexp_replace(coalesce(p_code,''), '[^A-Za-z0-9]', '', 'g'));
  if v_c like 'LUNA%' then v_c := substr(v_c, 5); end if;
  if length(v_c) = 16 then
    v_c := 'LUNA-' || substr(v_c,1,4) || '-' || substr(v_c,5,4) || '-' || substr(v_c,9,4) || '-' || substr(v_c,13,4);
    select * into v_row from public.luna_vouchers where code = v_c for update;
  end if;
  if v_row.code is null or v_row.status <> 'available' then
    insert into public.luna_redeem_attempts (user_id, ok) values (v_uid, false);
    return json_build_object('ok', false, 'error', 'invalid_voucher');
  end if;
  update public.luna_vouchers set status = 'used', used_by = v_uid, used_at = now() where code = v_c;
  v_exp := public.luna_extend(v_uid, v_row.months, 'Voucher ' || v_row.months || ' bulan');
  insert into public.luna_redeem_attempts (user_id, ok) values (v_uid, true);
  return json_build_object('ok', true, 'expires_at', v_exp, 'months', v_row.months);
end $$;

-- ---------- Fungsi super admin ----------
create or replace function public.luna_admin_payments()
returns table (id uuid, user_id uuid, email text, name text, phone text, plan_id text, plan_name text, months int,
               plan_price bigint, provider text, method text, paid_method text, amount bigint, paid_on date, sender_name text,
               proof_path text, note text, status text, admin_note text, period_end timestamptz, paid_at timestamptz,
               created_at timestamptz, decided_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.luna_is_admin() then raise exception 'forbidden'; end if;
  return query
    select p.id, p.user_id, p.email, p.name, p.phone, p.plan_id, p.plan_name, p.months, p.plan_price, p.provider,
           p.method, p.paid_method, p.amount, p.paid_on, p.sender_name, p.proof_path, p.note, p.status, p.admin_note,
           p.period_end, p.paid_at, p.created_at, p.decided_at
      from public.luna_payments p
     where not (p.provider = 'doku' and p.status in ('pending','expired') and p.created_at < now() - interval '7 days')
     order by (p.status = 'pending' and p.provider = 'manual') desc, p.created_at desc
     limit 500;
end $$;

create or replace function public.luna_approve_payment(p_id uuid, p_note text default null) returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare v_pay public.luna_payments; v_exp timestamptz;
begin
  if not public.luna_is_admin() then raise exception 'forbidden'; end if;
  select * into v_pay from public.luna_payments where id = p_id for update;
  if v_pay.id is null then raise exception 'not_found'; end if;
  if v_pay.status <> 'pending' then raise exception 'already_decided'; end if;
  if v_pay.provider <> 'manual' then raise exception 'gateway_payment'; end if;
  v_exp := public.luna_extend(v_pay.user_id, v_pay.months, v_pay.plan_name);
  update public.luna_payments
     set status = 'approved', admin_note = nullif(trim(p_note),''), period_end = v_exp,
         decided_at = now(), decided_by = auth.uid()
   where id = p_id;
  return v_exp;
end $$;

create or replace function public.luna_reject_payment(p_id uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.luna_is_admin() then raise exception 'forbidden'; end if;
  update public.luna_payments
     set status = 'rejected', admin_note = nullif(trim(p_reason),''), decided_at = now(), decided_by = auth.uid()
   where id = p_id and status = 'pending' and provider = 'manual';
end $$;

create or replace function public.luna_admin_subscribers()
returns table (user_id uuid, email text, name text, registered_at timestamptz, confirmed boolean,
               plan text, status text, expires_at timestamptz, active boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.luna_is_admin() then raise exception 'forbidden'; end if;
  return query
    select u.id, u.email::text, coalesce(u.raw_user_meta_data->>'name',''), u.created_at,
           u.email_confirmed_at is not null, s.plan, s.status, s.expires_at,
           coalesce(s.expires_at > now(), false)
      from auth.users u
      left join public.luna_subscriptions s on s.user_id = u.id
     order by u.created_at desc
     limit 5000;
end $$;

create or replace function public.luna_admin_extend(p_user uuid, p_months int) returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.luna_is_admin() then raise exception 'forbidden'; end if;
  if p_months < 1 or p_months > 36 then raise exception 'invalid_months'; end if;
  return public.luna_extend(p_user, p_months, 'Tambahan admin ' || p_months || ' bulan');
end $$;

create or replace function public.luna_admin_end(p_user uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.luna_is_admin() then raise exception 'forbidden'; end if;
  update public.luna_subscriptions set expires_at = now(), updated_at = now() where user_id = p_user;
end $$;

create or replace function public.luna_generate_vouchers(p_count int, p_months int, p_note text default null) returns setof text
language plpgsql volatile security definer set search_path = '' as $$
declare i int; v text;
begin
  if not public.luna_is_admin() then raise exception 'forbidden'; end if;
  if p_count < 1 or p_count > 200 then raise exception 'count_out_of_range'; end if;
  if p_months < 1 or p_months > 36 then raise exception 'invalid_months'; end if;
  for i in 1..p_count loop
    loop
      v := public.luna_new_code();
      begin
        insert into public.luna_vouchers (code, months, note, created_by) values (v, p_months, nullif(trim(p_note),''), auth.uid());
        exit;
      exception when unique_violation then
      end;
    end loop;
    return next v;
  end loop;
end $$;

create or replace function public.luna_list_vouchers()
returns table (code text, months int, status text, note text, created_at timestamptz, used_at timestamptz, used_email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.luna_is_admin() then raise exception 'forbidden'; end if;
  return query
    select v.code, v.months, v.status, v.note, v.created_at, v.used_at, u.email::text
      from public.luna_vouchers v left join auth.users u on u.id = v.used_by
     order by v.created_at desc limit 2000;
end $$;

create or replace function public.luna_revoke_voucher(p_code text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.luna_is_admin() then raise exception 'forbidden'; end if;
  update public.luna_vouchers set status = 'revoked' where code = p_code and status = 'available';
end $$;

create or replace function public.luna_update_settings(
  p_plans jsonb, p_trial_days int, p_bank_name text, p_bank_account text, p_bank_holder text,
  p_admin_whatsapp text, p_payment_note text, p_qris_path text, p_manual_enabled boolean
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare p jsonb;
begin
  if not public.luna_is_admin() then raise exception 'forbidden'; end if;
  if jsonb_typeof(p_plans) <> 'array' or jsonb_array_length(p_plans) < 1 or jsonb_array_length(p_plans) > 6 then
    raise exception 'invalid_plans';
  end if;
  for p in select * from jsonb_array_elements(p_plans) loop
    if coalesce(p->>'id','') = '' or coalesce(p->>'name','') = ''
       or (p->>'months')::int not between 1 and 36 or (p->>'price')::bigint <= 0 then
      raise exception 'invalid_plans';
    end if;
  end loop;
  if p_trial_days < 0 or p_trial_days > 60 then raise exception 'invalid_trial'; end if;
  update public.luna_settings
     set plans = p_plans, trial_days = p_trial_days, bank_name = p_bank_name, bank_account = p_bank_account,
         bank_holder = p_bank_holder, admin_whatsapp = p_admin_whatsapp, payment_note = p_payment_note,
         qris_path = coalesce(p_qris_path, qris_path), manual_enabled = coalesce(p_manual_enabled, false),
         updated_at = now()
   where id = 1;
end $$;

-- ---------- Fungsi khusus server (Edge Function DOKU, memakai service role) ----------
create or replace function public.luna_gateway_paid(p_external_id text, p_invoice_id text, p_amount bigint, p_paid_method text)
returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare v_pay public.luna_payments; v_exp timestamptz;
begin
  select * into v_pay from public.luna_payments where external_id = p_external_id for update;
  if v_pay.id is null then raise exception 'not_found'; end if;
  if v_pay.provider <> 'doku' then raise exception 'not_gateway'; end if;
  if v_pay.invoice_id is distinct from p_invoice_id then raise exception 'invoice_mismatch'; end if;
  if p_amount < v_pay.plan_price then raise exception 'amount_mismatch'; end if;
  if v_pay.status = 'approved' then return v_pay.period_end; end if;  -- webhook dikirim ulang: aman
  v_exp := public.luna_extend(v_pay.user_id, v_pay.months, v_pay.plan_name);
  update public.luna_payments
     set status = 'approved', paid_method = left(p_paid_method, 40), paid_at = now(), period_end = v_exp, decided_at = now()
   where id = v_pay.id;
  return v_exp;
end $$;

create or replace function public.luna_gateway_expired(p_external_id text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.luna_payments set status = 'expired', decided_at = now()
   where external_id = p_external_id and provider = 'doku' and status = 'pending';
end $$;

-- ---------- Hak menjalankan fungsi ----------
revoke execute on all functions in schema public from public, anon;
revoke execute on function public.luna_new_code(), public.luna_extend(uuid,int,text),
  public.luna_gateway_paid(text,text,bigint,text), public.luna_gateway_expired(text) from authenticated;
grant execute on function public.luna_gateway_paid(text,text,bigint,text), public.luna_gateway_expired(text) to service_role;
grant execute on function public.luna_is_admin(), public.luna_is_active(), public.luna_status(),
  public.luna_submit_payment(text,text,bigint,date,text,text,text,text,text), public.luna_redeem_voucher(text),
  public.luna_admin_payments(), public.luna_approve_payment(uuid,text), public.luna_reject_payment(uuid,text),
  public.luna_admin_subscribers(), public.luna_admin_extend(uuid,int), public.luna_admin_end(uuid),
  public.luna_generate_vouchers(int,int,text), public.luna_list_vouchers(), public.luna_revoke_voucher(text),
  public.luna_update_settings(jsonb,int,text,text,text,text,text,text,boolean)
  to authenticated;

-- ---------- Penyimpanan file: QRIS (publik) & bukti bayar (privat) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('luna-public', 'luna-public', true, 2097152, array['image/png','image/jpeg','image/webp']),
       ('luna-payments', 'luna-payments', false, 5242880, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

drop policy if exists "luna_public_admin_write"  on storage.objects;
drop policy if exists "luna_public_admin_update" on storage.objects;
drop policy if exists "luna_public_admin_delete" on storage.objects;
drop policy if exists "luna_proof_insert_own"    on storage.objects;
drop policy if exists "luna_proof_read"          on storage.objects;

create policy "luna_public_admin_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'luna-public' and (select public.luna_is_admin()));
create policy "luna_public_admin_update" on storage.objects for update to authenticated
  using (bucket_id = 'luna-public' and (select public.luna_is_admin()));
create policy "luna_public_admin_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'luna-public' and (select public.luna_is_admin()));
create policy "luna_proof_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'luna-payments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "luna_proof_read" on storage.objects for select to authenticated
  using (bucket_id = 'luna-payments' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.luna_is_admin())));

-- ---------- Super admin ----------
-- Super admin melihat semua pendaftar, pembayaran, pelanggan, dan voucher di menu Super Admin.
-- Untuk menambah admin lain, salin baris di bawah dan ganti emailnya.
insert into public.luna_admins (email) values ('admin@baliekamediatama.com') on conflict do nothing;
