-- UniTimetable — schéma Supabase (PostgreSQL) pour le déploiement en ligne (Vercel).
-- À exécuter UNE FOIS dans Supabase : SQL Editor > New query > coller ce fichier > Run.
-- Ré-exécutable sans perte : uniquement « create … if not exists » / « create or replace ».
--
-- Sécurité : RLS activé SANS aucune politique => tables inaccessibles avec la clé publique (anon / authenticated).
-- Seul le serveur (clé service_role, variable d'environnement Vercel) lit et écrit, via les fonctions ci-dessous.

-- Les documents sont stockés en type « json » (texte exact conservé, ordre des clés compris) et non « jsonb » :
-- le journal d'audit est chaîné par empreintes SHA-256 calculées sur le texte exact des entrées.
create table if not exists public.unitt_docs (
  id         text primary key,                                   -- store[:<établissement>] : comptes, absences, liens, alertes ; state[:<établissement>] : données ; platform : plateforme
  data       json not null,
  version    bigint not null default 1,                         -- contrôle de concurrence optimiste
  updated_at timestamptz not null default now()
);
create table if not exists public.unitt_history (                -- révisions de « state » (fusion des modifications entre postes)
  rev        integer primary key,
  data       json not null,
  created_at timestamptz not null default now()
);
create table if not exists public.unitt_backups (                -- sauvegardes (manuelles, automatiques, avant remplacement)
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  reason     text,
  store      json,
  state      json,
  bytes      bigint
);

alter table public.unitt_docs    enable row level security;
alter table public.unitt_history enable row level security;
alter table public.unitt_backups enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.unitt_docs, public.unitt_history, public.unitt_backups from anon;
    revoke all on sequence public.unitt_backups_id_seq from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.unitt_docs, public.unitt_history, public.unitt_backups from authenticated;
    revoke all on sequence public.unitt_backups_id_seq from authenticated;
  end if;
end $$;

-- Enregistrement ATOMIQUE et CONDITIONNEL des deux documents (+ révision d'historique).
-- Si la version attendue ne correspond plus (écriture concurrente d'une autre instance), rien n'est écrit : exception « unitt_conflict ».
drop function if exists public.unitt_save(jsonb, bigint, jsonb, bigint, integer, jsonb, integer);
create or replace function public.unitt_save(
  p_store json, p_store_version bigint,
  p_state json, p_state_version bigint,
  p_hist_rev integer, p_hist_data json, p_hist_keep integer default 50
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_store bigint; v_state bigint; n integer;
begin
  if p_store is not null then
    if coalesce(p_store_version, 0) = 0 then
      insert into unitt_docs(id, data, version) values ('store', p_store, 1) on conflict (id) do nothing;
      get diagnostics n = row_count; if n = 0 then raise exception 'unitt_conflict'; end if; v_store := 1;
    else
      update unitt_docs set data = p_store, version = version + 1, updated_at = now()
       where id = 'store' and version = p_store_version returning version into v_store;
      if not found then raise exception 'unitt_conflict'; end if;
    end if;
  end if;
  if p_state is not null then
    if coalesce(p_state_version, 0) = 0 then
      insert into unitt_docs(id, data, version) values ('state', p_state, 1) on conflict (id) do nothing;
      get diagnostics n = row_count; if n = 0 then raise exception 'unitt_conflict'; end if; v_state := 1;
    else
      update unitt_docs set data = p_state, version = version + 1, updated_at = now()
       where id = 'state' and version = p_state_version returning version into v_state;
      if not found then raise exception 'unitt_conflict'; end if;
    end if;
  end if;
  if p_hist_rev is not null and p_hist_data is not null then
    insert into unitt_history(rev, data) values (p_hist_rev, p_hist_data) on conflict (rev) do update set data = excluded.data, created_at = now();
    delete from unitt_history where rev <= p_hist_rev - greatest(coalesce(p_hist_keep, 50), 2);
  end if;
  return jsonb_build_object('store_version', v_store, 'state_version', v_state);
end $$;

-- Sauvegarde côté base (copie des deux documents), en gardant les p_keep plus récentes.
create or replace function public.unitt_backup(p_reason text, p_keep integer default 30) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into unitt_backups(reason, store, state, bytes)
  select p_reason, (select data from unitt_docs where id = 'store'), (select data from unitt_docs where id = 'state'),
         coalesce((select sum(length(data::text)) from unitt_docs), 0)
  returning id into v_id;
  delete from unitt_backups where id not in (select id from unitt_backups order by id desc limit greatest(coalesce(p_keep, 30), 1));
  return jsonb_build_object('id', v_id);
end $$;

-- Restauration d'une sauvegarde (depuis le SQL Editor uniquement) : select public.unitt_restore(<id>);
-- Une sauvegarde de l'état actuel est faite d'abord ; la version est incrémentée (les postes rechargent).
create or replace function public.unitt_restore(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b unitt_backups%rowtype; v_rev integer;
begin
  select * into b from unitt_backups where id = p_id; if not found then raise exception 'Sauvegarde % introuvable', p_id; end if;
  perform unitt_backup('avant-restauration', 1000);
  if b.store is not null then update unitt_docs set data = b.store, version = version + 1, updated_at = now() where id = 'store'; end if;
  if b.state is not null then
    select coalesce((data->>'rev')::int, 0) into v_rev from unitt_docs where id = 'state';
    update unitt_docs set data = jsonb_set(b.state::jsonb, '{rev}', to_jsonb(greatest(v_rev, coalesce((b.state->>'rev')::int, 0)) + 1))::json, version = version + 1, updated_at = now() where id = 'state';
    delete from unitt_history;
  end if;
  return jsonb_build_object('restored', p_id);
end $$;

revoke execute on function public.unitt_save(json, bigint, json, bigint, integer, json, integer) from public;
revoke execute on function public.unitt_backup(text, integer) from public;
revoke execute on function public.unitt_restore(bigint) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.unitt_save(json, bigint, json, bigint, integer, json, integer) to service_role;
    grant execute on function public.unitt_backup(text, integer) to service_role;
    grant select on public.unitt_docs, public.unitt_history, public.unitt_backups to service_role;
  end if;
end $$;

-- =====================================================================================================
-- Version 3 : plateforme multi-établissements (Super Admin), journal d'audit séparé en AJOUT SEUL.
-- Ré-exécutable. Les données existantes (documents « store » / « state ») deviennent le premier établissement.
-- =====================================================================================================
alter table public.unitt_docs drop constraint if exists unitt_docs_id_check;
alter table public.unitt_docs drop constraint if exists unitt_docs_id_format;
alter table public.unitt_docs add constraint unitt_docs_id_format check (id ~ '^(platform|(store|state)(:[a-f0-9]{16})?)$');

-- historique et sauvegardes : une colonne « tenant » ('' = premier établissement, données d'origine)
alter table public.unitt_history add column if not exists tenant text not null default '';
alter table public.unitt_history drop constraint if exists unitt_history_pkey;
alter table public.unitt_history add primary key (tenant, rev);
alter table public.unitt_backups add column if not exists tenant text not null default '';
create index if not exists unitt_backups_tenant on public.unitt_backups(tenant, id desc);

-- journal d'audit : table séparée, une ligne par événement, chaînée ; tenant = '' / id d'établissement / 'platform'
create table if not exists public.unitt_audit (
  id     bigserial primary key,
  tenant text not null,
  at     timestamptz not null default now(),
  prev   text not null,
  h      text not null unique,
  entry  json not null
);
create index if not exists unitt_audit_tenant on public.unitt_audit(tenant, id);
alter table public.unitt_audit enable row level security;
create or replace function public.unitt_audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'unitt_audit_append_only : le journal d''audit ne peut être ni modifié ni supprimé'; end $$;
drop trigger if exists unitt_audit_no_update on public.unitt_audit;
create trigger unitt_audit_no_update before update or delete on public.unitt_audit for each row execute function public.unitt_audit_immutable();
drop trigger if exists unitt_audit_no_truncate on public.unitt_audit;
create trigger unitt_audit_no_truncate before truncate on public.unitt_audit for each statement execute function public.unitt_audit_immutable();
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.unitt_audit from anon; revoke all on sequence public.unitt_audit_id_seq from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.unitt_audit from authenticated; revoke all on sequence public.unitt_audit_id_seq from authenticated; end if;
end $$;

-- Chargement en un seul appel : documents demandés + dernière empreinte du journal de chaque établissement demandé
create or replace function public.unitt_load(p_ids text[], p_tenants text[]) returns json
language plpgsql security definer set search_path = public as $$
declare v_docs json; v_last json;
begin
  select coalesce(json_agg(json_build_object('id', id, 'data', data, 'version', version)), '[]'::json) into v_docs from unitt_docs where id = any(p_ids);
  select coalesce(json_object_agg(t, (select a.h from unitt_audit a where a.tenant = t order by a.id desc limit 1)), '{}'::json) into v_last from unnest(p_tenants) t;
  return json_build_object('docs', v_docs, 'last', v_last);
end $$;

-- Enregistrement ATOMIQUE et CONDITIONNEL de plusieurs documents + entrées d'audit + révision d'historique.
-- p_docs  : [{ "id": "store:…", "data": {…}, "version": 3 }]   (version 0 = création)
-- p_audit : [{ "tenant": "…", "entry": {… "prev": "…", "h": "…" } }]  dans l'ordre ; chaque prev doit suivre la chaîne existante
-- p_hist  : { "tenant": "…", "rev": 12, "data": {…}, "keep": 50 } ou null
create or replace function public.unitt_save_docs(p_docs json, p_audit json, p_hist json) returns json
language plpgsql security definer set search_path = public as $$
declare d json; a json; v bigint; n integer; out json := '{}'::json; t text; last text; tenants text[];
begin
  for d in select * from json_array_elements(coalesce(p_docs, '[]'::json)) loop
    if coalesce((d->>'version')::bigint, 0) = 0 then
      insert into unitt_docs(id, data, version) values (d->>'id', d->'data', 1) on conflict (id) do nothing;
      get diagnostics n = row_count; if n = 0 then raise exception 'unitt_conflict'; end if; v := 1;
    else
      update unitt_docs set data = d->'data', version = version + 1, updated_at = now()
       where id = d->>'id' and version = (d->>'version')::bigint returning version into v;
      if not found then raise exception 'unitt_conflict'; end if;
    end if;
    out := (out::jsonb || jsonb_build_object(d->>'id', v))::json;
  end loop;
  select array_agg(distinct x->>'tenant') into tenants from json_array_elements(coalesce(p_audit, '[]'::json)) x;
  if tenants is not null then
    foreach t in array tenants loop perform pg_advisory_xact_lock(hashtext('unitt_audit:' || t)); end loop;
  end if;
  for a in select * from json_array_elements(coalesce(p_audit, '[]'::json)) loop
    t := a->>'tenant';
    select h into last from unitt_audit where tenant = t order by id desc limit 1;
    if coalesce(last, repeat('0', 64)) <> (a->'entry'->>'prev') then raise exception 'unitt_conflict'; end if;
    insert into unitt_audit(tenant, at, prev, h, entry) values (t, coalesce((a->'entry'->>'at')::timestamptz, now()), a->'entry'->>'prev', a->'entry'->>'h', a->'entry');
  end loop;
  if p_hist is not null and p_hist::text <> 'null' then
    insert into unitt_history(tenant, rev, data) values (coalesce(p_hist->>'tenant', ''), (p_hist->>'rev')::int, p_hist->'data')
      on conflict (tenant, rev) do update set data = excluded.data, created_at = now();
    delete from unitt_history where tenant = coalesce(p_hist->>'tenant', '') and rev <= (p_hist->>'rev')::int - greatest(coalesce((p_hist->>'keep')::int, 50), 2);
  end if;
  return out;
end $$;

-- Sauvegarde d'un établissement (ses deux documents), en gardant les p_keep plus récentes de cet établissement
create or replace function public.unitt_backup_t(p_tenant text, p_reason text, p_keep integer default 30) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id bigint; k text := case when coalesce(p_tenant, '') = '' then '' else ':' || p_tenant end;
begin
  insert into unitt_backups(tenant, reason, store, state, bytes)
  select coalesce(p_tenant, ''), p_reason, (select data from unitt_docs where id = 'store' || k), (select data from unitt_docs where id = 'state' || k),
         coalesce((select sum(length(data::text)) from unitt_docs where id in ('store' || k, 'state' || k)), 0)
  returning id into v_id;
  delete from unitt_backups where tenant = coalesce(p_tenant, '') and id not in (select id from unitt_backups where tenant = coalesce(p_tenant, '') order by id desc limit greatest(coalesce(p_keep, 30), 1));
  return jsonb_build_object('id', v_id);
end $$;

-- Lecture filtrée du journal (historique d'activité) ; p_filter : { user, event, section, result, from, to, record, q }
create or replace function public.unitt_audit_query(p_tenant text, p_filter json, p_limit integer, p_offset integer, p_order text) returns json
language plpgsql security definer set search_path = public as $$
declare v_total bigint; v_items json; f json := coalesce(p_filter, '{}'::json);
begin
  create temporary table if not exists _unitt_aq(id bigint, entry json) on commit drop;
  delete from _unitt_aq;
  insert into _unitt_aq select a.id, a.entry from unitt_audit a
   where a.tenant = p_tenant
     and (f->>'user' is null or lower(a.entry->>'user') = lower(f->>'user'))
     and (f->>'userId' is null or a.entry->>'userId' = f->>'userId')
     and (f->>'event' is null or a.entry->>'event' ilike '%' || (f->>'event') || '%')
     and (f->>'section' is null or lower(a.entry->>'section') = lower(f->>'section'))
     and (f->>'result' is null or lower(a.entry->>'result') = lower(f->>'result'))
     and (f->>'from' is null or a.entry->>'at' >= f->>'from')
     and (f->>'to' is null or a.entry->>'at' <= (f->>'to') || case when length(f->>'to') = 10 then 'T23:59:59.999Z' else '' end)
     and (f->>'record' is null or a.entry::text ilike '%' || (f->>'record') || '%')
     and (f->>'q' is null or a.entry::text ilike '%' || (f->>'q') || '%');
  select count(*) into v_total from _unitt_aq;
  if p_order = 'asc' then
    select coalesce(json_agg(entry order by id), '[]'::json) into v_items from (select id, entry from _unitt_aq order by id asc limit greatest(p_limit, 1) offset greatest(p_offset, 0)) x;
  else
    select coalesce(json_agg(entry order by id desc), '[]'::json) into v_items from (select id, entry from _unitt_aq order by id desc limit greatest(p_limit, 1) offset greatest(p_offset, 0)) x;
  end if;
  return json_build_object('total', v_total, 'items', v_items);
end $$;

revoke execute on function public.unitt_load(text[], text[]) from public;
revoke execute on function public.unitt_save_docs(json, json, json) from public;
revoke execute on function public.unitt_backup_t(text, text, integer) from public;
revoke execute on function public.unitt_audit_query(text, json, integer, integer, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.unitt_load(text[], text[]) to service_role;
    grant execute on function public.unitt_save_docs(json, json, json) to service_role;
    grant execute on function public.unitt_backup_t(text, text, integer) to service_role;
    grant execute on function public.unitt_audit_query(text, json, integer, integer, text) to service_role;
    grant select on public.unitt_audit to service_role;
  end if;
end $$;
