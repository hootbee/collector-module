-- pipelines 공개/연결 컬럼 (구버전 DB 호환)
alter table pipelines add column if not exists is_public boolean;
update pipelines set is_public = false where is_public is null;
alter table pipelines alter column is_public set default false;
alter table pipelines alter column is_public set not null;

alter table pipelines add column if not exists visibility_locked boolean;
update pipelines set visibility_locked = false where visibility_locked is null;
alter table pipelines alter column visibility_locked set default false;
alter table pipelines alter column visibility_locked set not null;

alter table pipelines add column if not exists linked_data_source_id text;
