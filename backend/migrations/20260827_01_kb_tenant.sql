-- Tenant tag so Amavita practice sources stay distinct from bioaccess® CRO
-- playbooks. Existing rows default to bioaccess. match_kb_chunks can filter
-- by tenant; search_knowledge prefers the requested tenant and cites it.

alter table public.kb_documents
  add column if not exists tenant text not null default 'bioaccess';

update public.kb_documents
  set tenant = 'bioaccess'
  where tenant is null or tenant = '';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'kb_documents_tenant_check'
  ) then
    alter table public.kb_documents
      add constraint kb_documents_tenant_check
      check (tenant in ('bioaccess', 'amavita'));
  end if;
end $$;

create index if not exists kb_documents_owner_tenant_idx
  on public.kb_documents(owner_id, tenant);

drop function if exists public.match_kb_chunks(vector, uuid, int, text);
create function public.match_kb_chunks(
  query_embedding vector(1536),
  match_owner uuid,
  match_count int default 6,
  filter_doc_type text default null,
  filter_tenant text default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  title text,
  doc_type text,
  chunk_index int,
  content text,
  similarity float,
  tenant text
)
language sql stable
as $$
  select c.id, c.document_id, d.title, d.doc_type, c.chunk_index, c.content,
         1 - (c.embedding <=> query_embedding) as similarity,
         d.tenant
  from public.kb_chunks c
  join public.kb_documents d on d.id = c.document_id
  where c.owner_id = match_owner
    and c.embedding is not null
    and d.superseded_at is null
    and (filter_doc_type is null or d.doc_type = filter_doc_type)
    and (filter_tenant is null or d.tenant = filter_tenant)
  order by c.embedding <=> query_embedding
  limit greatest(1, match_count);
$$;
