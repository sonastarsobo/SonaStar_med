create extension if not exists pgcrypto;
create type user_role as enum ('ADMIN','STUDENT');
create type question_type as enum ('MULTIPLE_CHOICE','IDENTIFY_3D','FIND_STRUCTURE');
create type attempt_status as enum ('IN_PROGRESS','COMPLETED','TIMEOUT','ABANDONED');

create table profiles(id uuid primary key references auth.users(id) on delete cascade,
  name text not null, role user_role not null default 'STUDENT', created_at timestamptz not null default now());
create table anatomy_systems(id uuid primary key default gen_random_uuid(), name text not null unique,
  description text, display_order int not null default 0, created_at timestamptz not null default now());
create table anatomy_structures(id uuid primary key default gen_random_uuid(),
  system_id uuid not null references anatomy_systems(id) on delete restrict,
  parent_id uuid references anatomy_structures(id) on delete set null,
  name text not null, description text, location text, function text, important_features text,
  model_object_id text, model_file_path text, created_at timestamptz not null default now());
create table quizzes(id uuid primary key default gen_random_uuid(), title text not null, description text,
  system_id uuid references anatomy_systems(id) on delete set null,
  duration_seconds int not null default 600 check (duration_seconds > 0),
  passing_score numeric not null default 60 check (passing_score between 0 and 100),
  published boolean not null default false,
  created_by uuid references profiles(id) on delete set null, created_at timestamptz not null default now());
create table questions(id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references quizzes(id) on delete cascade,
  question_text text not null, question_type question_type not null default 'MULTIPLE_CHOICE',
  points int not null default 1 check (points > 0), explanation text,
  correct_structure_id uuid references anatomy_structures(id) on delete set null,
  display_order int not null default 0, created_at timestamptz not null default now());
create table question_options(id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id) on delete cascade,
  option_text text not null, is_correct boolean not null default false);
create table assessment_attempts(id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  quiz_id uuid not null references quizzes(id) on delete cascade,
  started_at timestamptz not null default now(), submitted_at timestamptz, time_taken_seconds int,
  score numeric, total_points numeric, percentage numeric,
  status attempt_status not null default 'IN_PROGRESS');
create table attempt_answers(id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references assessment_attempts(id) on delete cascade,
  question_id uuid not null references questions(id) on delete cascade,
  selected_option_id uuid references question_options(id) on delete set null,
  selected_structure_id uuid references anatomy_structures(id) on delete set null,
  is_correct boolean, points_earned numeric default 0, answered_at timestamptz not null default now(),
  unique(attempt_id, question_id));

create index on profiles(role);
create index on anatomy_structures(system_id);
create index on anatomy_structures(parent_id);
create index on anatomy_structures(model_object_id);
create index on quizzes(system_id);
create index on questions(quiz_id);
create index on question_options(question_id);
create index on assessment_attempts(user_id);
create index on assessment_attempts(quiz_id);
create index on attempt_answers(attempt_id);
create index on attempt_answers(question_id);

-- Every signup becomes STUDENT; role is never read from client metadata.
create function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles(id, name, role)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''), split_part(new.email,'@',1)), 'STUDENT');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();
