# Agent instructions

## Production database (D1)

Production runs on Cloudflare's free plan, which allows 5,000,000 D1 rows read per day for the whole account. Once that
is used up, every read fails until midnight UTC: the dashboard stops loading and new visits are lost, because recording
a visit starts with a read.

The app needs about 1% of that (20,000 to 65,000 rows a day). On 2026-11-10, 11 hand-written analysis queries read 11.7
million rows in about an hour and blocked production for the rest of the day.

- **Never run analysis queries against production.** Funnels, cohorts, joins between `events` and `sessions`, and
  anything else that scans a time range all belong on a local copy:

  ```bash
  npx wrangler d1 export minilytics --remote --output /tmp/minilytics.sql   # one full read, about 7 MB today
  sqlite3 /tmp/minilytics.db < /tmp/minilytics.sql
  sqlite3 /tmp/minilytics.db "SELECT ..."
  ```

- `wrangler d1 execute minilytics --remote` is fine for single-row lookups and the migrations CI already runs.
- Check usage with `npx wrangler d1 info minilytics` (`rows_read_24h`) and see which queries read the most rows with
  `npx wrangler d1 insights minilytics --timePeriod 1d --sort-type sum --sort-by reads`.
- A new dashboard query must use an index (`EXPLAIN QUERY PLAN`). A full scan of `events` grows with every visit.

## Questions about the data: use the reports, not the database

The worker has a read-only API and an MCP endpoint for exactly this (see "Read access for AI agents and scripts" in the
README). `portfolio` and `site_summary` are answered from daily totals and cost a few rows whatever the range.
`breakdown` and `payments` read raw visits and are limited to 92 days per call. Ask the user for a read token (Workspace
page) rather than querying D1 for analysis.

## Writing queries

- A lookup by visitor on `sessions` must say `INDEXED BY sessions_visitor`. Left to itself SQLite picks the
  `(site_id, started_at)` index and reads every visit of the site; the visitor profile and the Journey list did that
  until 2026-11-22. Events of one visitor are read through their sessions (`events_session`), since `events` has no
  index on `visitor_id`.
- A query across sites needs `site_id IN (...)`, or it reads the whole table.
- Totals for whole days come from `daily_stats` through `loadDays()` and `totals()` in `src/worker/rollups.ts`. Do not
  add a new scan of `sessions` for something those rows already answer.
- Free-plan limits also apply per request: about 50 D1 queries and 10 ms of CPU. The hourly job is sized for about 20
  sites.

## Changing the schema or the tracker

- Migrations only add tables and nullable columns, so the previous worker version still runs after a rollback. Rehearse
  on an export of production (commands above) before merging: merging deploys.
- `public/js/script.js` is loaded by every tracked site within an hour of a deploy. Keep it plain ES5-style, wrap new
  browser APIs in try/catch, and test it in a real browser, not only through the API.
- Events are never dropped on a guess. Visits from cloud networks are marked (`sessions.cloud`), not discarded, because
  a site's own proxy also arrives from a cloud.

