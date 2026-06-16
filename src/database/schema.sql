create table if not exists users (
  id text primary key,
  email text not null unique,
  name text not null,
  avatar_url text,
  role text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists oauth_accounts (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  provider text not null,
  provider_user_id text not null,
  email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, provider_user_id)
);

create table if not exists local_accounts (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  login_id text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists refresh_tokens (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists data_sources (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  name text not null,
  source text not null,
  rows_label text,
  linked_pipeline_id text,
  domain_industry_context text,
  domain_subject_scope text,
  domain_regulation_scope text,
  domain_stakeholder_notes text,
  data_modality text,
  row_unit text,
  sensitivity_note text,
  target_column text,
  target_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table data_sources alter column user_id drop not null;

create table if not exists pipelines (
  id text primary key,
  user_id text references users(id) on delete cascade,
  is_public boolean not null default false,
  visibility_locked boolean not null default false,
  linked_data_source_id text,
  kind text not null,
  domain_key text,
  domain_label text,
  title text not null,
  description text not null default '',
  module_ids jsonb not null default '[]'::jsonb,
  connected_after jsonb not null default '[]'::jsonb,
  module_layout jsonb not null default '{}'::jsonb,
  highlight text,
  auto_named boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table pipelines add column if not exists is_public boolean;
update pipelines set is_public = false where is_public is null;
alter table pipelines alter column is_public set default false;
alter table pipelines alter column is_public set not null;
alter table pipelines add column if not exists visibility_locked boolean;
update pipelines set visibility_locked = false where visibility_locked is null;
alter table pipelines alter column visibility_locked set default false;
alter table pipelines alter column visibility_locked set not null;
alter table pipelines add column if not exists linked_data_source_id text;

create table if not exists module_snapshots (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  pipeline_id text references pipelines(id) on delete cascade,
  module_id text not null,
  summary text not null default '',
  data jsonb,
  saved_at timestamptz not null default now(),
  unique(user_id, pipeline_id, module_id)
);

alter table module_snapshots alter column user_id drop not null;

create table if not exists orchestrator_jobs (
  id text primary key,
  user_id text references users(id) on delete set null,
  pipeline_id text references pipelines(id) on delete set null,
  data_source_id text references data_sources(id) on delete set null,
  module_type text not null,
  status text not null,
  stage text not null,
  input jsonb not null default '{}'::jsonb,
  result_summary jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table if not exists collection_jobs (
  id text primary key,
  orchestrator_job_id text references orchestrator_jobs(id) on delete set null,
  user_id text references users(id) on delete set null,
  query text not null,
  kind text not null,
  sources jsonb not null default '[]'::jsonb,
  status text not null,
  stage text not null,
  dataset_queries jsonb not null default '[]'::jsonb,
  knowledge_queries jsonb not null default '[]'::jsonb,
  connector_statuses jsonb not null default '[]'::jsonb,
  llm_plan jsonb,
  record jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

alter table collection_jobs add column if not exists record jsonb;

create table if not exists collection_results (
  id text primary key,
  collection_job_id text not null references collection_jobs(id) on delete cascade,
  item_type text not null,
  source text,
  provider text,
  title text not null,
  source_url text,
  download_url text,
  metadata jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  score double precision,
  created_at timestamptz not null default now()
);

create table if not exists download_jobs (
  id text primary key,
  collection_job_id text not null references collection_jobs(id) on delete cascade,
  status text not null,
  stage text not null,
  target_root text not null,
  requested_item_ids jsonb not null default '[]'::jsonb,
  max_files_per_item integer not null default 1,
  item_results jsonb not null default '[]'::jsonb,
  record jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

alter table download_jobs add column if not exists requested_item_ids jsonb not null default '[]'::jsonb;
alter table download_jobs add column if not exists max_files_per_item integer not null default 1;
alter table download_jobs add column if not exists item_results jsonb not null default '[]'::jsonb;
alter table download_jobs add column if not exists record jsonb;

create table if not exists download_files (
  id text primary key,
  download_job_id text not null references download_jobs(id) on delete cascade,
  collection_result_id text references collection_results(id) on delete set null,
  file_name text not null,
  file_path text not null,
  bytes bigint not null,
  content_type text,
  source_url text,
  created_at timestamptz not null default now()
);

create table if not exists job_logs (
  id bigserial primary key,
  job_id text not null,
  job_type text not null,
  level text not null,
  message text not null,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_oauth_accounts_user_id on oauth_accounts(user_id);
create index if not exists idx_local_accounts_user_id on local_accounts(user_id);
create index if not exists idx_refresh_tokens_user_id on refresh_tokens(user_id);
create table if not exists data_source_files (
  id text primary key,
  data_source_id text not null references data_sources(id) on delete cascade,
  file_name text not null,
  content_type text,
  bytes bigint not null default 0,
  content bytea not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_data_source_files_data_source_id on data_source_files(data_source_id);

create index if not exists idx_data_sources_user_id on data_sources(user_id);
create index if not exists idx_pipelines_user_id on pipelines(user_id);
create index if not exists idx_pipelines_is_public_updated_at on pipelines(is_public, updated_at desc);
create index if not exists idx_orchestrator_jobs_user_id on orchestrator_jobs(user_id);
create index if not exists idx_collection_jobs_user_id on collection_jobs(user_id);
create index if not exists idx_collection_results_job_id on collection_results(collection_job_id);
create index if not exists idx_download_jobs_collection_job_id on download_jobs(collection_job_id);
create index if not exists idx_job_logs_job on job_logs(job_type, job_id);
