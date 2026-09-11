-- Kane PC website — customer onboarding tokens
-- Applied to Supabase project vwjsunupqgendxzclhro (KANEPC-WEBSITE) 2026-09-10.
--
-- Single-use or standing codes that let a new customer download a NinjaOne agent
-- installer scoped to THEIR organization/location, without the installer URL
-- ever being public.
--
-- Security posture:
--   * Only the SHA-256 hash of a code is stored. A database leak yields no
--     usable onboarding codes.
--   * RLS is enabled with NO policies, so anon and authenticated read nothing.
--     Only service_role (the Netlify function) touches these tables. The
--     rls_enabled_no_policy advisor notice this raises is the intended state.
--   * consume_onboarding_token() validates and increments in ONE statement, so
--     two simultaneous clicks cannot both consume a single-use code.

create table if not exists public.onboarding_tokens (
  id             uuid primary key default gen_random_uuid(),
  token_hash     text        not null unique,
  label          text        not null,
  org_id         integer     not null,
  location_id    integer,
  installer_type text        not null default 'WINDOWS_MSI',
  expires_at     timestamptz not null,
  max_uses       integer     not null default 1 check (max_uses > 0),
  used_count     integer     not null default 0,
  revoked_at     timestamptz,
  created_by     text,
  created_at     timestamptz not null default now()
);

create table if not exists public.onboarding_events (
  id           uuid primary key default gen_random_uuid(),
  token_id     uuid references public.onboarding_tokens(id) on delete set null,
  outcome      text not null check (outcome in ('issued','rejected')),
  reason       text,
  intake_name  text,
  intake_email text,
  asset_tag    text,
  department   text,
  ip           text,
  user_agent   text,
  created_at   timestamptz not null default now()
);

create index if not exists onboarding_events_token_idx
  on public.onboarding_events (token_id, created_at desc);

alter table public.onboarding_tokens enable row level security;
alter table public.onboarding_events enable row level security;

create or replace function public.consume_onboarding_token(p_token_hash text)
returns table (
  id             uuid,
  org_id         integer,
  location_id    integer,
  installer_type text,
  label          text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.onboarding_tokens t
     set used_count = t.used_count + 1
   where t.token_hash = p_token_hash
     and t.revoked_at is null
     and t.expires_at > now()
     and t.used_count < t.max_uses
  returning t.id, t.org_id, t.location_id, t.installer_type, t.label;
end;
$$;

revoke all on function public.consume_onboarding_token(text) from public, anon, authenticated;
