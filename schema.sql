create table players (
  id serial primary key,
  name text not null unique,
  grade int not null
);

create table subscriptions (
  id serial primary key,
  player_id int references players(id) on delete cascade,
  phone text not null,
  consented_at timestamptz not null default now(),
  unique (player_id, phone)
);

create table courts (
  number int primary key,
  status text not null default 'open',
  est text,
  assigned_at timestamptz
);

create table court_players (
  court_number int references courts(number) on delete cascade,
  player_id int references players(id) on delete cascade,
  primary key (court_number, player_id)
);

create table notifications (
  id serial primary key,
  player_id int references players(id),
  court_number int,
  type text not null,
  message text not null,
  sent_at timestamptz not null default now()
);

insert into courts (number, status)
select generate_series(1, 12), 'open';
