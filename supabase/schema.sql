-- GermanIAI · esquema de base de datos (Supabase / PostgreSQL)
-- Ejecutar una sola vez en Supabase > SQL Editor.

-- Administrador único
create or replace function public.es_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'dohmenger@gmail.com'
$$;

-- Perfil opcional de cada usuario (privado: sólo lo ve su dueño y el administrador)
create table if not exists public.perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text,
  pais text,
  provincia text,
  ocupacion text,
  acepta_terminos_at timestamptz,
  creado_at timestamptz default now()
);
alter table public.perfiles enable row level security;
create policy "perfil propio: leer"      on public.perfiles for select using (auth.uid() = id or public.es_admin());
create policy "perfil propio: crear"     on public.perfiles for insert with check (auth.uid() = id);
create policy "perfil propio: modificar" on public.perfiles for update using (auth.uid() = id);
create policy "perfil propio: borrar"    on public.perfiles for delete using (auth.uid() = id);

-- Investigaciones (preguntas + respuestas + fuentes)
create table if not exists public.investigaciones (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references auth.users(id) on delete set null,
  ia text not null,
  familia text,
  tema text,
  pregunta text not null,
  respuesta text not null,
  fuentes jsonb default '[]'::jsonb,
  busquedas int default 0,
  modelo text,
  autoriza_publicar boolean default false,
  estado text not null default 'privada' check (estado in ('privada','pendiente','aprobada','descartada')),
  creada_at timestamptz default now(),
  revisada_at timestamptz
);
create index if not exists inv_estado_idx on public.investigaciones(estado);
create index if not exists inv_familia_idx on public.investigaciones(familia, tema);
alter table public.investigaciones enable row level security;
-- Público: sólo lo aprobado
create policy "publico: aprobadas" on public.investigaciones for select using (estado = 'aprobada');
-- Cada usuario ve las suyas; el administrador ve todo
create policy "usuario: propias"   on public.investigaciones for select using (auth.uid() = usuario_id or public.es_admin());
create policy "usuario: borrar propias" on public.investigaciones for delete using (auth.uid() = usuario_id or public.es_admin());
create policy "admin: revisar"     on public.investigaciones for update using (public.es_admin());
-- Las altas las hace sólo el servidor (clave de servicio), nunca el navegador.

-- Estadísticas agregadas (sin datos personales), legibles por el público
create or replace view public.estadisticas as
  select familia, tema, ia, estado, date_trunc('day', creada_at)::date as dia, count(*)::int as cantidad
  from public.investigaciones group by 1,2,3,4,5;
grant select on public.estadisticas to anon, authenticated;
