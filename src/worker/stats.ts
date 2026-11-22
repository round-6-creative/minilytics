import type { Context } from 'hono';
import type { AppEnv, Site } from './env';
import { bucketLabels, bucketSql, dayKey, dayNumber, dayStart, resolveRange, tzOffset, type Range } from './lib/time';
import { currencyDecimals } from './fx';
import { loadDays } from './rollups';

/** Filters that live on the session row (clicking a row in the dashboard adds one of these). */
const SESSION_FILTERS = [
  'channel',
  'source',
  'referrer_domain',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'country',
  'region',
  'city',
  'browser',
  'os',
  'device',
  'entry_page',
  'exit_page',
  'hostname',
  'cloud',
] as const;

export type Filters = Partial<Record<(typeof SESSION_FILTERS)[number] | 'page' | 'goal', string>>;

export function parseFilters(raw: string | undefined): Filters {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    const out: Filters = {};
    for (const k of [...SESSION_FILTERS, 'page', 'goal'] as const) {
      if (typeof obj[k] === 'string') out[k] = obj[k].slice(0, 500);
    }
    return out;
  } catch {
    return {};
  }
}

/** SQL + params restricting sessions `s` by the dashboard filters (not by time). */
function filterSql(f: Filters): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const k of SESSION_FILTERS) {
    const v = f[k];
    if (v === undefined) continue;
    if (v === '') parts.push(`s.${k} IS NULL`);
    else {
      parts.push(`s.${k} = ?`);
      params.push(v);
    }
  }
  if (f.page) {
    parts.push(`EXISTS (SELECT 1 FROM events fe WHERE fe.site_id = s.site_id AND fe.session_id = s.id AND fe.type = 'pageview' AND fe.path = ?)`);
    params.push(f.page);
  }
  if (f.goal) {
    parts.push(`EXISTS (SELECT 1 FROM events fe WHERE fe.site_id = s.site_id AND fe.session_id = s.id AND fe.type = 'goal' AND fe.name = ?)`);
    params.push(f.goal);
  }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

const hasFilters = (f: Filters) => Object.keys(f).length > 0;

export interface Ctx {
  db: D1Database;
  site: Site;
  range: Range;
  filters: Filters;
  offset: number;
  /** Which visit gets the credit for a payment: the last one that came from somewhere (default) or the very first. */
  attr: 'last' | 'first';
}

export function ctxFor(db: D1Database, site: Site, q: Record<string, string | undefined>, now = Date.now()): Ctx {
  const range = resolveRange(q, site.timezone, site.created_at, now);
  return { db, site, range, filters: parseFilters(q.filters), offset: tzOffset(site.timezone, range.to), attr: q.attr === 'first' ? 'first' : 'last' };
}

export function makeCtx(c: Context<AppEnv>): Ctx {
  return ctxFor(c.env.DB, c.get('site'), c.req.query());
}

/** The payments column holding the credited visit under the chosen model. */
const creditCol = (ctx: Ctx) => (ctx.attr === 'first' ? 'p.first_session_id' : 'p.session_id');

function sessionsWhere(ctx: Ctx, from = ctx.range.from, to = ctx.range.to) {
  const f = filterSql(ctx.filters);
  return {
    sql: `s.site_id = ? AND s.started_at >= ? AND s.started_at < ?${f.sql}`,
    params: [ctx.site.id, from, to, ...f.params],
  };
}

/** Payments in the period; with filters, only those credited to a matching visit. */
function paymentsFrom(ctx: Ctx, from = ctx.range.from, to = ctx.range.to) {
  if (!hasFilters(ctx.filters)) {
    return { sql: `payments p WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?`, params: [ctx.site.id, from, to] };
  }
  const f = filterSql(ctx.filters);
  return {
    sql: `payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = ${creditCol(ctx)}
          WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?${f.sql}`,
    params: [ctx.site.id, from, to, ...f.params],
  };
}

const KPI_SQL = (where: string) => `
  SELECT COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, COALESCE(SUM(s.pageviews), 0) AS pageviews,
         COALESCE(SUM(CASE WHEN s.pageviews <= 1 AND s.goals = 0 THEN 1 ELSE 0 END), 0) AS bounces,
         COALESCE(AVG(s.duration), 0) AS avg_duration
  FROM sessions s WHERE ${where}`;

const REVENUE_SQL = (from: string) => `
  SELECT COALESCE(SUM(p.amount), 0) AS revenue,
         COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN COALESCE(p.visitor_id, p.id) END) AS customers,
         COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END), 0) AS payments
  FROM ${from}`;

interface KpiRow {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  avg_duration: number;
}
interface RevRow {
  revenue: number;
  customers: number;
  payments: number;
}

function kpis(k: KpiRow, r: RevRow) {
  return {
    visitors: k.visitors,
    sessions: k.sessions,
    pageviews: k.pageviews,
    bounceRate: k.sessions ? k.bounces / k.sessions : 0,
    avgDuration: Math.round(k.avg_duration),
    revenue: r.revenue,
    payments: r.payments,
    customers: r.customers,
    conversionRate: k.visitors ? r.customers / k.visitors : 0,
    revenuePerVisitor: k.visitors ? r.revenue / k.visitors : 0,
  };
}

/** Top numbers + chart. */
export async function overview(ctx: Ctx) {
  const { db, range, site } = ctx;
  const prevFrom = range.from - (range.to - range.from);
  const cur = sessionsWhere(ctx);
  const prev = sessionsWhere(ctx, prevFrom, range.from);
  const curPay = paymentsFrom(ctx);
  const prevPay = paymentsFrom(ctx, prevFrom, range.from);
  const sb = bucketSql('s.started_at', range.granularity, ctx.offset);
  const pb = bucketSql('p.ts', range.granularity, ctx.offset);
  const now = Date.now();

  const [k1, k0, r1, r0, online, ts, tr] = await db.batch([
    db.prepare(KPI_SQL(cur.sql)).bind(...cur.params),
    db.prepare(KPI_SQL(prev.sql)).bind(...prev.params),
    db.prepare(REVENUE_SQL(curPay.sql)).bind(...curPay.params),
    db.prepare(REVENUE_SQL(prevPay.sql)).bind(...prevPay.params),
    db
      .prepare('SELECT COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE site_id = ? AND started_at > ? AND last_seen_at > ?')
      .bind(site.id, now - 6 * 3_600_000, now - 5 * 60_000),
    db
      .prepare(
        `SELECT ${sb} AS b, COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews
         FROM sessions s WHERE ${cur.sql} GROUP BY b`,
      )
      .bind(...cur.params),
    db
      .prepare(
        `SELECT ${pb} AS b, SUM(p.amount) AS revenue, SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END) AS payments
         FROM ${curPay.sql} GROUP BY b`,
      )
      .bind(...curPay.params),
  ]);

  const visitorsBy = new Map((ts.results as any[]).map((r) => [r.b, r]));
  const revenueBy = new Map((tr.results as any[]).map((r) => [r.b, r]));
  const labels = bucketLabels(range, ctx.offset);
  const series = labels.map((b) => ({
    bucket: b,
    visitors: visitorsBy.get(b)?.visitors ?? 0,
    pageviews: visitorsBy.get(b)?.pageviews ?? 0,
    revenue: revenueBy.get(b)?.revenue ?? 0,
    payments: revenueBy.get(b)?.payments ?? 0,
  }));

  return {
    range,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
    current: kpis(k1.results[0] as KpiRow, r1.results[0] as RevRow),
    previous: kpis(k0.results[0] as KpiRow, r0.results[0] as RevRow),
    online: (online.results[0] as { n: number }).n,
    series,
  };
}

/** Session dimensions, keyed by the name the dashboard asks for. */
const SESSION_DIMS: Record<string, string> = {
  channel: 's.channel',
  source: 's.source',
  campaign: 's.utm_campaign',
  keyword: 's.utm_term',
  utm_source: 's.utm_source',
  utm_medium: 's.utm_medium',
  utm_content: 's.utm_content',
  ref: 's.ref',
  country: 's.country',
  region: 's.region',
  city: 's.city',
  browser: 's.browser',
  os: 's.os',
  device: 's.device',
  entry_page: 's.entry_page',
  exit_page: 's.exit_page',
  hostname: 's.hostname',
  referrer: 's.referrer',
  cloud: 's.cloud',
};

export interface BreakdownRow {
  label: string | null;
  visitors: number;
  pageviews?: number;
  revenue: number;
  customers: number;
  icon?: string | null;
  extra?: string | null;
}

export async function breakdown(ctx: Ctx, dim: string, limit = 100): Promise<BreakdownRow[]> {
  const { db } = ctx;
  const lim = Math.max(1, Math.min(500, limit));

  if (SESSION_DIMS[dim]) {
    const col = SESSION_DIMS[dim];
    const w = sessionsWhere(ctx);
    const pay = paymentsFrom(ctx);
    // Payments need the session columns even without filters.
    const payJoin = hasFilters(ctx.filters)
      ? pay
      : {
          sql: `payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = ${creditCol(ctx)} WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?`,
          params: pay.params,
        };
    const extraCol =
      dim === 'source' ? 'MAX(s.referrer_domain)' : dim === 'region' || dim === 'city' ? 'MAX(s.country)' : 'NULL';
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT ${col} AS label, COUNT(DISTINCT s.visitor_id) AS visitors, SUM(s.pageviews) AS pageviews, ${extraCol} AS extra
           FROM sessions s WHERE ${w.sql} GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...w.params),
      db
        .prepare(
          `SELECT ${col} AS label, SUM(p.amount) AS revenue,
                  COUNT(DISTINCT CASE WHEN p.kind = 'payment' THEN COALESCE(p.visitor_id, p.id) END) AS customers
           FROM ${payJoin.sql} GROUP BY label`,
        )
        .bind(...payJoin.params),
    ]);
    return merge(v.results as any[], r.results as any[]);
  }

  if (dim === 'page') {
    const f = filterSql(ctx.filters);
    const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
    const params = [ctx.site.id, ctx.range.from, ctx.range.to, ...f.params];
    const base = `FROM events e ${join} WHERE e.site_id = ? AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ?${f.sql}`;
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT e.path AS label, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews ${base}
           GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...params),
      // Revenue from customers who viewed the page during the period.
      db
        .prepare(
          `SELECT pv.label, SUM(p.amount) AS revenue, COUNT(DISTINCT p.visitor_id) AS customers
           FROM (SELECT DISTINCT e.path AS label, e.visitor_id ${base}) pv
           JOIN payments p ON p.site_id = ? AND p.visitor_id = pv.visitor_id AND p.ts >= ? AND p.ts < ?
           GROUP BY pv.label`,
        )
        .bind(...params, ctx.site.id, ctx.range.from, ctx.range.to),
    ]);
    return merge(v.results as any[], r.results as any[]);
  }

  if (dim === 'exit_link' || dim === 'goal') {
    const type = dim === 'goal' ? 'goal' : 'outbound';
    const f = filterSql(ctx.filters);
    const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
    const params = [ctx.site.id, type, ctx.range.from, ctx.range.to, ...f.params];
    const base = `FROM events e ${join} WHERE e.site_id = ? AND e.type = ? AND e.ts >= ? AND e.ts < ?${f.sql}`;
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT e.name AS label, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews ${base}
           GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...params),
      db
        .prepare(
          `SELECT g.label, SUM(p.amount) AS revenue, COUNT(DISTINCT p.visitor_id) AS customers
           FROM (SELECT DISTINCT e.name AS label, e.visitor_id ${base}) g
           JOIN payments p ON p.site_id = ? AND p.visitor_id = g.visitor_id AND p.ts >= ? AND p.ts < ?
           GROUP BY g.label`,
        )
        .bind(...params, ctx.site.id, ctx.range.from, ctx.range.to),
    ]);
    return merge(v.results as any[], r.results as any[]);
  }

  throw new Error(`unknown dimension ${dim}`);
}

function merge(visits: any[], revenue: any[]): BreakdownRow[] {
  const rev = new Map(revenue.map((r) => [r.label, r]));
  const rows: BreakdownRow[] = visits.map((v) => ({
    label: v.label,
    visitors: v.visitors,
    pageviews: v.pageviews ?? undefined,
    revenue: rev.get(v.label)?.revenue ?? 0,
    customers: rev.get(v.label)?.customers ?? 0,
    extra: v.extra ?? null,
  }));
  // Sources that made money but had no visits in this period (paid later) still show up.
  const seen = new Set(visits.map((v) => v.label));
  for (const r of revenue) if (!seen.has(r.label)) rows.push({ label: r.label, visitors: 0, revenue: r.revenue, customers: r.customers });
  return rows;
}

/** Customers in the period, with where they came from (the "Journey" tab). */
export async function customers(ctx: Ctx) {
  const { db, site, range } = ctx;
  const f = filterSql(ctx.filters);
  const join = hasFilters(ctx.filters) ? 'JOIN' : 'LEFT JOIN';
  const res = await db
    .prepare(
      `SELECT p.id, p.ts, p.amount, p.currency, p.renewal, p.matched_by, p.email AS pay_email, p.name AS pay_name, p.visitor_id, p.session_id,
              v.first_seen, v.name, v.email, v.user_id,
              s.source, s.channel, s.referrer_domain, s.utm_campaign, s.ref, s.country, s.city, s.device, s.os, s.browser, s.entry_page,
              fs.source AS first_source, fs.referrer_domain AS first_referrer_domain, ls.source AS last_source, ls.referrer_domain AS last_referrer_domain,
              (SELECT COUNT(*) FROM sessions s2 INDEXED BY sessions_visitor WHERE s2.site_id = p.site_id AND s2.visitor_id = p.visitor_id AND s2.started_at <= p.ts) AS visits
       FROM payments p
       LEFT JOIN visitors v ON v.site_id = p.site_id AND v.id = p.visitor_id
       LEFT JOIN sessions fs ON fs.site_id = p.site_id AND fs.id = p.first_session_id
       LEFT JOIN sessions ls ON ls.site_id = p.site_id AND ls.id = p.session_id
       ${join} sessions s ON s.site_id = p.site_id AND s.id = ${creditCol(ctx)}
       WHERE p.site_id = ? AND p.kind = 'payment' AND p.ts >= ? AND p.ts < ?${f.sql}
       ORDER BY p.ts DESC LIMIT 200`,
    )
    .bind(site.id, range.from, range.to, ...f.params)
    .all();
  return res.results;
}

/** Recent visitors in the period (the "Users" tab). */
export async function visitors(ctx: Ctx) {
  const w = sessionsWhere(ctx);
  const res = await ctx.db
    .prepare(
      `SELECT t.*, v.name, v.email, v.user_id, v.first_seen,
              (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.site_id = t.site_id AND p.visitor_id = t.visitor_id) AS spent
       FROM (
         SELECT s.site_id, s.visitor_id, MAX(s.last_seen_at) AS last_seen, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews,
                SUM(s.duration) AS duration, s.source, s.referrer_domain, s.country, s.city, s.device, s.os, s.browser
         FROM sessions s WHERE ${w.sql} GROUP BY s.visitor_id ORDER BY last_seen DESC LIMIT 200
       ) t LEFT JOIN visitors v ON v.site_id = t.site_id AND v.id = t.visitor_id
       ORDER BY t.last_seen DESC`,
    )
    .bind(...w.params)
    .all();
  return res.results;
}

/** Everything one visitor did: visits, pages, clicks, payments. */
export async function visitorProfile(db: D1Database, site: Site, vid: string) {
  const [v, s, e, p] = await db.batch([
    db.prepare('SELECT * FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, vid),
    // Both lookups go through the visitor's own visits. Without the named index SQLite reads every visit and
    // every event of the site to find one person's.
    db.prepare('SELECT * FROM sessions INDEXED BY sessions_visitor WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 100').bind(site.id, vid),
    db
      .prepare(
        `SELECT session_id, ts, type, name, path, props FROM events INDEXED BY events_session
         WHERE site_id = ?1 AND session_id IN (SELECT id FROM sessions INDEXED BY sessions_visitor WHERE site_id = ?1 AND visitor_id = ?2)
         ORDER BY ts DESC LIMIT 1000`,
      )
      .bind(site.id, vid),
    db.prepare('SELECT * FROM payments WHERE site_id = ? AND visitor_id = ? ORDER BY ts DESC').bind(site.id, vid),
  ]);
  return {
    visitor: v.results[0] ?? null,
    sessions: s.results,
    events: e.results,
    payments: p.results,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
  };
}

export interface FunnelStep {
  type: 'page' | 'goal';
  value: string; // page paths support * wildcards, e.g. /blog/*
  label?: string;
}

/** Visitors who completed each step, in order, within the period. */
export async function funnel(ctx: Ctx, steps: FunnelStep[]) {
  if (!steps.length) return [];
  const f = filterSql(ctx.filters);
  const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
  const conds: string[] = [];
  const params: unknown[] = [];
  for (const st of steps) {
    if (st.type === 'goal') {
      conds.push(`(e.type = 'goal' AND e.name = ?)`);
      params.push(st.value);
    } else {
      conds.push(`(e.type = 'pageview' AND e.path GLOB ?)`);
      params.push(st.value);
    }
  }
  const rows = (
    await ctx.db
      .prepare(
        `SELECT e.visitor_id AS v, e.ts, e.type, e.name, e.path FROM events e ${join}
         WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ? AND (${conds.join(' OR ')})${f.sql}
         ORDER BY e.ts LIMIT 100000`,
      )
      .bind(ctx.site.id, ctx.range.from, ctx.range.to, ...params, ...f.params)
      .all<{ v: string; ts: number; type: string; name: string | null; path: string }>()
  ).results;

  const matchers = steps.map((st) => {
    if (st.type === 'goal') return (r: (typeof rows)[0]) => r.type === 'goal' && r.name === st.value;
    const re = new RegExp('^' + st.value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return (r: (typeof rows)[0]) => r.type === 'pageview' && re.test(r.path);
  });
  const progress = new Map<string, number>();
  for (const r of rows) {
    const at = progress.get(r.v) ?? 0;
    if (at < steps.length && matchers[at](r)) progress.set(r.v, at + 1);
  }
  const counts = steps.map(() => 0);
  for (const reached of progress.values()) for (let i = 0; i < reached; i++) counts[i]++;
  return steps.map((st, i) => ({ ...st, visitors: counts[i] }));
}

/** Everything the live globe needs: who is on the site right now, and what happened in the last 30 minutes. */
export async function realtime(db: D1Database, site: Site, now = Date.now()) {
  const ACTIVE_MS = 5 * 60_000;
  const FEED_MS = 30 * 60_000;
  const [visitors, events, payments] = await db.batch([
    db
      .prepare(
        `SELECT s.visitor_id, s.id AS session_id, s.lat, s.lon, s.country, s.region, s.city, s.device, s.browser, s.os,
                s.source, s.referrer_domain, s.exit_page AS page, s.started_at, s.last_seen_at, s.pageviews,
                v.name, v.email,
                (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.site_id = s.site_id AND p.visitor_id = s.visitor_id) AS spent
         FROM sessions s LEFT JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id
         WHERE s.site_id = ? AND s.started_at > ? AND s.last_seen_at > ?
         ORDER BY s.last_seen_at DESC LIMIT 500`,
      )
      .bind(site.id, now - 6 * 3_600_000, now - ACTIVE_MS),
    db
      .prepare(
        `SELECT e.id, e.ts, e.type, e.name, e.path, e.visitor_id, s.country, s.lat, s.lon, v.name AS vname, v.email AS vemail
         FROM events e
         LEFT JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id
         LEFT JOIN visitors v ON v.site_id = e.site_id AND v.id = e.visitor_id
         WHERE e.site_id = ? AND e.ts > ? AND e.type IN ('pageview', 'goal')
         ORDER BY e.ts DESC LIMIT 100`,
      )
      .bind(site.id, now - FEED_MS),
    db
      .prepare(
        `SELECT p.id, p.ts, p.amount, p.kind, p.visitor_id, p.name, p.email, s.country, s.lat, s.lon
         FROM payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
         WHERE p.site_id = ? AND p.ts > ?
         ORDER BY p.ts DESC LIMIT 50`,
      )
      .bind(site.id, now - FEED_MS),
  ]);

  // One marker per visitor (their most recent visit).
  const seen = new Set<string>();
  const active = (visitors.results as any[]).filter((v) => !seen.has(v.visitor_id) && seen.add(v.visitor_id));

  const feed = [
    ...(events.results as any[]).map((e) => ({
      id: `e${e.id}`,
      ts: e.ts,
      type: e.type as 'pageview' | 'goal',
      label: e.type === 'goal' ? e.name : e.path,
      visitor_id: e.visitor_id,
      name: e.vname ?? e.vemail ?? null,
      country: e.country,
      lat: e.lat,
      lon: e.lon,
    })),
    ...(payments.results as any[]).map((p) => ({
      id: `p${p.id}`,
      ts: p.ts,
      type: (p.kind === 'refund' ? 'refund' : 'payment') as 'payment' | 'refund',
      amount: p.amount,
      visitor_id: p.visitor_id,
      name: p.name ?? p.email ?? null,
      country: p.country,
      lat: p.lat,
      lon: p.lon,
    })),
  ].sort((a, b) => b.ts - a.ts);

  return { now, currency: site.currency, decimals: currencyDecimals(site.currency), domain: site.domain, visitors: active, feed };
}

const WEEK = 7 * 86_400_000;

/** Run a report at most once per `ttlMs`; these read raw visits, so their result is kept. */
async function cached<T>(db: D1Database, key: string, ttlMs: number, now: number, compute: () => Promise<T>): Promise<T> {
  const hit = await db.prepare('SELECT value FROM stat_cache WHERE key = ? AND expires_at > ?').bind(key, now).first<{ value: string }>();
  if (hit) {
    try {
      return JSON.parse(hit.value) as T;
    } catch {}
  }
  const value = await compute();
  await db
    .prepare('INSERT OR REPLACE INTO stat_cache (key, value, expires_at) VALUES (?, ?, ?)')
    .bind(key, JSON.stringify(value), now + ttlMs)
    .run();
  return value;
}

export interface Cohort {
  /** Monday the cohort's week starts on, YYYY-MM-DD. */
  week: string;
  /** Visitors first seen that week. */
  size: number;
  /** How many of them visited in that week (index 0) and each week after. */
  active: number[];
}

/** Of the visitors first seen in each of the last `weeks` weeks, how many came back in each later week. */
export async function retention(db: D1Database, site: Site, weeks = 8, now = Date.now()): Promise<Cohort[]> {
  const today = dayNumber(now, site.timezone);
  // Day 0 (1970-01-01) was a Thursday, so day 4 was a Monday.
  const monday = today - ((today + 3) % 7);
  const startDay = monday - 7 * (weeks - 1);
  const start = dayStart(startDay, site.timezone);
  return cached(db, `retention:${site.id}:${weeks}:${dayKey(today)}`, 6 * 3_600_000, now, async () => {
    const res = await db
      .prepare(
        `SELECT CAST((v.first_seen - ?1) / ${WEEK} AS INTEGER) AS cohort, CAST((s.started_at - ?1) / ${WEEK} AS INTEGER) AS wk,
                COUNT(DISTINCT s.visitor_id) AS n
         FROM sessions s JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id
         WHERE s.site_id = ?2 AND s.started_at >= ?1 AND v.first_seen >= ?1
         GROUP BY cohort, wk`,
      )
      .bind(start, site.id)
      .all<{ cohort: number; wk: number; n: number }>();
    const cohorts: Cohort[] = [];
    for (let i = 0; i < weeks; i++) cohorts.push({ week: dayKey(startDay + 7 * i), size: 0, active: new Array(weeks - i).fill(0) });
    for (const r of res.results) {
      const c = cohorts[r.cohort];
      const age = r.wk - r.cohort;
      if (!c || age < 0 || age >= c.active.length) continue;
      c.active[age] = r.n;
      if (age === 0) c.size = r.n;
    }
    // Weeks before the site existed have nobody in them.
    const firstWeek = dayNumber(site.created_at, site.timezone) - 6;
    return cohorts.filter((c, i) => c.size > 0 || startDay + 7 * i >= firstWeek);
  });
}

/** New and returning visitors per day, from the daily rows. */
export async function newVsReturning(ctx: Ctx, now = Date.now()) {
  const { site, range } = ctx;
  const from = dayNumber(range.from, site.timezone);
  const to = dayNumber(Math.max(range.from, Math.min(range.to, now) - 1), site.timezone);
  const { rows } = await loadDays(ctx.db, [site], () => from, now);
  const byDay = new Map((rows.get(site.id) ?? []).map((r) => [r.day, r]));
  const out = [];
  for (let d = from; d <= to; d++) {
    const r = byDay.get(d);
    const fresh = r?.gaps['-1'] ?? 0;
    out.push({ day: dayKey(d), new: fresh, returning: (r?.visitors ?? 0) - fresh });
  }
  return out;
}

/**
 * Pages that customers saw before they paid, next to how many of all visitors saw them. A page seen by most
 * buyers and few visitors is doing the selling.
 */
export async function buyerPages(ctx: Ctx) {
  const { db, site, range } = ctx;
  const [buyers, pages, all] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(DISTINCT p.visitor_id) AS n FROM payments p
         WHERE p.site_id = ? AND p.kind = 'payment' AND p.renewal = 0 AND p.visitor_id IS NOT NULL AND p.ts >= ? AND p.ts < ?`,
      )
      .bind(site.id, range.from, range.to)
      .first<{ n: number }>(),
    // From each buyer to their visits to the pages of those visits, all by index.
    db
      .prepare(
        `SELECT e.path AS path, COUNT(DISTINCT p.visitor_id) AS buyers
         FROM payments p
         JOIN sessions s INDEXED BY sessions_visitor ON s.site_id = p.site_id AND s.visitor_id = p.visitor_id AND s.started_at <= p.ts
         JOIN events e INDEXED BY events_session ON e.site_id = s.site_id AND e.session_id = s.id AND e.type = 'pageview' AND e.ts <= p.ts
         WHERE p.site_id = ? AND p.kind = 'payment' AND p.renewal = 0 AND p.visitor_id IS NOT NULL AND p.ts >= ? AND p.ts < ?
         GROUP BY e.path ORDER BY buyers DESC LIMIT 100`,
      )
      .bind(site.id, range.from, range.to)
      .all<{ path: string; buyers: number }>(),
    db.batch<{ label: string; visitors: number }>([
      db
        .prepare(
          `SELECT e.path AS label, COUNT(DISTINCT e.visitor_id) AS visitors FROM events e
           WHERE e.site_id = ? AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ? GROUP BY label ORDER BY visitors DESC LIMIT 500`,
        )
        .bind(site.id, range.from, range.to),
      db.prepare('SELECT COUNT(DISTINCT visitor_id) AS visitors, NULL AS label FROM sessions s WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?').bind(site.id, range.from, range.to),
    ]),
  ]);
  const visitorsBy = new Map(all[0].results.map((r) => [r.label, r.visitors]));
  const totalVisitors = all[1].results[0]?.visitors ?? 0;
  const totalBuyers = buyers?.n ?? 0;
  return {
    buyers: totalBuyers,
    visitors: totalVisitors,
    pages: pages.results.map((r) => ({
      path: r.path,
      buyers: r.buyers,
      buyerShare: totalBuyers ? r.buyers / totalBuyers : 0,
      visitors: visitorsBy.get(r.path) ?? 0,
      visitorShare: totalVisitors ? (visitorsBy.get(r.path) ?? 0) / totalVisitors : 0,
    })),
  };
}
