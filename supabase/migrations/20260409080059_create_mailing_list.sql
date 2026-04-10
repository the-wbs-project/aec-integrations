create table mailing_list (
  id bigint generated always as identity primary key,
  email text not null unique,
  country text,
  city text,
  region text,
  timezone text,
  as_organization text,
  asn integer,
  metro_code integer,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  referrer text,
  created_at timestamptz not null default now()
);

-- RLS: allow anonymous inserts only, no reads
alter table mailing_list enable row level security;

create policy "Allow anonymous inserts"
  on mailing_list for insert
  with check (true);
