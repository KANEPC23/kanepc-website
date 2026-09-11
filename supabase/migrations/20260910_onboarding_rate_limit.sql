-- Kane PC website — onboarding brute-force throttle
-- Applied to Supabase project vwjsunupqgendxzclhro (KANEPC-WEBSITE) 2026-09-10.
--
-- Short typeable codes replace long URL tokens, so brute force becomes a real
-- threat model for the first time. 8 Crockford base32 chars is ~1.1e12 of
-- keyspace, which is plenty ONLY if guessing is throttled.
--
-- The throttle reuses onboarding_events rather than adding a table: every
-- rejection is already recorded with an IP, so recent failures per IP are the
-- natural rate signal. Counting server-side also means it survives function cold
-- starts — an in-memory counter would reset constantly and reward an attacker
-- for spreading attempts out.

create index if not exists onboarding_events_ip_recent_idx
  on public.onboarding_events (ip, created_at desc)
  where outcome = 'rejected';

create or replace function public.onboard_rate_limited(p_ip text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce(count(*), 0) >= 10
    from public.onboarding_events
   where ip = p_ip
     and outcome = 'rejected'
     and created_at > now() - interval '15 minutes';
$$;

revoke all on function public.onboard_rate_limited(text) from public, anon, authenticated;
