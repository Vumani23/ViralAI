create table if not exists public.social_connections (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('facebook', 'instagram', 'tiktok')),
  access_token_enc text not null,
  refresh_token_enc text,
  account_id text not null,
  page_id text,
  account_name text,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.social_connections enable row level security;

-- No browser role policies are intentional. Only the server's service-role key
-- can read or mutate encrypted provider credentials.
revoke all on public.social_connections from anon, authenticated;
grant all on public.social_connections to service_role;