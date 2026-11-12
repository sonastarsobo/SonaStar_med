create or replace function is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'ADMIN') $$;

alter table profiles enable row level security;
alter table anatomy_systems enable row level security;
alter table anatomy_structures enable row level security;
alter table quizzes enable row level security;
alter table questions enable row level security;
alter table question_options enable row level security;
alter table assessment_attempts enable row level security;
alter table attempt_answers enable row level security;

-- profiles: own row; role cannot be changed by the user
create policy profiles_select on profiles for select using (id = auth.uid() or is_admin());
create policy profiles_update_self on profiles for update using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from profiles where id = auth.uid()));
create policy profiles_admin_all on profiles for all using (is_admin()) with check (is_admin());

-- anatomy: readable by any signed-in user, writable by admin
create policy sys_read on anatomy_systems for select to authenticated using (true);
create policy sys_admin on anatomy_systems for all using (is_admin()) with check (is_admin());
create policy str_read on anatomy_structures for select to authenticated using (true);
create policy str_admin on anatomy_structures for all using (is_admin()) with check (is_admin());

-- quizzes/questions: students see published only
create policy quiz_read on quizzes for select to authenticated using (published or is_admin());
create policy quiz_admin on quizzes for all using (is_admin()) with check (is_admin());
create policy q_read on questions for select to authenticated
  using (is_admin() or exists(select 1 from quizzes z where z.id = quiz_id and z.published));
create policy q_admin on questions for all using (is_admin()) with check (is_admin());

-- options: students get NO direct table access (is_correct must stay hidden).
-- A student-safe view/function is added in Stage 5.
create policy opt_admin on question_options for all using (is_admin()) with check (is_admin());

-- attempts: students read their own; create/finalize only via Edge Functions (service role)
create policy att_read on assessment_attempts for select using (user_id = auth.uid() or is_admin());
create policy ans_read on attempt_answers for select
  using (is_admin() or exists(select 1 from assessment_attempts a where a.id = attempt_id and a.user_id = auth.uid()));

-- Storage bucket for 3D models (public read, admin write)
insert into storage.buckets(id,name,public) values ('anatomy-models','anatomy-models',true) on conflict do nothing;
create policy models_admin_write on storage.objects for all
  using (bucket_id = 'anatomy-models' and is_admin()) with check (bucket_id = 'anatomy-models' and is_admin());
