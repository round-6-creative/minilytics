import type { Site } from './env';
import { dayNumber, dayStart, tzOffset } from './lib/time';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Today's row is recomputed when it is older than this. */
const TODAY_TTL_MS = 5 * 60_000;
/** A day is final this long after it ended (a visit that started before midnight can still be adding pages). */
const FINAL_AFTER_MS = 2 * HOUR;

export interface DayRow {
  site_id: string;
  day: number;
  visitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  duration: number;
  /** Visitors by days since their previous visit; "-1" = first visit ever. */
  gaps: Record<string, number>;
  final: number;
  computed_at: number;
}

export interface Totals {
  visitors: number;
  newVisitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  duration: number;
}

/**
 * Totals for days `from`..`to` (inclusive). Unique visitors are exact: a visitor seen on several days is
 * counted on the first of them only, which is the day their previous visit falls before `from`.
 */
export function totals(rows: DayRow[], from: number, to: number): Totals {
  const t: Totals = { visitors: 0, newVisitors: 0, sessions: 0, pageviews: 0, bounces: 0, duration: 0 };
  for (const r of rows) {
    if (r.day < from || r.day > to) continue;
    t.sessions += r.sessions;
    t.pageviews += r.pageviews;
    t.bounces += r.bounces;
    t.duration += r.duration;
    for (const [gap, n] of Object.entries(r.gaps)) {
      const g = Number(gap);
      if (g === -1) {
        t.visitors += n;
        t.newVisitors += n;
      } else if (g > r.day - from) t.visitors += n;
    }
  }
  return t;
}

type SiteRef = Pick<Site, 'id' | 'timezone' | 'created_at'>;

function parseRow(r: Record<string, unknown>): DayRow {
  let gaps: Record<string, number> = {};
  try {
    gaps = JSON.parse(String(r.gaps ?? '{}'));
  } catch {}
  return {
    site_id: String(r.site_id),
    day: Number(r.day),
    visitors: Number(r.visitors),
    sessions: Number(r.sessions),
    pageviews: Number(r.pageviews),
    bounces: Number(r.bounces),
    duration: Number(r.duration),
    gaps,
    final: Number(r.final),
    computed_at: Number(r.computed_at),
  };
}

/** Consecutive days that share one UTC offset, so one SQL expression can name the day of every visit in them. */
function offsetRuns(tz: string, from: number, to: number): { from: number; to: number; off: number }[] {
  const runs: { from: number; to: number; off: number }[] = [];
  for (let d = from; d <= to; d++) {
    const off = offsetOn(tz, d);
    const last = runs[runs.length - 1];
    if (last && last.off === off) last.to = d;
    else runs.push({ from: d, to: d, off });
  }
  return runs;
}

const offsetOn = (tz: string, day: number) => tzOffset(tz, dayStart(day, tz) + HOUR);

const stretches = new Map<string, { off: number; start: number; prevOff: number; startDay: number }>();

/**
 * Since when the timezone has had the offset `off` it has on `day`, and the offset before that. A visitor's
 * previous visit may predate the last clock change, and its day has to be named with the offset of its time.
 */
function offsetSince(tz: string, day: number, off: number): { start: number; prevOff: number } {
  const hit = stretches.get(tz);
  if (hit && hit.off === off && day >= hit.startDay) return hit;
  let same = day;
  while (day - same < 371 && offsetOn(tz, same - 7) === off) same -= 7;
  let out = { off, start: 0, prevOff: off, startDay: day - 371 };
  if (day - same < 371) {
    let first = same;
    while (same - first < 7 && offsetOn(tz, first - 1) === off) first--;
    out = { off, start: first * DAY - off, prevOff: offsetOn(tz, first - 1), startDay: first };
  }
  stretches.set(tz, out);
  return out;
}

// The previous-visit lookup names its index: left to itself SQLite walks every earlier visit of the site
// for each visitor, which turns a few thousand rows read into millions.
const COMPUTE_SQL = `
  SELECT day, gap, COUNT(*) AS visitors, SUM(sessions) AS sessions, SUM(pageviews) AS pageviews, SUM(bounces) AS bounces, SUM(duration) AS duration
  FROM (
    SELECT t.day,
      COALESCE(t.day - (SELECT CAST((MAX(s2.started_at) + CASE WHEN MAX(s2.started_at) >= ?5 THEN ?2 ELSE ?6 END) / 86400000 AS INTEGER)
                        FROM sessions s2 INDEXED BY sessions_visitor
                        WHERE s2.site_id = ?1 AND s2.visitor_id = t.visitor_id AND s2.started_at < t.day * 86400000 - ?2), -1) AS gap,
      t.sessions, t.pageviews, t.bounces, t.duration
    FROM (
      SELECT visitor_id, MIN(MAX(CAST((started_at + ?2) / 86400000 AS INTEGER), ?7), ?8) AS day, COUNT(*) AS sessions, SUM(pageviews) AS pageviews,
             SUM(CASE WHEN pageviews <= 1 AND goals = 0 THEN 1 ELSE 0 END) AS bounces, SUM(duration) AS duration
      FROM sessions WHERE site_id = ?1 AND started_at >= ?3 AND started_at < ?4
      GROUP BY visitor_id, day
    ) t
  ) GROUP BY day, gap`;

const WRITE_SQL = `
  INSERT OR REPLACE INTO daily_stats (site_id, day, visitors, sessions, pageviews, bounces, duration, gaps, final, computed_at)
  SELECT json_extract(value, '$.site_id'), json_extract(value, '$.day'), json_extract(value, '$.visitors'), json_extract(value, '$.sessions'),
         json_extract(value, '$.pageviews'), json_extract(value, '$.bounces'), json_extract(value, '$.duration'),
         json_extract(value, '$.gaps'), json_extract(value, '$.final'), json_extract(value, '$.computed_at')
  FROM json_each(?)`;

export interface LoadOptions {
  /** How far back one call will compute (default 800 days). Older missing days are reported as incomplete. */
  maxDays?: number;
  /** Leave today's unfinished row alone (the hourly job only needs finished days). */
  skipToday?: boolean;
  /** At most this many sites are computed per call; the rest wait for the next one. */
  maxSites?: number;
}

/**
 * Daily rows for each site from `since(site)` to today, computing the ones that are missing or stale.
 * One read per site that needs work (two when the range crosses a clock change) and one write for everything.
 */
export async function loadDays(
  db: D1Database,
  sites: SiteRef[],
  since: (site: SiteRef) => number,
  now = Date.now(),
  opts: LoadOptions = {},
): Promise<{ rows: Map<string, DayRow[]>; complete: boolean }> {
  const maxDays = opts.maxDays ?? 800;
  const out = new Map<string, DayRow[]>();
  if (!sites.length) return { rows: out, complete: true };

  const plan = sites.map((site) => {
    const today = dayNumber(now, site.timezone);
    const from = Math.max(since(site), dayNumber(site.created_at, site.timezone));
    return { site, today, from };
  });
  const minDay = Math.min(...plan.map((p) => p.from));
  const existing = await db
    .prepare(`SELECT * FROM daily_stats WHERE site_id IN (${sites.map(() => '?').join(',')}) AND day >= ?`)
    .bind(...sites.map((s) => s.id), minDay)
    .all<Record<string, unknown>>();
  const have = new Map<string, Map<number, DayRow>>();
  for (const raw of existing.results) {
    const r = parseRow(raw);
    if (!have.has(r.site_id)) have.set(r.site_id, new Map());
    have.get(r.site_id)!.set(r.day, r);
  }

  let complete = true;
  const stmts: D1PreparedStatement[] = [];
  const jobs: { site: SiteRef; from: number; to: number; today: number }[] = [];
  for (const { site, today, from } of plan) {
    const rows = have.get(site.id) ?? new Map<number, DayRow>();
    const last = opts.skipToday ? today - 1 : today;
    // Only the newest `maxDays` are ever computed; anything missing before that is reported, not retried forever.
    const start = Math.max(from, today - maxDays + 1);
    if (start > from) for (let d = from; d < start && complete; d++) if (!rows.has(d)) complete = false;
    let first: number | null = null;
    for (let d = start; d <= last; d++) {
      const r = rows.get(d);
      const stale = !r || (!r.final && (d < today || now - r.computed_at > TODAY_TTL_MS));
      if (stale) {
        first = d;
        break;
      }
    }
    if (first === null) continue;
    if (opts.maxSites !== undefined && new Set(jobs.map((j) => j.site.id)).size >= opts.maxSites) {
      complete = false;
      continue;
    }
    for (const run of offsetRuns(site.timezone, first, last)) {
      jobs.push({ site, from: run.from, to: run.to, today });
      const since = offsetSince(site.timezone, run.from, run.off);
      // The run's true edges: the day the clocks change is 23 or 25 hours long, and its odd hour belongs to it.
      stmts.push(
        db
          .prepare(COMPUTE_SQL)
          .bind(site.id, run.off, dayStart(run.from, site.timezone), dayStart(run.to + 1, site.timezone), since.start, since.prevOff, run.from, run.to),
      );
    }
  }

  if (stmts.length) {
    const results = await db.batch<{ day: number; gap: number; visitors: number; sessions: number; pageviews: number; bounces: number; duration: number }>(stmts);
    const fresh: DayRow[] = [];
    jobs.forEach((job, i) => {
      const byDay = new Map<number, DayRow>();
      for (let d = job.from; d <= job.to; d++) {
        byDay.set(d, {
          site_id: job.site.id,
          day: d,
          visitors: 0,
          sessions: 0,
          pageviews: 0,
          bounces: 0,
          duration: 0,
          gaps: {},
          final: now >= dayStart(d + 1, job.site.timezone) + FINAL_AFTER_MS ? 1 : 0,
          computed_at: now,
        });
      }
      for (const r of results[i].results) {
        const row = byDay.get(r.day);
        if (!row) continue;
        row.visitors += r.visitors;
        row.sessions += r.sessions;
        row.pageviews += r.pageviews;
        row.bounces += r.bounces;
        row.duration += r.duration;
        row.gaps[String(r.gap)] = r.visitors;
      }
      if (!have.has(job.site.id)) have.set(job.site.id, new Map());
      for (const row of byDay.values()) {
        have.get(job.site.id)!.set(row.day, row);
        fresh.push(row);
      }
    });
    for (let i = 0; i < fresh.length; i += 400) {
      await db.prepare(WRITE_SQL).bind(JSON.stringify(fresh.slice(i, i + 400))).run();
    }
  }

  for (const { site, from } of plan) {
    out.set(
      site.id,
      [...(have.get(site.id)?.values() ?? [])].filter((r) => r.day >= from).sort((a, b) => a.day - b.day),
    );
  }
  return { rows: out, complete };
}

/** The site's days change when its timezone does, so its rows have to be rebuilt. */
export function forgetDays(db: D1Database, siteId: string) {
  return db.prepare('DELETE FROM daily_stats WHERE site_id = ?').bind(siteId).run();
}
