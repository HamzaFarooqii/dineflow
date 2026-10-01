-- Day 1 (API security): reusable public-endpoint rate limiting (apps/api/src/lib/rate-limit.ts).
-- Postgres-backed rather than in-process memory, specifically so the limit is actually enforced
-- across more than one API process/instance -- an in-memory counter would silently stop being a
-- real limit the moment this API runs behind a load balancer with more than one instance, which
-- nothing in this architecture rules out. Fixed-window counting: one row per (bucket_key, window
-- start), incremented with a single upsert; a row older than every caller's own window is inert
-- and safe to reap with a periodic delete (not required for correctness, only for table size).
create table public.rate_limit_buckets (
  bucket_key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket_key, window_start)
);

alter table public.rate_limit_buckets enable row level security;
create policy rate_limit_buckets_service_role_only on public.rate_limit_buckets
  for all to authenticated, anon using (false);
