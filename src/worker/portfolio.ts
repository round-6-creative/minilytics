// Every site on one screen, and a per-site summary for any period, both read from the daily rows.
import type { Site } from './env';
import { convertMinor, currencyDecimals, loadRates } from './fx';
import { dayKey, dayNumber, dayStart } from './lib/time';
import { listAlerts } from './notify';
import { loadDays, totals, type DayRow } from './rollups';

const SPANS: Record<string, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90, '12m': 365 };

interface PayLite {
  site_id: string;
  id: string;
  ts: number;
  amount: number;
  kind: string;
  renewal: number;
  visitor_id: string | null;
}

interface Window {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounceRate: number;
  avgDuration: number;
  revenue: number;
  payments: number;
  customers: number;
  conversionRate: number;
  revenuePerVisitor: number;
}

function windowStats(rows: DayRow[], pays: PayLite[], site: Pick<Site, 'timezone'>, from: number, to: number): Window {
  const t = totals(rows, from, to);
  const start = dayStart(from, site.timezone);
  const end = dayStart(to + 1, site.timezone);
  const inWin = pays.filter((p) => p.ts >= start && p.ts < end);
  const revenue = inWin.reduce((a, p) => a + p.amount, 0);
  const customers = new Set(inWin.filter((p) => p.kind === 'payment' && !p.renewal).map((p) => p.visitor_id ?? p.id)).size;
  return {
    visitors: t.visitors,
    sessions: t.sessions,
    pageviews: t.pageviews,
    bounceRate: t.sessions ? t.bounces / t.sessions : 0,
    avgDuration: t.sessions ? Math.round(t.duration / t.sessions) : 0,
    revenue,
    payments: inWin.filter((p) => p.kind === 'payment').length,
    customers,
    conversionRate: t.visitors ? customers / t.visitors : 0,
    revenuePerVisitor: t.visitors ? revenue / t.visitors : 0,
  };
}

function dailySeries(rows: DayRow[], pays: PayLite[], site: Pick<Site, 'timezone'>, from: number, to: number) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const revenue = new Map<number, number>();
  for (const p of pays) {
    const d = dayNumber(p.ts, site.timezone);
    revenue.set(d, (revenue.get(d) ?? 0) + p.amount);
  }
  const out = [];
  for (let d = from; d <= to; d++) {
    const r = byDay.get(d);
    out.push({
      day: dayKey(d),
      visitors: r?.visitors ?? 0,
      newVisitors: r?.gaps['-1'] ?? 0,
      sessions: r?.sessions ?? 0,
      pageviews: r?.pageviews ?? 0,
      revenue: revenue.get(d) ?? 0,
    });
  }
  return out;
}

async function paymentsSince(db: D1Database, siteIds: string[], since: number): Promise<Map<string, PayLite[]>> {
  const out = new Map<string, PayLite[]>();
  if (!siteIds.length) return out;
  const res = await db
    .prepare(
      `SELECT site_id, id, ts, amount, kind, renewal, visitor_id FROM payments
       WHERE site_id IN (${siteIds.map(() => '?').join(',')}) AND ts >= ? LIMIT 20000`,
    )
    .bind(...siteIds, since)
    .all<PayLite>();
  for (const p of res.results) {
    if (!out.has(p.site_id)) out.set(p.site_id, []);
    out.get(p.site_id)!.push(p);
  }
  return out;
}

export async function portfolio(db: D1Database, sites: Site[], period: string, now = Date.now()) {
  const span = SPANS[period] ?? SPANS['30d'];
  const p = SPANS[period] ? period : '30d';
  if (!sites.length) return { period: p, sites: [], totals: null, alerts: [], complete: true };
  const ids = sites.map((s) => s.id);
  const today = (s: Pick<Site, 'timezone'>) => dayNumber(now, s.timezone);

  const { rows, complete } = await loadDays(db, sites, (s) => today(s) - 2 * span + 1, now);
  const since = Math.min(...sites.map((s) => dayStart(today(s) - 2 * span + 1, s.timezone)));
  const [pays, online, alerts, rates] = await Promise.all([
    paymentsSince(db, ids, since),
    db
      .prepare(
        `SELECT site_id, COUNT(DISTINCT visitor_id) AS n FROM sessions
         WHERE site_id IN (${ids.map(() => '?').join(',')}) AND started_at > ? AND last_seen_at > ? GROUP BY site_id`,
      )
      .bind(...ids, now - 6 * 3_600_000, now - 5 * 60_000)
      .all<{ site_id: string; n: number }>(),
    listAlerts(db, ids, now),
    loadRates(db).catch(() => new Map<string, number>()),
  ]);
  const onlineBy = new Map(online.results.map((r) => [r.site_id, r.n]));

  const cards = sites.map((site) => {
    const t = today(site);
    const days = rows.get(site.id) ?? [];
    const sitePays = pays.get(site.id) ?? [];
    return {
      id: site.id,
      name: site.name,
      domain: site.domain,
      timezone: site.timezone,
      currency: site.currency,
      decimals: currencyDecimals(site.currency),
      online: onlineBy.get(site.id) ?? 0,
      current: windowStats(days, sitePays, site, t - span + 1, t),
      previous: windowStats(days, sitePays, site, t - 2 * span + 1, t - span),
      series: dailySeries(days, sitePays, site, t - Math.max(span, 14) + 1, t),
      alerts: alerts.filter((a) => a.site_id === site.id && !a.resolved_at).length,
    };
  });

  // Revenue in several currencies is shown in the one most sites use, when today's rates are known.
  const counts = new Map<string, number>();
  for (const s of sites) counts.set(s.currency, (counts.get(s.currency) ?? 0) + 1);
  const display = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const convert = (key: 'current' | 'previous') => {
    let sum = 0;
    for (const c of cards) {
      if (!c[key].revenue) continue;
      const v = convertMinor(c[key].revenue, c.currency, display, rates);
      if (v === null) return null;
      sum += v;
    }
    return sum;
  };
  const sumOf = (key: 'current' | 'previous', field: 'visitors' | 'sessions' | 'pageviews' | 'customers' | 'payments') =>
    cards.reduce((a, c) => a + c[key][field], 0);
  const perCurrency = [...counts.keys()].map((currency) => ({
    currency,
    decimals: currencyDecimals(currency),
    amount: cards.filter((c) => c.currency === currency).reduce((a, c) => a + c.current.revenue, 0),
  }));

  return {
    period: p,
    sites: cards,
    totals: {
      online: cards.reduce((a, c) => a + c.online, 0),
      current: { visitors: sumOf('current', 'visitors'), sessions: sumOf('current', 'sessions'), customers: sumOf('current', 'customers'), payments: sumOf('current', 'payments') },
      previous: { visitors: sumOf('previous', 'visitors'), sessions: sumOf('previous', 'sessions'), customers: sumOf('previous', 'customers'), payments: sumOf('previous', 'payments') },
      revenue: { currency: display, decimals: currencyDecimals(display), current: convert('current'), previous: convert('previous') },
      revenueByCurrency: perCurrency.filter((r) => r.amount !== 0),
    },
    alerts,
    complete,
  };
}

/**
 * One site's totals and daily series for a range of whole days, without reading raw visits (beyond today's).
 * No filters: for those the dashboard's own queries are the tool.
 */
export async function siteSummary(db: D1Database, site: Site, range: { from: number; to: number }, now = Date.now()) {
  const from = dayNumber(range.from, site.timezone);
  const to = dayNumber(Math.max(range.from, Math.min(range.to, now) - 1), site.timezone);
  const span = to - from + 1;
  const { rows } = await loadDays(db, [site], () => from - span, now);
  const days = rows.get(site.id) ?? [];
  const pays = (await paymentsSince(db, [site.id], dayStart(from - span, site.timezone))).get(site.id) ?? [];
  return {
    site: { id: site.id, name: site.name, domain: site.domain, timezone: site.timezone, currency: site.currency },
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
    from: dayKey(from),
    to: dayKey(to),
    current: windowStats(days, pays, site, from, to),
    previous: windowStats(days, pays, site, from - span, from - 1),
    series: dailySeries(days, pays, site, from, to),
  };
}
