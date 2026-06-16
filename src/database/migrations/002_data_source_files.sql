-- 업로드 파일 바이너리 저장 (data_sources 연동)
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
