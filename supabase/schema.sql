-- UniTimetable — schéma Supabase (PostgreSQL) pour le déploiement en ligne (Vercel).
-- À exécuter UNE FOIS dans Supabase : SQL Editor > New query > coller ce fichier > Run.
-- Ré-exécutable sans perte : uniquement « create … if not exists » / « create or replace ».
--
-- Sécurité : RLS activé SANS aucune politique => tables inaccessibles avec la clé publique (anon / authenticated).
-- Seul le serveur (clé service_role, variable d'environnement Vercel) lit et écrit, via les fonctions ci-dessous.

-- Les documents sont stockés en type « json » (texte exact conservé, ordre des clés compris) et non « jsonb » :
-- le journal d'audit est chaîné par empreintes SHA-256 calculées sur le texte exact des entrées.
create table if not exists public.unitt_docs (
  id         text primary key check (id in ('store', 'state')),   -- store : comptes, absences, liens, alertes, audit ; state : données de l'établissement
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
