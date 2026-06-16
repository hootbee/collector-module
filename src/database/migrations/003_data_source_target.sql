alter table data_sources
  add column if not exists target_column text,
  add column if not exists target_label text;
