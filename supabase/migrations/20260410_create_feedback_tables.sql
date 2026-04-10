create table feedback (
  id bigint generated always as identity primary key,
  features text,
  tools text,
  email text,
  subscribed boolean not null default false,
  country text,
  city text,
  region text,
  timezone text,
  referrer text,
  created_at timestamptz not null default now()
);

alter table feedback enable row level security;

create policy "Allow anonymous inserts"
  on feedback for insert
  with check (true);
