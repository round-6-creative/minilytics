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
