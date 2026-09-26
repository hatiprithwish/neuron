# Neuron — data model and approach (v2)

Consolidated from the full design discussion. Supersedes the earlier single-metric,
single-entity sketch. Target: Cloudflare D1 (SQLite) + Drizzle ORM.

---

## 0. Why Neuron exists

Neuron is a life companion for people who want to live intentionally and build a life
they absolutely love. The user is the main character of their own life, and Neuron is
where they see, track and improve every part of it. It aims to be the most important
companion they have, and ideally the only one they need. This is the core of the app,
and every section below serves it. Whatever solving that problem takes, we build, even
when that means revisiting a decision in this document.

What this asks of the architecture:

- **Every part of a life, one substrate.** Health, money, time, work, relationships and
  goals are all entries, metrics and entities. No domain is a silo, because the user's
  life isn't one. Cross-domain views are the point, not a bonus.
- **The user is in charge, never judged.** They define what matters (metrics,
  trackers, targets) and the app adapts to them. Missing data is neutral (invariant 7),
  and a lapse is never a failure state.
- **Showing up must be effortless.** Logging friction is the main reason people stop,
  and a companion that is abandoned helps nobody.
- **This is their life story.** The data is as intimate as a diary, so it must be
  trustworthy: kept private, isolated per user, exportable and deletable.

---

## 1. The design in one paragraph

Everything a user records is an **entry** — an event in time. An entry carries one or
more **values**, each tied to a globally-declared **metric** that knows its own type,
unit and aggregation. An entry links to zero or more **entities** (projects,
people, places) through a role-scoped join. A **tracker** is a saved configuration that
decides what UI to render and which metrics to write — it is a row, not a deploy.
Everything aggregatable joins on `(user_id, local_date)`. Aggregate tables are derived
caches, never truth.

---

## 2. Invariants

These belong in `CLAUDE.md` verbatim. Every one of them exists because breaking it
loses information that cannot be reconstructed.

1. **`entries` + `entry_values` are the only source of truth.** Any aggregate table is
   derived, rebuildable from scratch, and never written by a user action.
2. **Store canonical units only.** `ml`, not `L`. `seconds`, not `minutes`. Display
   units are a presentation concern.
3. **Money stores the currency code and the FX rate at entry time.** Historical rates
   are not recoverable later.
4. **`local_date` is computed at write time from the user's timezone, and `tz` is
   stored alongside it.** Without the stored timezone you cannot recompute dates after
   the user travels.
   `users.tz` decides which calendar day a row belongs to: `TrackersRepo` resolves today with
   `DateTime.localDateIn(users.tz)`, writes `entries.tz` as that zone, and the web app derives
   "today" from the same `users.tz` (`utils/timeZone.ts`). Entries written before this landed
   were keyed by UTC day; `POST /trackers/rekey-days` (Settings → "Realign past entries")
   moves the write-time-keyed ones and rebuilds their `daily_facts`.
5. **Components never reference a colour primitive.** Only semantic tokens and the
   categorical `--chart-N` scale. Lint-enforced.
6. **Aggregation over entities always filters by exactly one `role`.** Grouping across
   mixed roles double-counts.
7. **Missing data is neutral.** A gap is not a win and not a failure. Never coalesce
   absent days to zero.
8. **Streaks count through yesterday; today extends when logged.** Applied identically
   in every surface.
9. **Soft deletes only.** No hard deletes, ever.
10. **All DB access goes through a repository layer.** No Drizzle calls in route
    handlers or components.
11. **Integer `id` never leaves the server.** It is the internal join key only. If an
    integer ID appears in an API response, a URL, a log line, or a sync payload, the
    pattern has already failed — use `public_id`.
12. **`public_id` is the sync identity.** Clients generate it offline; the server
    resolves it to an integer on ingest. Any future cross-user feature keys on it.
13. **No database-level foreign key constraints.** Referential integrity is the
    repository layer's job. See §4.1 — this is a deliberate trade, not an oversight.

---

## 3. Enums

```
semantic_type    duration_seconds | count | currency_minor | mass_grams |
                 volume_ml | energy_kcal | distance_m | rating_1_5 |
                 boolean | text | json

default_agg      sum | avg | max | min
                 -- what one day of the quantity means when a day holds several
                 --   readings. Reps add up; three weigh-ins are not three times a
                 --   body weight. Stays on the metric — every tracker writing it must
                 --   agree, or their numbers cannot roll into one.
                 -- all four roll up from the day grain, which is why week/month/year
                 --   need no second cache: sum/min/max compose directly, avg is
                 --   recomputed as SUM(sum)/SUM(count) rather than averaged again.
                 -- no `last`: daily_facts holds sum/count/min/max/avg and nothing that
                 --   could answer it. The daily_total control covers the case — it
                 --   replaces the day, so the day's sum is its last value.

direction        higher_better | lower_better | neutral
                 -- lives on the tracker's manifest: it is a judgement about a habit,
                 --   not a property of the quantity. One `minutes` metric is
                 --   higher_better under a meditation tracker and lower_better under a
                 --   doomscrolling one, and both still roll up together.
                 -- neutral: recorded, never scored. No day is a win or a miss and no
                 --   streak runs — a transfer between your own accounts, hours logged
                 --   against a project. Distinct from "no target": it also tells a
                 --   rollup not to colour a change as progress or regression.
                 -- metrics.default_direction is what a new tracker inherits, and what
                 --   a cross-tracker rollup reads (no single manifest to ask there).

date_attribution start | end | split
                 -- start: meals, expenses, most events
                 -- end:   sleep (attributed to the wake day)
                 -- split: work sessions crossing midnight, apportioned

entry_kind       point | interval

entity_kind      person | goal | account

entry_role       person | account
                 -- one entity per role per entry (unique constraint)

control          toggle | stepper | increment | timer | daily_total |
                 amount_pad | form
```

---

## 4. Identity strategy

Two IDs per addressable table.

```sql
id         integer primary key,      -- internal join key, server-assigned
public_id  text not null unique,     -- prefixed nanoid, external identity
```

`integer primary key` in SQLite _is_ the rowid — the table is physically stored in that
order, so joins are a B-tree seek with no indirection. There is no `BIGSERIAL` in D1;
this is the equivalent. Do **not** add `AUTOINCREMENT`: it writes to `sqlite_sequence`
on every insert and only guarantees IDs of deleted rows are never reused — and under
invariant 9 nothing is ever deleted.

### Which tables get a `public_id`

A table gets one **if and only if** one of its rows can appear in a URL or be
referenced by an external client.

| Gets `public_id`                                      | No `public_id`                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `users`, `entities`, `metrics`, `trackers`, `entries` | `entry_values`, `entry_entities`, `entity_attrs`, `daily_facts` |

The right-hand tables have composite primary keys and no independent identity. Adding
a nanoid there costs 21 bytes plus a unique index per row for nothing.

### Prefixes

Stripe-style, four characters, non-negotiable:

```
usr_  entities: ent_   metrics: met_   trackers: trk_   entries: eny_
```

Costs four characters, and makes a whole class of bug impossible — passing a metric ID
where a tracker ID was expected fails loudly instead of silently returning nothing.

Keep nanoid's default 21-character length. Shortening to 8–10 for prettiness puts you
in real collision territory at volume. The `unique` constraint makes a collision a
failed insert rather than silent corruption.

### 4.1 Referential integrity without foreign keys

No table declares `references`. Relationship columns (`user_id`, `tracker_id`,
`metric_id`, `entity_id`, `parent_id`) exist and are indexed exactly as if they were
constrained — the constraint clause is simply absent.

**Why.** D1 enforces foreign keys by default (equivalent to `PRAGMA foreign_keys = on`
for every transaction), so this is a real opt-out, not a default. Three reasons it's
the right call here:

- Offline sync can push a child row before its parent in the same batch. With
  constraints on, that insert fails.
- Soft deletes make the constraint half-useless anyway: `deleted_at` means nothing to
  a foreign key, so it happily permits references to logically-deleted rows.
- SQLite cannot alter a constrained column in place; every migration becomes a table
  rebuild.

**What replaces it.**

1. **Repository layer validates on write.** Every create/update that sets a
   relationship column resolves the parent first — by `public_id` on the way in, to an
   integer on the way down. Nothing else may write these columns.
2. **Reads join defensively.** Use `inner join` where the parent is required, so an
   orphan disappears from results rather than rendering as a blank row. Never `left
join` a required parent.
3. **A weekly orphan scan**, run as a cron Worker, logging rather than deleting:

```sql
select 'entry_values' as tbl, count(*) from entry_values ev
  left join entries e on e.id = ev.entry_id where e.id is null
union all
select 'entry_entities', count(*) from entry_entities ee
  left join entries e on e.id = ee.entry_id where e.id is null
union all
select 'entries', count(*) from entries en
  left join trackers t on t.id = en.tracker_id where t.id is null;
```

Any non-zero result is a bug in the repository layer, not a data problem to patch.

4. **Cascade deletes are now manual.** Soft-deleting a tracker must also soft-delete
   its entries, their values, and their entity links — in one transaction, in the
   repository. There is no `ON DELETE CASCADE` to fall back on.

### Note on offline writes

An auto-increment integer is server-assigned, so an offline client cannot know its own
primary key. This is why `public_id` is the sync identity: clients generate it offline
and write against it. Foreign keys **in the database** store integers; foreign keys
**in any sync payload** store `public_id`.

The same rule covers per-user D1 databases — auto-increment is only unique within one
database, so `id = 1` exists in every shard. Harmless as long as integers never cross
a database boundary.

---

## 5. Schema

### users

Clerk is the auth provider; this table is the local identity all FKs point at.

```sql
create table users (
  id          integer primary key,
  public_id   text not null unique,      -- 'usr_...'
  clerk_id    text not null unique,
  tz          text not null default 'Asia/Kolkata',
  home_currency text not null default 'INR',
  created_at  integer not null,
  updated_at  integer not null,
  deleted_at  integer
);
```

### metrics

Declared globally, reused across trackers. This is what makes cross-domain
aggregation possible.

```sql
create table metrics (
  id                integer primary key,
  public_id         text not null unique,      -- 'met_...'
  user_id           integer not null,
  key               text not null,
  name              text not null,
  semantic_type     text not null,
  canonical_unit    text not null,
  default_agg       text not null default 'sum',
  default_direction text not null default 'higher_better',   -- inherited, not enforced
  date_attribution  text not null default 'start',
  created_at        integer not null,
  updated_at        integer not null,
  deleted_at        integer,
  unique (user_id, key)
);
```

### entities

Projects, people, places. Live outside trackers so the same entity can be referenced
from any number of them.

```sql
create table entities (
  id           integer primary key,
  public_id    text not null unique,           -- 'ent_...'
  user_id      integer not null,
  kind         text not null,
  name         text not null,
  emoji        text,
  color_index  integer,          -- index into the --chart-N categorical scale
  parent_id    integer,
  status       text,             -- active | paused | done
  started_on   text,             -- YYYY-MM-DD
  ended_on     text,
  sort_order   integer not null default 0,
  created_at   integer not null,
  updated_at   integer not null,
  archived_at  integer,
  deleted_at   integer
);

create table entity_attrs (
  entity_id    integer not null,
  key          text not null,
  value_num    real,
  value_text   text,
  primary key (entity_id, key)
);
```

### trackers

A saved configuration. Adding a tracker is a row insert, not a deploy.

```sql
create table trackers (
  id                 integer primary key,
  public_id          text not null unique,     -- 'trk_...'
  user_id            integer not null,
  name               text not null,
  emoji              text,
  color_index        integer,
  primary_metric_id  integer not null,
  manifest_json      text not null,
  manifest_version   integer not null default 1,
  sort_order         integer not null default 0,
  active_from        text not null,   -- YYYY-MM-DD; heatmaps render nothing before this
  active_to          text,            -- set when paused/retired
  created_at         integer not null,
  updated_at         integer not null,
  archived_at        integer,
  deleted_at         integer
);
```

**Manifest shape:**

```json
{
  "control": "timer",
  "metrics": ["run_duration"],
  "target": 1200,
  "step": null,
  "direction": "higher_better",
  "entry_mode": "live",
  "schedule": { "type": "daily" },
  "compute": null
}
```

`schedule.type` is one of `daily` | `days_of_week` (with `days: [1,3,5]`) |
`times_per_week` (with `count: 3`).

`direction` and `target` are one question — is that number a floor or a ceiling? — so
they live together. Sent as `null` it means "inherit `metrics.default_direction`", which
the repository resolves to a concrete value on write, so no read path ever needs a
metric lookup to score a day.

`compute` is the escape hatch: `"workout.v1"` resolves to a registered TypeScript
module for logic config can't express (1RM formulas, recurring transactions, grace-day
streak rules). Null for everything simple.

### entries

The event. Append-mostly. One row per thing that happened.

```sql
create table entries (
  id                 integer primary key,
  public_id          text not null unique,     -- 'eny_...'
  user_id            integer not null,
  tracker_id         integer not null,
  entry_kind         text not null default 'point',
  occurred_at        integer not null,      -- unix seconds, UTC instant
  ended_at           integer,               -- interval end; null+interval = open session
  local_date         text not null,         -- YYYY-MM-DD, resolved at write time
  tz                 text not null,         -- IANA, e.g. 'Asia/Kolkata'
  label              text,                  -- free-text description; drill-down groups on this
  note               text,
  source             text not null default 'manual',  -- manual | manual_retro | import | api
  transfer_group_id  text,                  -- links the two sides of an account transfer
  rev                integer not null default 0,      -- monotonic; sync ordering key
  created_at         integer not null,
  updated_at         integer not null,
  deleted_at         integer
);
```

### entry_values

One entry, many readings. A habit tap has one row here; a meal has four; a workout set
has two.

```sql
create table entry_values (
  entry_id    integer not null,
  metric_id   integer not null,
  value_num   real,
  value_text  text,
  value_json  text,
  currency    text,        -- ISO 4217, currency_minor only
  value_base  real,        -- converted to home currency
  fx_rate     real,        -- rate at entry time
  primary key (entry_id, metric_id)
);
```

### entry_entities

One entry, many entities — but one per role.

```sql
create table entry_entities (
  entry_id   integer not null,
  entity_id  integer not null,
  role       text not null,
  primary key (entry_id, role)
);
```

The primary key on `(entry_id, role)` is what guarantees a "slice by project" donut
sums to exactly 100%.

### daily_facts (derived — build when needed, not on day one)

```sql
create table daily_facts (
  user_id         integer not null,
  local_date      text not null,
  metric_id       integer not null,
  entity_id       integer,            -- null row = canonical un-attributed total
  sum             real not null,
  count           integer not null,
  min             real,
  max             real,
  avg             real,
  target_at_time  real,            -- snapshot; keeps history honest when goals change
  primary key (user_id, local_date, metric_id, entity_id)
);
```

Entity-scoped fact rows are **filtered, never summed across** — summing them
triple-counts any entry linked to three entities. The `entity_id IS NULL` row is the
canonical total.

All five aggregates are computed on every write, regardless of the metric's
`default_agg`; the metric decides which one is _read_, in one place
(`manifest/Aggregation.ts`). Day is the only stored grain — week, month and year are
rollups of these rows, not caches of their own.

### Indexes

```sql
create index idx_metrics_user        on metrics (user_id) where deleted_at is null;
create index idx_entries_user_date   on entries (user_id, local_date) where deleted_at is null;
create index idx_entries_tracker     on entries (tracker_id, local_date) where deleted_at is null;
create index idx_values_metric       on entry_values (metric_id, entry_id);
create index idx_entry_entities      on entry_entities (entity_id, role, entry_id);
create index idx_facts_lookup        on daily_facts (user_id, metric_id, local_date);
```

---

## 6. How each surface reads

**Today screen** — `trackers` left-joined to today's facts (or entries directly).
`manifest.control` picks the quick-add widget: toggle, stepper, increment, timer,
daily_total. One `TrackerRow` component, five child controls.

**Habit heatmap** — one indexed range scan of `daily_facts` for one metric over 365
days. Grid position is client-side arithmetic. Cells have four states: not scheduled,
scheduled-no-data, partial (`sum / target_at_time`), met. Nothing renders before
`trackers.active_from`.

**Streaks** — fetch the range, walk descending in TypeScript. Skip unscheduled days,
break on missing, compare using the manifest's `direction` and per-row `target_at_time`
(a `neutral` tracker scores every logged day as met — it has no better side). Compute on
read; only cache if you also invalidate on any retroactive write.

**Time-tracker breakdown** — queries `entries` directly, not `daily_facts`, because it
groups by `label` and needs `count(*)` of sessions. `role` is the "slice by"
parameter. Left-join so unassigned time gets an explicit bucket instead of vanishing.

**Cross-domain aggregation** — filter `daily_facts` (or `entry_entities`) by one
`entity_id`. Pushups and running roll into one "Fitness" number because they point at
the same entity row.

---

## 7. Build order

1. Schema + repository layer + tokens package. `user_id` everywhere, client UUIDs,
   soft deletes from row one.
2. Three hardcoded trackers — habits, money, time — as ordinary implementations
   against the shared substrate. No manifest engine yet.
3. Use it daily for a month.
4. Extract the manifest format from what those three demonstrably share. Rule of three.
5. Add `daily_facts` when a screen feels slow, not before. It's a backfill script, not
   a migration.
6. Hand-write cross-domain SQL for two months. Productise only the five or six queries
   you actually re-run.

Explicitly not in v1: social, paywall, onboarding, gamification, AI parsing, insight
engine, automatic ingestion.

---

## 8. Deferred, deliberately

| Item                                  | Why it can wait                                      |
| ------------------------------------- | ---------------------------------------------------- |
| Goals table                           | Genuinely separate concern, no coupling to entries   |
| Split allocation (weights per entity) | Needs a real use case; one-role-per-entry covers 95% |
| Local-first sync                      | `rev` + UUIDs + soft deletes keep the door open      |
| Weekly/monthly rollup tables          | 365 rows is a rounding error; don't pre-optimise     |
| Multi-user / sharing                  | `user_id` is already on every table                  |

---

## 9. Known limits — accept these knowingly

- **Text and JSON values get no fact rows.** Mood notes and journal entries won't
  appear in aggregate dashboards. This is correct, not a bug.
- **Automatic ingestion is unavailable.** HealthKit and Health Connect are on-device;
  iOS screen time can't leave the report extension; Play blocks SMS parsing for
  finance; India's AA framework requires regulated-entity status. v1 is manual entry
  plus user-initiated file import.
- **Correlation analysis is statistically dangerous.** 30 metrics is 435 pairwise
  tests. Any future insight feature needs minimum-observation thresholds, effect sizes
  over p-values, false-discovery correction, and hypothesis framing.
- **D1 is the likeliest forced migration.** 10 GB per database, single-threaded,
  billed on rows scanned. The repository layer is the insurance; per-user databases
  are the scale path.
