-- Make KB metadata reproducible and preserve the last good Drive version until
-- its replacement has been embedded successfully.
alter table public.kb_documents add column if not exists content_hash text;
alter table public.kb_documents add column if not exists source_tag text;
alter table public.kb_documents add column if not exists source_url text;
alter table public.kb_documents add column if not exists drive_file_id text;
alter table public.kb_documents add column if not exists drive_version text;
alter table public.kb_documents add column if not exists mime_type text;
alter table public.kb_documents add column if not exists superseded_at timestamptz;
alter table public.kb_documents add column if not exists supersedes_document_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'kb_documents_supersedes_document_fk'
  ) then
    alter table public.kb_documents
      add constraint kb_documents_supersedes_document_fk
      foreign key (supersedes_document_id) references public.kb_documents(id) on delete set null;
  end if;
end $$;

create index if not exists kb_documents_owner_hash_idx
  on public.kb_documents(owner_id, content_hash);
create index if not exists kb_documents_active_drive_idx
  on public.kb_documents(owner_id, drive_file_id)
  where drive_file_id is not null and superseded_at is null;

drop function if exists public.match_kb_chunks(vector, uuid, int, text);
create function public.match_kb_chunks(
  query_embedding vector(1536),
  match_owner uuid,
  match_count int default 6,
  filter_doc_type text default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  title text,
  doc_type text,
  chunk_index int,
  content text,
  similarity float
)
language sql stable
as $$
  select c.id, c.document_id, d.title, d.doc_type, c.chunk_index, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from public.kb_chunks c
  join public.kb_documents d on d.id = c.document_id
  where c.owner_id = match_owner
    and c.embedding is not null
    and d.superseded_at is null
    and (filter_doc_type is null or d.doc_type = filter_doc_type)
  order by c.embedding <=> query_embedding
  limit greatest(1, match_count);
$$;
