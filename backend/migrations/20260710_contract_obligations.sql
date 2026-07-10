-- Obligation & deadline tracker for Mike Legal AI.
-- Applied to staging (jogvoukazkjvvghhkgql) and prod (xpyuygerppzdzgvqpwdj) 2026-07-10.
create table if not exists public.contract_obligations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  source_ref text,
  source_title text,
  agreement_type text,
  counterparty text,
  obligation_type text not null,
  description text not null,
  trigger_date date,
  notice_window text,
  recurring boolean default false,
  severity text default 'medium',
  status text default 'open',
  created_at timestamptz default now()
);
alter table public.contract_obligations enable row level security;
create index if not exists contract_obligations_owner_idx on public.contract_obligations(owner_id);
create index if not exists contract_obligations_trigger_idx on public.contract_obligations(owner_id, trigger_date);
