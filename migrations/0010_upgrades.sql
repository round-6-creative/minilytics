-- Everything here only adds tables and nullable columns, so the previous worker version keeps working
-- against this schema (a rollback of the code never needs a rollback of the data).

-- Traffic totals per site and day (the site's own days). `day` is the day number: days since 1970-01-01 in
-- the site's timezone. `gaps` counts that day's visitors by how many days ago they last visited
-- ({"-1": never before, "1": yesterday, "9": nine days ago}), which is what makes unique visitors over
-- any range of days an exact sum instead of a re-read of every visit.
CREATE TABLE daily_stats (
  site_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  visitors INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  duration INTEGER NOT NULL DEFAULT 0,
  gaps TEXT NOT NULL DEFAULT '{}',
  final INTEGER NOT NULL DEFAULT 0, -- 1 once the day is over and will not change
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, day)
);

-- Scroll depth and page speed per page and day. One row per page per day, however many visits it gets.
CREATE TABLE page_metrics (
  site_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  path TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,          -- page exits measured
  scroll_sum INTEGER NOT NULL DEFAULT 0, -- sum of the deepest scroll position, 0-100
  s50 INTEGER NOT NULL DEFAULT 0,        -- exits that reached half the page
  s100 INTEGER NOT NULL DEFAULT 0,       -- exits that reached the end
  lcp_n INTEGER NOT NULL DEFAULT 0,
  lcp_sum INTEGER NOT NULL DEFAULT 0,    -- ms
  lcp_good INTEGER NOT NULL DEFAULT 0,   -- <= 2.5 s
  lcp_poor INTEGER NOT NULL DEFAULT 0,   -- > 4 s
  inp_n INTEGER NOT NULL DEFAULT 0,
  inp_sum INTEGER NOT NULL DEFAULT 0,    -- ms
  inp_good INTEGER NOT NULL DEFAULT 0,   -- <= 200 ms
  inp_poor INTEGER NOT NULL DEFAULT 0,   -- > 500 ms
  cls_n INTEGER NOT NULL DEFAULT 0,
  cls_sum INTEGER NOT NULL DEFAULT 0,    -- layout shift x 1000
  cls_good INTEGER NOT NULL DEFAULT 0,   -- <= 0.1
  cls_poor INTEGER NOT NULL DEFAULT 0,   -- > 0.25
  PRIMARY KEY (site_id, day, path)
);

-- JavaScript errors and "page not found" hits, one row per distinct error or missing path.
CREATE TABLE issues (
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- 'error' or '404'
  key TEXT NOT NULL,  -- the error message, or the missing path
  detail TEXT,        -- file:line:column, or the page that linked to the missing path
  count INTEGER NOT NULL DEFAULT 0,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  last_path TEXT,
  last_browser TEXT,
  PRIMARY KEY (site_id, kind, key)
);

-- Forms: how many visitors started typing and how many submitted.
CREATE TABLE form_stats (
  site_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  form TEXT NOT NULL,
  starts INTEGER NOT NULL DEFAULT 0,
  submits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, form)
);

-- Visits that came straight from a cloud provider's network (servers, not people's connections), per day
-- and network. They are counted and marked (sessions.cloud), not dropped.
CREATE TABLE cloud_visits (
  site_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  network TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, network)
);

-- Last result of each payment provider's webhook, for the tracking health check.
CREATE TABLE webhook_status (
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  last_ok_at INTEGER,
  last_fail_at INTEGER,
  last_error TEXT,
  ok_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0, -- failures since the last success
  PRIMARY KEY (site_id, provider)
);

-- Things the scheduled checks noticed: a site that stopped sending events, a failing webhook, a traffic
-- spike, the weekly summary. `key` identifies the condition so it is raised once and closed when it ends.
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  ts INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  resolved_at INTEGER,
  dismissed_at INTEGER
);
CREATE INDEX alerts_key ON alerts (key, resolved_at);
CREATE INDEX alerts_ts ON alerts (ts);

-- Workspace settings (where notifications go, when scheduled jobs last ran).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Read-only tokens for the stats API and the MCP server. Only the hash is stored.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL, -- last characters, to tell tokens apart
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  calls_day INTEGER, -- UTC day number of `calls`
  calls INTEGER NOT NULL DEFAULT 0
);

-- Links that show one site's dashboard, read-only and without visitor names, to anyone who has the link.
CREATE TABLE share_links (
  token TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX share_links_site ON share_links (site_id);

-- Notes on the chart ("launched on Product Hunt").
CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  day TEXT NOT NULL, -- YYYY-MM-DD in the site's timezone
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX annotations_site ON annotations (site_id, day);

-- A saved period and set of filters.
CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  query TEXT NOT NULL, -- the dashboard's query string
  created_at INTEGER NOT NULL
);
CREATE INDEX saved_views_site ON saved_views (site_id);

-- Results of the few reports that have to read raw visits (retention), kept for a few hours.
CREATE TABLE stat_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Exchange rates against the US dollar, refreshed daily, to convert payments made in another currency.
CREATE TABLE fx_rates (
  currency TEXT PRIMARY KEY,
  per_usd REAL NOT NULL,
  day TEXT NOT NULL
);

-- An ad click id on the landing URL (gclid, msclkid, ttclid, twclid, fbclid): which one it was.
ALTER TABLE sessions ADD COLUMN click_id TEXT;
-- Name of the cloud provider when the visit came straight from its network ("Amazon AWS"), else NULL.
ALTER TABLE sessions ADD COLUMN cloud TEXT;

-- First touch: the visitor's first ever visit, next to session_id (last visit that came from somewhere).
ALTER TABLE payments ADD COLUMN first_session_id TEXT;
-- Length of the billing period a subscription payment covers, in days (30 = monthly, 365 = yearly).
ALTER TABLE payments ADD COLUMN period_days INTEGER;
-- What was actually charged, when it was converted to the site's currency.
ALTER TABLE payments ADD COLUMN orig_amount INTEGER;
ALTER TABLE payments ADD COLUMN orig_currency TEXT;

-- Billing periods are looked up by subscription.
CREATE INDEX payments_subscription ON payments (site_id, subscription_id);

-- The index is named so each payment reads only its own visitor's visits, not the whole site's.
UPDATE payments SET first_session_id = (
  SELECT s.id FROM sessions s INDEXED BY sessions_visitor
  WHERE s.site_id = payments.site_id AND s.visitor_id = payments.visitor_id AND s.started_at <= payments.ts + 60000
  ORDER BY s.started_at ASC LIMIT 1
) WHERE visitor_id IS NOT NULL;
