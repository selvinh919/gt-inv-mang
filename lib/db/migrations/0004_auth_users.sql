create table if not exists auth_users (
  id bigint generated always as identity primary key,
  email text not null,
  name text not null,
  password_hash text not null,
  role text not null default 'clerk',
  active boolean not null default true,
  external_sub text,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

create unique index if not exists auth_users_email_uidx on auth_users (email);
create index if not exists auth_users_role_idx on auth_users (role);
create index if not exists auth_users_active_idx on auth_users (active);
