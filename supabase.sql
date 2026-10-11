-- Luna Money Tool — tabel sinkron cloud (opsional)
-- Jalankan sekali di Supabase: menu SQL Editor → New query → tempel → Run.

create table if not exists public.luna_data (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  key        text        not null,               -- "profile" atau "m:2026-10" (satu baris per bulan)
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Setiap pengguna hanya bisa membaca dan menulis datanya sendiri
alter table public.luna_data enable row level security;

drop policy if exists "luna_select_own" on public.luna_data;
drop policy if exists "luna_insert_own" on public.luna_data;
drop policy if exists "luna_update_own" on public.luna_data;
drop policy if exists "luna_delete_own" on public.luna_data;

create policy "luna_select_own" on public.luna_data for select using (auth.uid() = user_id);
create policy "luna_insert_own" on public.luna_data for insert with check (auth.uid() = user_id);
create policy "luna_update_own" on public.luna_data for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "luna_delete_own" on public.luna_data for delete using (auth.uid() = user_id);
