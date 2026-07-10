-- Knowledge base (RAG) + Playbooks for Mike Legal AI
create extension if not exists vector;

-- ============ Knowledge base ============
create table if not exists public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  title text not null,
  doc_type text not null default 'contract',   -- contract | template | regulatory | other
  source text,                                  -- e.g. 'gdrive'
  source_ref text,                              -- external id / path / url
  created_at timestamptz not null default now()
);
create index if not exists kb_documents_owner_idx on public.kb_documents(owner_id);

create table if not exists public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.kb_documents(id) on delete cascade,
  owner_id uuid not null,
  chunk_index int not null,
  content text not null,
  embedding vector(1536),
  created_at timestamptz not null default now()
);
create index if not exists kb_chunks_document_idx on public.kb_chunks(document_id);
create index if not exists kb_chunks_embedding_idx
  on public.kb_chunks using hnsw (embedding vector_cosine_ops);

-- cosine-similarity retrieval, owner-scoped, optional doc_type filter
create or replace function public.match_kb_chunks(
  query_embedding vector(1536),
  match_owner uuid,
  match_count int default 6,
  filter_doc_type text default null
)
returns table (
  document_id uuid,
  title text,
  doc_type text,
  chunk_index int,
  content text,
  similarity float
)
language sql stable
as $$
  select c.document_id, d.title, d.doc_type, c.chunk_index, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from public.kb_chunks c
  join public.kb_documents d on d.id = c.document_id
  where c.owner_id = match_owner
    and c.embedding is not null
    and (filter_doc_type is null or d.doc_type = filter_doc_type)
  order by c.embedding <=> query_embedding
  limit greatest(1, match_count);
$$;

-- ============ Playbooks ============
create table if not exists public.playbooks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null,
  agreement_type text,          -- NDA | MSA | CRO | work_order | distribution | other
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);
create index if not exists playbooks_owner_idx on public.playbooks(owner_id);

create table if not exists public.playbook_rules (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.playbooks(id) on delete cascade,
  position int not null default 0,
  topic text not null,                 -- e.g. "Indemnification", "Governing law"
  preferred text,                      -- our preferred position/language
  acceptable_fallback text,            -- what we can live with
  dealbreaker text,                    -- what we must reject
  severity text not null default 'medium',  -- low | medium | high
  notes text
);
create index if not exists playbook_rules_playbook_idx on public.playbook_rules(playbook_id);

-- RLS: default-deny (backend uses the service role, which bypasses RLS); matches existing pattern
alter table public.kb_documents   enable row level security;
alter table public.kb_chunks       enable row level security;
alter table public.playbooks       enable row level security;
alter table public.playbook_rules  enable row level security;
