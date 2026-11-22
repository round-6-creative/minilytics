// Page quality signals the tracker sends besides pageviews: scroll depth and page speed, JavaScript
// errors, "page not found" hits and form starts/submits. Each is kept as a counter row (per page and day,
// per error, per form and day), so these tables grow with the site's content, not with its traffic.
import type { Site } from './env';
import { dayNumber } from './lib/time';

/**
 * Networks that host servers, not people. A visit that arrives straight from one of them (no proxy in
 * between) is most likely a script or a headless browser, whatever its user agent says. It can also be a
 * person on a cloud desktop or a self-hosted VPN, so such visits are marked and counted, never dropped.
 */
const DATACENTER_ASNS = new Map<number, string>([
  [16509, 'Amazon AWS'],
  [14618, 'Amazon AWS'],
  [396982, 'Google Cloud'],
  [8075, 'Microsoft Azure'],
  [14061, 'DigitalOcean'],
  [24940, 'Hetzner'],
  [16276, 'OVH'],
  [63949, 'Akamai Linode'],
  [20473, 'Vultr'],
  [45102, 'Alibaba Cloud'],
  [37963, 'Alibaba Cloud'],
  [132203, 'Tencent Cloud'],
  [45090, 'Tencent Cloud'],
  [31898, 'Oracle Cloud'],
  [12876, 'Scaleway'],
  [51167, 'Contabo'],
]);

/**
 * The cloud network a request came straight from, or null.
 * A request that passed through a proxy (the site's own domain forwarding to Minilytics) arrives from the
 * proxy's network, which is usually a cloud, so those are never judged by it. A proxy shows as Vercel's
 * visitor headers, or as an X-Forwarded-For address that is not the connecting one (the visitor's own).
 */
export function datacenterOf(asn: unknown, headers: { get(name: string): string | null | undefined }): string | null {
  const n = Number(asn);
  if (!Number.isInteger(n)) return null;
  const name = DATACENTER_ASNS.get(n);
  if (!name) return null;
  if (headers.get('x-vercel-ip-country')) return null;
  const connecting = (headers.get('cf-connecting-ip') ?? '').trim();
  const forwarded = (headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (forwarded.some((ip) => ip !== connecting)) return null;
  return name;
}

/** Count one visit from a cloud network (once per visit, when it starts). */
export function countCloudVisit(db: D1Database, site: Site, network: string, now: number) {
  return db
    .prepare(
      `INSERT INTO cloud_visits (site_id, day, network, count) VALUES (?, ?, ?, 1)
       ON CONFLICT (site_id, day, network) DO UPDATE SET count = count + 1`,
    )
    .bind(site.id, dayNumber(now, site.timezone), network.slice(0, 60));
}

const int = (v: unknown, max: number): number | null => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
};

export interface ExitMetrics {
  /** Deepest scroll position, 0-100. */
  sd?: unknown;
  /** Largest contentful paint, ms. */
  lcp?: unknown;
  /** Interaction to next paint, ms. */
  inp?: unknown;
  /** Cumulative layout shift x 1000. */
  cls?: unknown;
}

export const hasExitMetrics = (m: ExitMetrics) => m.sd !== undefined || m.lcp !== undefined || m.inp !== undefined || m.cls !== undefined;

/** One page exit: add its scroll depth and speed to the page's row for the day. */
export function recordExit(db: D1Database, site: Site, path: string, m: ExitMetrics, now: number): D1PreparedStatement | null {
  const sd = int(m.sd, 100);
  const lcp = int(m.lcp, 120_000);
  const inp = int(m.inp, 60_000);
  const cls = int(m.cls, 100_000);
  if (sd === null && lcp === null && inp === null && cls === null) return null;
  const b = (c: boolean) => (c ? 1 : 0);
  const v = {
    n: b(sd !== null),
    scroll: sd ?? 0,
    s50: b(sd !== null && sd >= 50),
    s100: b(sd !== null && sd >= 95),
    lcp_n: b(lcp !== null),
    lcp: lcp ?? 0,
    lcp_good: b(lcp !== null && lcp <= 2500),
    lcp_poor: b(lcp !== null && lcp > 4000),
    inp_n: b(inp !== null),
    inp: inp ?? 0,
    inp_good: b(inp !== null && inp <= 200),
    inp_poor: b(inp !== null && inp > 500),
    cls_n: b(cls !== null),
    cls: cls ?? 0,
    cls_good: b(cls !== null && cls <= 100),
    cls_poor: b(cls !== null && cls > 250),
  };
  return db
    .prepare(
      `INSERT INTO page_metrics (site_id, day, path, n, scroll_sum, s50, s100, lcp_n, lcp_sum, lcp_good, lcp_poor,
         inp_n, inp_sum, inp_good, inp_poor, cls_n, cls_sum, cls_good, cls_poor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (site_id, day, path) DO UPDATE SET
         n = n + excluded.n, scroll_sum = scroll_sum + excluded.scroll_sum, s50 = s50 + excluded.s50, s100 = s100 + excluded.s100,
         lcp_n = lcp_n + excluded.lcp_n, lcp_sum = lcp_sum + excluded.lcp_sum, lcp_good = lcp_good + excluded.lcp_good, lcp_poor = lcp_poor + excluded.lcp_poor,
         inp_n = inp_n + excluded.inp_n, inp_sum = inp_sum + excluded.inp_sum, inp_good = inp_good + excluded.inp_good, inp_poor = inp_poor + excluded.inp_poor,
         cls_n = cls_n + excluded.cls_n, cls_sum = cls_sum + excluded.cls_sum, cls_good = cls_good + excluded.cls_good, cls_poor = cls_poor + excluded.cls_poor`,
    )
    .bind(
      site.id, dayNumber(now, site.timezone), path,
      v.n, v.scroll, v.s50, v.s100, v.lcp_n, v.lcp, v.lcp_good, v.lcp_poor,
      v.inp_n, v.inp, v.inp_good, v.inp_poor, v.cls_n, v.cls, v.cls_good, v.cls_poor,
    );
}

/**
 * A JavaScript error or a missing page. The first occurrence creates the row; later ones only count.
 * The table is kept bounded by the daily job (see trimIssues), not here: a count on every insert would
 * cost hundreds of rows read per error.
 */
export function recordIssue(db: D1Database, site: Site, kind: 'error' | '404', key: string, detail: string | null, path: string, browser: string, now: number) {
  return db
    .prepare(
      `INSERT INTO issues (site_id, kind, key, detail, count, first_ts, last_ts, last_path, last_browser) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT (site_id, kind, key) DO UPDATE SET count = count + 1, last_ts = excluded.last_ts, last_path = excluded.last_path,
         last_browser = excluded.last_browser, detail = COALESCE(excluded.detail, detail)`,
    )
    .bind(site.id, kind, key.slice(0, 300), detail?.slice(0, 300) ?? null, now, now, path, browser);
}

/** Distinct errors and missing pages kept per site. */
export const MAX_ISSUES = 500;

/** Daily: drop what nobody has hit for a month, and anything beyond the newest MAX_ISSUES per site. */
export function trimIssues(db: D1Database, now: number): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM issues WHERE last_ts < ?').bind(now - 30 * 86_400_000),
    db.prepare(
      `DELETE FROM issues WHERE rowid IN (
         SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY site_id ORDER BY last_ts DESC) AS rn FROM issues) WHERE rn > ${MAX_ISSUES})`,
    ),
  ];
}

export function recordForm(db: D1Database, site: Site, form: string, action: 'start' | 'submit', now: number) {
  const [starts, submits] = action === 'start' ? [1, 0] : [0, 1];
  return db
    .prepare(
      `INSERT INTO form_stats (site_id, day, form, starts, submits) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (site_id, day, form) DO UPDATE SET starts = starts + excluded.starts, submits = submits + excluded.submits`,
    )
    .bind(site.id, dayNumber(now, site.timezone), form.slice(0, 100), starts, submits);
}

// ---------- reports

interface DayRange {
  from: number;
  to: number;
}

/** Day numbers covered by a time range in the site's timezone. */
export function dayRange(site: Site, range: { from: number; to: number }): DayRange {
  return { from: dayNumber(range.from, site.timezone), to: dayNumber(Math.max(range.from, range.to - 1), site.timezone) };
}

export async function pageQuality(db: D1Database, site: Site, range: { from: number; to: number }, limit = 100) {
  const d = dayRange(site, range);
  const res = await db
    .prepare(
      `SELECT path, SUM(n) AS exits, SUM(scroll_sum) AS scroll_sum, SUM(s50) AS s50, SUM(s100) AS s100,
              SUM(lcp_n) AS lcp_n, SUM(lcp_sum) AS lcp_sum, SUM(lcp_good) AS lcp_good, SUM(lcp_poor) AS lcp_poor,
              SUM(inp_n) AS inp_n, SUM(inp_sum) AS inp_sum, SUM(inp_good) AS inp_good, SUM(inp_poor) AS inp_poor,
              SUM(cls_n) AS cls_n, SUM(cls_sum) AS cls_sum, SUM(cls_good) AS cls_good, SUM(cls_poor) AS cls_poor
       FROM page_metrics WHERE site_id = ? AND day >= ? AND day <= ?
       GROUP BY path ORDER BY SUM(n) + SUM(lcp_n) DESC LIMIT ?`,
    )
    .bind(site.id, d.from, d.to, Math.max(1, Math.min(500, limit)))
    .all<Record<string, number> & { path: string }>();
  const avg = (sum: number, n: number) => (n ? sum / n : null);
  const share = (part: number, n: number) => (n ? part / n : null);
  return res.results.map((r) => ({
    path: r.path,
    exits: r.exits,
    scroll: avg(r.scroll_sum, r.exits),
    reachedHalf: share(r.s50, r.exits),
    reachedEnd: share(r.s100, r.exits),
    lcp: avg(r.lcp_sum, r.lcp_n),
    lcpGood: share(r.lcp_good, r.lcp_n),
    lcpPoor: share(r.lcp_poor, r.lcp_n),
    lcpSamples: r.lcp_n,
    inp: avg(r.inp_sum, r.inp_n),
    inpGood: share(r.inp_good, r.inp_n),
    inpPoor: share(r.inp_poor, r.inp_n),
    cls: r.cls_n ? r.cls_sum / r.cls_n / 1000 : null,
    clsGood: share(r.cls_good, r.cls_n),
    clsPoor: share(r.cls_poor, r.cls_n),
  }));
}

export async function listIssues(db: D1Database, site: Site) {
  const res = await db
    .prepare('SELECT kind, key, detail, count, first_ts, last_ts, last_path, last_browser FROM issues WHERE site_id = ? ORDER BY last_ts DESC LIMIT 200')
    .bind(site.id)
    .all();
  return res.results;
}

export function dismissIssue(db: D1Database, site: Site, kind: string | null, key: string | null) {
  if (kind && key !== null) return db.prepare('DELETE FROM issues WHERE site_id = ? AND kind = ? AND key = ?').bind(site.id, kind, key).run();
  if (kind) return db.prepare('DELETE FROM issues WHERE site_id = ? AND kind = ?').bind(site.id, kind).run();
  return db.prepare('DELETE FROM issues WHERE site_id = ?').bind(site.id).run();
}

export async function formStats(db: D1Database, site: Site, range: { from: number; to: number }) {
  const d = dayRange(site, range);
  const res = await db
    .prepare(
      `SELECT form, SUM(starts) AS starts, SUM(submits) AS submits FROM form_stats
       WHERE site_id = ? AND day >= ? AND day <= ? GROUP BY form ORDER BY SUM(starts) + SUM(submits) DESC LIMIT 100`,
    )
    .bind(site.id, d.from, d.to)
    .all<{ form: string; starts: number; submits: number }>();
  return res.results;
}
