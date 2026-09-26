CREATE TABLE IF NOT EXISTS schema_migrations(version text primary key, applied_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS users(id uuid primary key default gen_random_uuid(),username text unique not null,password_hash text not null,role text not null);
CREATE TABLE IF NOT EXISTS accounts(id text primary key,status text not null,platform_user_id text,rate_limited_until timestamptz,version int not null default 0);
CREATE TABLE IF NOT EXISTS groups(id uuid primary key default gen_random_uuid(),gateway_group_id text unique not null,status text not null default 'active',creator_account_id text not null references accounts(id),agent_enabled boolean not null default false,auto_kick_enabled boolean not null default false);
CREATE TABLE IF NOT EXISTS group_members(group_id uuid references groups(id) on delete cascade,account_id text references accounts(id),platform_user_id text not null,role text not null,primary key(group_id,account_id));
CREATE TABLE IF NOT EXISTS messages(id uuid primary key default gen_random_uuid(),group_id uuid references groups(id),msg_id text,client_msg_id text,text text not null,sender_platform_user_id text,sent_at timestamptz not null,delivery_status text,fail_code text,is_own boolean not null default false,unique(group_id,msg_id),unique(group_id,client_msg_id));
CREATE TABLE IF NOT EXISTS jobs(id uuid primary key default gen_random_uuid(),status text not null,errors jsonb not null default '[]');
CREATE TABLE IF NOT EXISTS sequences(id uuid primary key default gen_random_uuid(),name text not null,steps jsonb not null);
CREATE TABLE IF NOT EXISTS sequence_runs(id uuid primary key default gen_random_uuid(),group_id uuid references groups(id),sequence_id uuid references sequences(id),status text not null,current_step_index int not null default 0,steps jsonb not null,vars jsonb not null default '{}');
CREATE TABLE IF NOT EXISTS agent_runs(id uuid primary key default gen_random_uuid(),group_id uuid references groups(id),status text not null,end_reason text,summary text,steps jsonb not null default '[]',created_at timestamptz default now());
CREATE TABLE IF NOT EXISTS refresh_sessions(id uuid primary key default gen_random_uuid(),user_id uuid references users(id),token_hash text unique not null,revoked boolean not null default false,expires_at timestamptz not null);
CREATE UNIQUE INDEX IF NOT EXISTS one_running_sequence_per_group ON sequence_runs(group_id) WHERE status='running';
CREATE UNIQUE INDEX IF NOT EXISTS one_running_agent_per_group ON agent_runs(group_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS messages_group_sent_idx ON messages(group_id,sent_at DESC);
ALTER TABLE sequence_runs ADD COLUMN IF NOT EXISTS vars jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS gateway_events (
  event_id bigint PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gateway_cursor (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  event_id bigint NOT NULL DEFAULT 0
);
INSERT INTO gateway_cursor(id, event_id) VALUES (true, 0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS websocket_events (
  seq bigserial PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sequence_runs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS auth_session_id uuid REFERENCES auth_sessions(id);
ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS used_at timestamptz;
CREATE INDEX IF NOT EXISTS refresh_sessions_family_idx ON refresh_sessions(auth_session_id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS outbound_account_id text REFERENCES accounts(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS send_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attempted_at timestamptz;
CREATE INDEX IF NOT EXISTS outbound_pending_idx ON messages(sent_at,id) WHERE delivery_status IN ('queued','unknown');
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS history jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS trigger_messages jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS protocol_errors integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS agent_pending_messages (
  group_id uuid NOT NULL REFERENCES groups(id),
  msg_id text NOT NULL,
  sender_platform_user_id text NOT NULL,
  text text NOT NULL,
  sent_at timestamptz NOT NULL,
  PRIMARY KEY(group_id,msg_id)
);
CREATE TABLE IF NOT EXISTS agent_tool_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(id),
  idempotency_key text NOT NULL,
  tool_name text NOT NULL,
  status text NOT NULL,
  client_msg_id text,
  result jsonb,
  UNIQUE(run_id,idempotency_key)
);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS remaining_ms integer NOT NULL DEFAULT 60000;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES groups(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress jsonb NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
CREATE INDEX IF NOT EXISTS jobs_recovery_idx ON jobs(status,lease_until) WHERE status='running';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_url text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS local_file_path text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_content_type text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_retry_after timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_download_attempts integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS messages_media_pending_idx ON messages(media_retry_after) WHERE media_url IS NOT NULL AND local_file_path IS NULL;
