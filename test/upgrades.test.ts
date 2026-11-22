import { describe, expect, it } from 'vitest';
import { classify } from '../src/shared/sources';
import { chargeToken, createToken, handleRpc, ReportError, runReport, useToken } from '../src/worker/agent';
import { ingest } from '../src/worker/collect';
import { quietLimitHours, runScheduled, weeklyDigest } from '../src/worker/cron';
import type { Env, Site } from '../src/worker/env';
import { convertMinor, formatMoney } from '../src/worker/fx';
import { siteHealth } from '../src/worker/health';
import { dayKey, dayNumber, dayOfKey, dayStart } from '../src/worker/lib/time';
import { raiseAlert, resolveAlert, savePrefs, validWebhookUrl, webhookRequest } from '../src/worker/notify';
import { recordPayment, stripePeriodDays } from '../src/worker/payments';
import { portfolio, siteSummary } from '../src/worker/portfolio';
import { revenueSummary, subscriptionStats, type PayRow } from '../src/worker/revenue';
import { loadDays, totals, type DayRow } from '../src/worker/rollups';
import { datacenterOf, formStats, listIssues, MAX_ISSUES, pageQuality, trimIssues } from '../src/worker/signals';
import { breakdown, buyerPages, ctxFor, customers, retention, visitorProfile } from '../src/worker/stats';
import { migratedD1 } from './d1';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const GEO = { country: 'BR', region: 'MG', city: 'Belo Horizonte', lat: -19.9, lon: -43.9 };

function makeSite(raw: ReturnType<typeof migratedD1>['raw'], over: Partial<Site> = {}): Site {
  const site: Site = { id: 'site0001', name: 'Shop', domain: 'shop.test', timezone: 'UTC', currency: 'USD', api_key: 'ml_x', dodo_webhook_secret: null, created_at: Date.UTC(2026, 0, 1), ...over };
  raw
    .prepare('INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(site.id, site.name, site.domain, site.timezone, site.currency, site.api_key, site.created_at);
  return site;
}

/** Deterministic pseudo-random numbers, so a failing case can be reproduced. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** Stands in for the exchange-rate service, so tests never touch the network. */
const rates = (async () => new Response(JSON.stringify({ date: '2026-06-01', rates: { EUR: 0.9, BRL: 5 } }))) as unknown as typeof fetch;

const view = (db: D1Database, site: Site, vid: string, sid: string, at: number, url = 'https://shop.test/', ref?: string) =>
  ingest(db, site, { w: site.id, t: 'pageview', u: url, r: ref, vid, sid } as never, new URL(url), UA, GEO, at);

describe('ad click ids', () => {
  it('counts an untagged Google ad click as paid', () => {
    expect(classify({ referrerDomain: 'google.com', clickId: 'gclid' })).toMatchObject({ source: 'Google Ads', channel: 'Paid' });
    expect(classify({ referrerDomain: null, clickId: 'msclkid' })).toMatchObject({ source: 'Microsoft Ads', channel: 'Paid' });
  });
  it('keeps your own tag as the source but still marks it paid', () => {
    expect(classify({ referrerDomain: null, utmSource: 'spring-sale', clickId: 'gclid' })).toMatchObject({ source: 'spring-sale', channel: 'Paid' });
  });
  it('treats fbclid as Facebook, not as an ad', () => {
    expect(classify({ referrerDomain: null, clickId: 'fbclid' })).toMatchObject({ source: 'Facebook', channel: 'Organic Social' });
    expect(classify({ referrerDomain: 'instagram.com', clickId: 'fbclid' })).toMatchObject({ source: 'Instagram' });
  });
  it('is stored on the visit', async () => {
    const { d1, raw } = migratedD1();
    const site = makeSite(raw);
    await view(d1, site, 'visitor-aaaa', 'session-aaaa', Date.UTC(2026, 5, 1), 'https://shop.test/?gclid=abc123');
    expect(raw.prepare('SELECT source, channel, click_id FROM sessions').get()).toMatchObject({ source: 'Google Ads', channel: 'Paid', click_id: 'gclid' });
  });
});

describe('cloud networks', () => {
  const headers = (h: Record<string, string>) => new Headers(h);
  it('recognises a direct hit from a cloud provider', () => {
    expect(datacenterOf(14061, headers({}))).toBe('DigitalOcean');
    // Cloudflare may or may not have added the connecting address to the header itself.
    expect(datacenterOf(16509, headers({ 'cf-connecting-ip': '3.3.3.3' }))).toBe('Amazon AWS');
    expect(datacenterOf(16509, headers({ 'cf-connecting-ip': '3.3.3.3', 'x-forwarded-for': '3.3.3.3' }))).toBe('Amazon AWS');
  });
  it('never judges a proxied request or an ordinary network', () => {
    // A site's own proxy forwards the visitor's address; the request then arrives from the proxy's cloud.
    expect(datacenterOf(16509, headers({ 'cf-connecting-ip': '3.3.3.3', 'x-forwarded-for': '189.1.2.3' }))).toBeNull();
    expect(datacenterOf(16509, headers({ 'cf-connecting-ip': '3.3.3.3', 'x-forwarded-for': '189.1.2.3, 3.3.3.3' }))).toBeNull();
    expect(datacenterOf(16509, headers({ 'x-forwarded-for': '189.1.2.3' }))).toBeNull();
    expect(datacenterOf(16509, headers({ 'x-vercel-ip-country': 'BR' }))).toBeNull();
    expect(datacenterOf(28573, headers({}))).toBeNull();
    expect(datacenterOf(undefined, headers({}))).toBeNull();
  });
  it('marks and counts such a visit instead of dropping it', async () => {
    const { d1, raw } = migratedD1();
    const site = makeSite(raw);
    const now = Date.UTC(2026, 5, 1, 10);
    const body = { w: site.id, t: 'pageview', u: 'https://shop.test/', vid: 'visitor-aaaa', sid: 'session-aaaa' } as never;
    await ingest(d1, site, body, new URL('https://shop.test/'), UA, GEO, now, false, 'Amazon AWS');
    await ingest(d1, site, body, new URL('https://shop.test/'), UA, GEO, now + 1000, false, 'Amazon AWS');
    expect(raw.prepare('SELECT cloud, pageviews FROM sessions').get()).toEqual({ cloud: 'Amazon AWS', pageviews: 2 });
    expect(raw.prepare('SELECT network, count FROM cloud_visits').get()).toEqual({ network: 'Amazon AWS', count: 1 });
    const rows = await breakdown(ctxFor(d1, site, { period: 'custom', from: '2026-06-01', to: '2026-06-01' }, now + DAY), 'cloud');
    expect(rows).toMatchObject([{ label: 'Amazon AWS', visitors: 1 }]);
  });
});

describe('daily rows', () => {
  it('counts a returning visitor once in a range', () => {
    const row = (day: number, gaps: Record<string, number>): DayRow => ({ site_id: 's', day, visitors: 0, sessions: 1, pageviews: 1, bounces: 0, duration: 0, gaps, final: 1, computed_at: 0 });
    // Day 10: two new visitors. Day 12: one of them returns (gap 2) and one new visitor arrives.
    const rows = [row(10, { '-1': 2 }), row(12, { '2': 1, '-1': 1 })];
    expect(totals(rows, 10, 12).visitors).toBe(3);
    expect(totals(rows, 11, 12).visitors).toBe(2);
    expect(totals(rows, 12, 12).visitors).toBe(2);
    expect(totals(rows, 10, 12).newVisitors).toBe(3);
  });

  for (const tz of ['UTC', 'Asia/Kolkata', 'America/New_York']) {
    it(`match raw counts for any range of days (${tz}, across a clock change)`, async () => {
      const { d1, raw } = migratedD1();
      const site = makeSite(raw, { timezone: tz, created_at: Date.UTC(2026, 8, 1) });
      const rand = rng(tz.length * 7919);
      const start = Date.UTC(2026, 9, 5);
      const now = Date.UTC(2026, 10, 22, 15, 30); // New York's clocks go back on 1 Nov 2026
      const insert = raw.prepare('INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, goals, duration, source, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (let i = 0; i < 1500; i++) {
        const at = start + Math.floor(rand() * (now - start));
        insert.run(site.id, `s${i}`, `v${Math.floor(rand() * 220)}`, at, at, 1 + Math.floor(rand() * 3), rand() < 0.1 ? 1 : 0, Math.floor(rand() * 90_000), 'Direct/None', 'Direct');
      }
      const { rows, complete } = await loadDays(d1, [site], () => 0, now);
      expect(complete).toBe(true);
      const today = dayNumber(now, tz);
      const exact = raw.prepare('SELECT COUNT(DISTINCT visitor_id) v, COUNT(*) s, COALESCE(SUM(pageviews), 0) p FROM sessions WHERE started_at >= ? AND started_at < ?');
      for (const span of [1, 2, 3, 7, 14, 30, 45]) {
        for (const back of [0, 1, 5, 17, 21, 22]) {
          const to = today - back;
          const from = to - span + 1;
          const want = exact.get(dayStart(from, tz), dayStart(to + 1, tz)) as { v: number; s: number; p: number };
          const got = totals(rows.get(site.id)!, from, to);
          expect({ span, back, v: got.visitors, s: got.sessions, p: got.pageviews }).toEqual({ span, back, v: want.v, s: want.s, p: want.p });
        }
      }
      // Finished days are final; today's row is fresh, so a second call computes nothing.
      const before = raw.prepare('SELECT MAX(computed_at) m FROM daily_stats').get() as { m: number };
      await loadDays(d1, [site], () => 0, now + 60_000);
      expect((raw.prepare('SELECT MAX(computed_at) m FROM daily_stats').get() as { m: number }).m).toBe(before.m);
      // ...and after five minutes only today is recomputed.
      await loadDays(d1, [site], () => 0, now + 6 * 60_000);
      expect(raw.prepare('SELECT COUNT(*) n FROM daily_stats WHERE computed_at > ?').get(before.m)).toEqual({ n: 1 });
    });
  }

  it('day helpers agree with each other', () => {
    for (const tz of ['UTC', 'Europe/Paris', 'America/Sao_Paulo', 'Asia/Kolkata']) {
      const n = dayNumber(Date.UTC(2026, 10, 22, 12), tz);
      expect(dayNumber(dayStart(n, tz), tz)).toBe(n);
      expect(dayNumber(dayStart(n + 1, tz) - 1, tz)).toBe(n);
      expect(dayOfKey(dayKey(n))).toBe(n);
    }
  });
});

describe('page quality signals', () => {
  it('adds scroll depth and speed to one row per page and day', async () => {
    const { d1, raw } = migratedD1();
    const site = makeSite(raw);
    const now = Date.UTC(2026, 5, 1, 10);
    await view(d1, site, 'visitor-aaaa', 'session-aaaa', now, 'https://shop.test/pricing');
    const ping = (extra: object) =>
      ingest(d1, site, { w: site.id, t: 'ping', u: 'https://shop.test/pricing', vid: 'visitor-aaaa', sid: 'session-aaaa', d: 4000, ...extra } as never, new URL('https://shop.test/pricing'), UA, GEO, now);
    await ping({ sd: 80, lcp: 1800, cls: 40, inp: 120 });
    await ping({ sd: 100, lcp: 5200 });
    await ping({});
    expect(raw.prepare('SELECT COUNT(*) n FROM page_metrics').get()).toEqual({ n: 1 });
    const [row] = await pageQuality(d1, site, { from: now - DAY, to: now + DAY });
    expect(row).toMatchObject({ path: '/pricing', exits: 2, scroll: 90, reachedHalf: 1, reachedEnd: 0.5, lcp: 3500, lcpGood: 0.5, lcpPoor: 0.5, inp: 120, cls: 0.04 });
    expect(raw.prepare('SELECT duration FROM sessions').get()).toEqual({ duration: 12000 });
  });

  it('counts errors, missing pages and forms without starting a visit', async () => {
    const { d1, raw } = migratedD1();
    const site = makeSite(raw);
    const now = Date.UTC(2026, 5, 1, 10);
    const send = (body: object, url = 'https://shop.test/checkout') =>
      ingest(d1, site, { w: site.id, u: url, vid: 'visitor-aaaa', sid: 'session-aaaa', ...body } as never, new URL(url), UA, GEO, now);
    await send({ t: 'error', n: 'TypeError: x is undefined', p: { src: '/app.js:10:2' } });
    await send({ t: 'error', n: 'TypeError: x is undefined', p: { src: '/app.js:10:2' } });
    await send({ t: 'error', k: '404', p: { ref: 'https://shop.test/blog' } }, 'https://shop.test/old-page');
    await send({ t: 'form', n: 'signup', p: { a: 'start' } });
    await send({ t: 'form', n: 'signup', p: { a: 'start' } });
    await send({ t: 'form', n: 'signup', p: { a: 'submit' } });
    await send({ t: 'form', n: 'signup', p: { a: 'bogus' } });
    expect(raw.prepare('SELECT COUNT(*) n FROM sessions').get()).toEqual({ n: 0 });
    const issues = (await listIssues(d1, site)) as Record<string, unknown>[];
    expect(issues.find((i) => i.kind === 'error')).toMatchObject({ key: 'TypeError: x is undefined', count: 2, detail: '/app.js:10:2' });
    expect(issues.find((i) => i.kind === '404')).toMatchObject({ key: '/old-page', count: 1, detail: 'https://shop.test/blog' });
    // The daily job keeps the newest 500 per site and drops what nobody hit for a month.
    const add = raw.prepare("INSERT INTO issues (site_id, kind, key, count, first_ts, last_ts) VALUES (?, 'error', ?, 1, ?, ?)");
    for (let i = 0; i < 520; i++) add.run(site.id, `spam ${i}`, now, now + i);
    add.run(site.id, 'ancient', now - 40 * DAY, now - 40 * DAY);
    await d1.batch(trimIssues(d1, now));
    expect(raw.prepare('SELECT COUNT(*) n FROM issues').get()).toEqual({ n: MAX_ISSUES });
    expect(raw.prepare("SELECT COUNT(*) n FROM issues WHERE key IN ('ancient', 'spam 0')").get()).toEqual({ n: 0 });
    expect(await formStats(d1, site, { from: now - DAY, to: now + DAY })).toEqual([{ form: 'signup', starts: 2, submits: 1 }]);
  });
});

describe('payments', () => {
  async function shop() {
    const { d1, raw } = migratedD1();
    const site = makeSite(raw);
    const t0 = Date.UTC(2026, 5, 1, 10);
    // First visit from X, a second from Google, then a direct visit on which they pay.
    await view(d1, site, 'visitor-aaaa', 'session-0001', t0, 'https://shop.test/', 'https://t.co/abc');
    await view(d1, site, 'visitor-aaaa', 'session-0002', t0 + 2 * DAY, 'https://shop.test/pricing', 'https://www.google.com/');
    await view(d1, site, 'visitor-aaaa', 'session-0003', t0 + 5 * DAY, 'https://shop.test/pricing');
    // Somebody else, who never pays.
    await view(d1, site, 'visitor-bbbb', 'session-0004', t0 + DAY, 'https://shop.test/blog', 'https://t.co/xyz');
    return { d1, raw, site, t0 };
  }

  it('records both the first and the last touch, and breakdowns follow the chosen model', async () => {
    const { d1, raw, site, t0 } = await shop();
    const res = await recordPayment(d1, site, { id: 'pay_1', provider: 'api', ts: t0 + 5 * DAY + HOUR, amount: 2900, kind: 'payment', currency: 'USD', visitorId: 'visitor-aaaa' });
    expect(res.isNew).toBe(true);
    expect(raw.prepare('SELECT session_id, first_session_id FROM payments').get()).toEqual({ session_id: 'session-0002', first_session_id: 'session-0001' });
    expect((await recordPayment(d1, site, { id: 'pay_1', provider: 'api', ts: t0 + 5 * DAY + HOUR, amount: 2900, kind: 'payment', currency: 'USD', visitorId: 'visitor-aaaa' })).isNew).toBe(false);

    const q = { period: 'custom', from: '2026-05-25', to: '2026-06-20' };
    const now = t0 + 30 * DAY;
    const revenueBy = async (attr?: string) =>
      Object.fromEntries((await breakdown(ctxFor(d1, site, { ...q, attr }, now), 'source')).map((r) => [r.label, r.revenue]));
    expect(await revenueBy()).toMatchObject({ Google: 2900, X: 0 });
    expect(await revenueBy('first')).toMatchObject({ Google: 0, X: 2900 });

    const [journey] = (await customers(ctxFor(d1, site, q, now))) as Record<string, unknown>[];
    expect(journey).toMatchObject({ source: 'Google', first_source: 'X', last_source: 'Google', visits: 3 });

    const profile = await visitorProfile(d1, site, 'visitor-aaaa');
    expect(profile.sessions).toHaveLength(3);
    expect(profile.events).toHaveLength(3);

    const pages = await buyerPages(ctxFor(d1, site, q, now));
    expect(pages).toMatchObject({ buyers: 1, visitors: 2 });
    expect(pages.pages.find((p) => p.path === '/pricing')).toMatchObject({ buyers: 1, buyerShare: 1, visitors: 1, visitorShare: 0.5 });
    expect(pages.pages.find((p) => p.path === '/blog')).toBeUndefined();
  });

  it('converts a foreign payment to the site currency and refunds at the same rate', async () => {
    const { d1, raw, site, t0 } = await shop();
    raw.prepare("INSERT INTO fx_rates (currency, per_usd, day) VALUES ('USD', 1, 'x'), ('BRL', 5, 'x'), ('JPY', 150, 'x')").run();
    await recordPayment(d1, site, { id: 'pay_brl', provider: 'api', ts: t0, amount: 10000, kind: 'payment', currency: 'brl' });
    expect(raw.prepare("SELECT amount, currency, orig_amount, orig_currency FROM payments WHERE id = 'pay_brl'").get()).toEqual({ amount: 2000, currency: 'USD', orig_amount: 10000, orig_currency: 'BRL' });
    const rates = new Map([['USD', 1], ['BRL', 5], ['JPY', 150]]);
    expect(convertMinor(10000, 'BRL', 'USD', rates)).toBe(2000);
    expect(convertMinor(1500, 'JPY', 'USD', rates)).toBe(1000); // yen has no cents
    expect(convertMinor(1000, 'USD', 'JPY', rates)).toBe(1500);
    expect(convertMinor(1000, 'USD', 'XXX', rates)).toBeNull();
    expect(formatMoney(2900, 'USD')).toBe('$29');
    expect(formatMoney(2950, 'USD')).toBe('$29.50');
  });

  it('reads the billing period from a Stripe invoice', () => {
    expect(stripePeriodDays({ lines: { data: [{ period: { start: 1_700_000_000, end: 1_700_000_000 + 30 * 86_400 } }] } })).toBe(30);
    expect(stripePeriodDays({ lines: { data: [{ period: { start: 1_700_000_000, end: 1_700_000_000 + 365 * 86_400 } }] } })).toBe(365);
    expect(stripePeriodDays({})).toBeNull();
  });

  it('estimates MRR, active and churned subscriptions from payments', () => {
    const now = Date.UTC(2026, 10, 22);
    const pay = (over: Partial<PayRow>): PayRow => ({ id: Math.random().toString(36), ts: now, amount: 1000, kind: 'payment', renewal: 0, visitor_id: null, customer_id: null, email: null, subscription_id: null, period_days: null, ...over });
    const rows = [
      // Monthly, paid 10 days ago: active.
      pay({ subscription_id: 'sub_month', customer_id: 'c1', ts: now - 10 * DAY, period_days: 30, amount: 2000 }),
      // Yearly, paid 100 days ago: active, a twelfth counts.
      pay({ subscription_id: 'sub_year', customer_id: 'c2', ts: now - 100 * DAY, period_days: 365, amount: 12000 }),
      // Monthly, last paid 50 days ago: churned.
      pay({ subscription_id: 'sub_gone', customer_id: 'c3', ts: now - 80 * DAY, period_days: 30 }),
      pay({ subscription_id: 'sub_gone', customer_id: 'c3', ts: now - 50 * DAY, period_days: 30, renewal: 1 }),
      // Refunded right after paying: not active.
      pay({ subscription_id: 'sub_refunded', customer_id: 'c4', ts: now - 5 * DAY, period_days: 30, amount: 3000 }),
      pay({ kind: 'refund', customer_id: 'c4', ts: now - 4 * DAY, amount: -3000 }),
      // No period on record and a single payment: assumed monthly.
      pay({ subscription_id: 'sub_unknown', customer_id: 'c5', ts: now - 2 * DAY, amount: 500 }),
      // One-time purchase: not a subscription.
      pay({ customer_id: 'c6', amount: 9900 }),
    ];
    const s = subscriptionStats(rows, now);
    expect(s.active).toBe(3);
    expect(s.churned30).toBe(2);
    expect(s.estimated).toBe(true);
    expect(s.mrr).toBe(Math.round((2000 * 30.4375) / 30 + (12000 * 30.4375) / 365 + (500 * 30.4375) / 30));
  });

  it('summarises new, renewal and refunded revenue and value by source', async () => {
    const { d1, site, t0 } = await shop();
    const at = t0 + 5 * DAY + HOUR;
    await recordPayment(d1, site, { id: 'in_1', provider: 'stripe', ts: at, amount: 2000, kind: 'payment', currency: 'USD', visitorId: 'visitor-aaaa', customerId: 'cus_1', subscriptionId: 'sub_1', periodDays: 30 });
    await recordPayment(d1, site, { id: 'in_2', provider: 'stripe', ts: at + 30 * DAY, amount: 2000, kind: 'payment', currency: 'USD', customerId: 'cus_1', subscriptionId: 'sub_1', periodDays: 30, renewal: true });
    const r = await revenueSummary(d1, site, { from: t0, to: at + 40 * DAY }, {}, at + 40 * DAY);
    expect(r.period).toMatchObject({ newRevenue: 2000, renewalRevenue: 2000, refunds: 0, net: 4000, newCustomers: 1, payments: 2 });
    expect(r.allTime).toMatchObject({ revenue: 4000, customers: 1, ltv: 4000, repeatRate: 1 });
    expect(r.subscriptions).toMatchObject({ active: 1, mrr: Math.round((2000 * 30.4375) / 30), estimated: false });
    expect(r.sources[0]).toMatchObject({ label: 'Google', customers: 1, revenue: 4000, ltv: 4000 });
    const first = await revenueSummary(d1, site, { from: t0, to: at + 40 * DAY }, { attr: 'first' }, at + 40 * DAY);
    expect(first.sources[0]).toMatchObject({ label: 'X', revenue: 4000 });
  });
});

describe('portfolio and summaries', () => {
  it('agrees with the dashboard numbers and compares with the previous period', async () => {
    const { d1, raw } = migratedD1();
    const site = makeSite(raw, { timezone: 'Europe/Paris' });
    const other = makeSite(raw, { id: 'site0002', name: 'Blog', domain: 'blog.test', currency: 'EUR' });
    const now = Date.UTC(2026, 5, 20, 12);
    for (let i = 0; i < 40; i++) await view(d1, site, `visitor-${String(i % 25).padStart(4, '0')}`, `session-${String(i).padStart(4, '0')}`, now - i * 6 * HOUR - 1000);
    await view(d1, other, 'visitor-zzzz', 'session-zzzz', now - HOUR, 'https://blog.test/');
    await recordPayment(d1, site, { id: 'pay_1', provider: 'api', ts: now - 2 * DAY, amount: 4900, kind: 'payment', currency: 'USD', visitorId: 'visitor-0003' });
    raw.prepare("INSERT INTO fx_rates (currency, per_usd, day) VALUES ('USD', 1, 'x'), ('EUR', 0.5, 'x')").run();

    const p = await portfolio(d1, [site, other], '7d', now);
    const card = p.sites[0];
    const ctx = ctxFor(d1, site, { period: '7d' }, now);
    const exact = raw.prepare('SELECT COUNT(DISTINCT visitor_id) v, COUNT(*) s FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ?').get(site.id, ctx.range.from, ctx.range.to) as { v: number; s: number };
    expect(card.current).toMatchObject({ visitors: exact.v, sessions: exact.s, revenue: 4900, customers: 1, payments: 1 });
    expect(card.previous.sessions).toBeGreaterThan(0);
    expect(card.series).toHaveLength(14);
    expect(card.series.reduce((a, d) => a + d.revenue, 0)).toBe(4900);
    expect(p.totals!.revenue).toMatchObject({ currency: expect.any(String), current: expect.any(Number) });
    expect(p.totals!.current.visitors).toBe(card.current.visitors + 1);
    expect(p.sites[1].current.visitors).toBe(1);

    const s = await siteSummary(d1, site, ctx.range, now);
    expect(s.current).toMatchObject({ visitors: exact.v, sessions: exact.s, revenue: 4900 });
    expect(s.series).toHaveLength(7);
  });

  it('builds retention cohorts by the week a visitor first came', async () => {
    const { d1, raw } = migratedD1();
    const site = makeSite(raw);
    const now = Date.UTC(2026, 5, 17, 12); // a Wednesday
    const monday = dayStart(dayNumber(now, 'UTC') - 2, 'UTC');
    // Three visitors first seen two weeks ago; one of them returns last week and this week.
    for (const v of ['a', 'b', 'c']) await view(d1, site, `visitor-000${v}`, `s-first-${v}xxxx`, monday - 14 * DAY + HOUR);
    await view(d1, site, 'visitor-000a', 's-second-axxx', monday - 7 * DAY + HOUR);
    await view(d1, site, 'visitor-000a', 's-third-axxxx', monday + HOUR);
    const cohorts = await retention(d1, site, 4, now);
    expect(cohorts).toHaveLength(4);
    expect(cohorts[1]).toMatchObject({ size: 3, active: [3, 1, 1] });
    expect(cohorts[3]).toMatchObject({ size: 0, active: [0] });
    // Served from the cache the second time.
    raw.prepare('DELETE FROM sessions').run();
    expect((await retention(d1, site, 4, now))[1].size).toBe(3);
  });
});

describe('alerts, scheduled checks and notifications', () => {
  it('raises an alert once and closes it', async () => {
    const { d1 } = migratedD1();
    expect(await raiseAlert(d1, { siteId: 's', kind: 'tracking', key: 'silent:s', title: 'Quiet' })).toBe(true);
    expect(await raiseAlert(d1, { siteId: 's', kind: 'tracking', key: 'silent:s', title: 'Quiet' })).toBe(false);
    expect(await resolveAlert(d1, 'silent:s')).toBe(true);
    expect(await resolveAlert(d1, 'silent:s')).toBe(false);
    expect(await raiseAlert(d1, { siteId: 's', kind: 'tracking', key: 'silent:s', title: 'Quiet again' })).toBe(true);
  });

  it('knows how long a quiet spell is unusual', () => {
    expect(quietLimitHours(2)).toBeNull();
    expect(quietLimitHours(500)).toBe(3);
    expect(quietLimitHours(50)).toBe(12);
    expect(quietLimitHours(5)).toBe(96);
  });

  it('notices a busy site going silent, a spike, and tracking coming back', async () => {
    const { d1, raw } = migratedD1();
    const site = makeSite(raw);
    const env = { DB: d1 } as unknown as Env;
    const start = Date.UTC(2026, 5, 1);
    // 60 visits a day for 8 days.
    let n = 0;
    for (let day = 0; day < 8; day++) for (let i = 0; i < 60; i++) await view(d1, site, `visitor-${String(n).padStart(5, '0')}`, `session-${String(n++).padStart(5, '0')}`, start + day * DAY + i * 20 * 60_000);
    const lastVisit = start + 7 * DAY + 59 * 20 * 60_000;

    const calm = await runScheduled(env, lastVisit + 2 * HOUR, '', rates);
    expect(calm.errors).toEqual([]);
    expect(calm.alerts).toEqual([]);
    expect(calm.daily).toBe(true);

    const silent = await runScheduled(env, lastVisit + 20 * HOUR, '', rates);
    expect(silent.alerts).toEqual([`silent:${site.id}`]);
    expect(silent.daily).toBe(true); // a new UTC day
    expect((await runScheduled(env, lastVisit + 21 * HOUR, '', rates)).alerts).toEqual([]);
    expect(raw.prepare('SELECT COUNT(*) n FROM alerts WHERE resolved_at IS NULL').get()).toEqual({ n: 1 });

    // Visits return, far more than usual: the silence closes and a spike is reported once.
    const back = lastVisit + 22 * HOUR;
    expect(raw.prepare('SELECT COUNT(*) n FROM daily_stats WHERE final = 0').get()).toEqual({ n: 0 }); // the hourly job leaves today alone
    for (let i = 0; i < 200; i++) await view(d1, site, `visitor-9${String(i).padStart(4, '0')}`, `session-9${String(i).padStart(4, '0')}`, back + i * 1000, 'https://shop.test/', 'https://news.ycombinator.com/item');
    const spike = await runScheduled(env, back + 30 * 60_000, '', rates);
    expect(spike.alerts).toEqual([`spike:${site.id}:${dayKey(Math.floor(back / DAY))}`]);
    expect(raw.prepare("SELECT COUNT(*) n FROM alerts WHERE resolved_at IS NULL").get()).toEqual({ n: 0 });
    expect((raw.prepare("SELECT body FROM alerts WHERE kind = 'spike'").get() as { body: string }).body).toContain('Hacker News');
    expect((await runScheduled(env, back + 90 * 60_000, '', rates)).alerts).toEqual([]);

    const health = await siteHealth(d1, site, back + 30 * 60_000);
    expect(health.checks.find((c) => c.id === 'events')).toMatchObject({ state: 'ok' });
  });

  it('writes the weekly summary from finished days', async () => {
    const { d1, raw } = migratedD1();
    const site = makeSite(raw);
    const quiet = makeSite(raw, { id: 'site0002', name: 'Empty', domain: 'empty.test' });
    const now = Date.UTC(2026, 5, 15, 8); // a Monday
    for (let i = 0; i < 10; i++) await view(d1, site, `visitor-000${i}`, `session-000${i}`, now - 3 * DAY + i * 1000);
    for (let i = 0; i < 5; i++) await view(d1, site, `visitor-100${i}`, `session-100${i}`, now - 10 * DAY + i * 1000);
    await recordPayment(d1, site, { id: 'pay_1', provider: 'api', ts: now - 2 * DAY, amount: 2900, kind: 'payment', currency: 'USD', visitorId: 'visitor-0001' });
    const { rows } = await loadDays(d1, [site, quiet], () => 0, now);
    expect(await weeklyDigest(d1, [site, quiet], rows, now)).toBe('• Shop: 10 visitors (+100%), $29 from 1 payment');

    const report = await runScheduled({ DB: d1 } as unknown as Env, now, '', rates);
    expect(report.digest).toBe(true);
    expect((await runScheduled({ DB: d1 } as unknown as Env, now + HOUR, '', rates)).digest).toBe(false);
    expect(raw.prepare("SELECT COUNT(*) n FROM alerts WHERE kind = 'digest'").get()).toEqual({ n: 1 });
  });

  it('formats messages for each kind of webhook and refuses unsafe addresses', async () => {
    expect(validWebhookUrl('https://hooks.slack.com/services/T/B/x')).toBe(true);
    expect(validWebhookUrl('http://hooks.slack.com/services/T/B/x')).toBe(false);
    expect(validWebhookUrl('https://localhost/hook')).toBe(false);
    expect(validWebhookUrl('https://10.0.0.5/hook')).toBe(false);
    expect(validWebhookUrl('https://[::1]/hook')).toBe(false);
    const body = (url: string) => JSON.parse(webhookRequest(url, 'Title', 'Body').init.body as string);
    expect(body('https://hooks.slack.com/services/T/B/x')).toEqual({ text: '*Title*\nBody' });
    expect(body('https://discord.com/api/webhooks/1/abc')).toEqual({ content: '**Title**\nBody' });
    const tg = webhookRequest('https://api.telegram.org/bot123:abc/sendMessage?chat_id=42', 'Title', 'Body');
    expect(tg.url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(JSON.parse(tg.init.body as string)).toMatchObject({ chat_id: '42', text: 'Title\nBody' });
    expect(body('https://example.com/hook')).toMatchObject({ title: 'Title', body: 'Body', text: 'Title\nBody' });
    const { d1 } = migratedD1();
    expect((await savePrefs(d1, { url: ' https://example.com/hook ', sale: false })).sale).toBe(false);
  });
});

describe('agent access', () => {
  it('accepts only a known token and counts its calls', async () => {
    const { d1, raw } = migratedD1();
    const { token } = await createToken(d1, 'Claude');
    expect(token).toMatch(/^mlr_/);
    expect(raw.prepare('SELECT token_hash FROM api_tokens').get()).not.toMatchObject({ token_hash: token });
    const first = await useToken(d1, `Bearer ${token}`);
    expect(first).toMatchObject({ ok: true, used: 0 });
    expect(await useToken(d1, 'Bearer mlr_wrong')).toMatchObject({ ok: false, status: 401 });
    expect(await useToken(d1, undefined)).toMatchObject({ ok: false, status: 401 });
    expect(await useToken(d1, 'Bearer ml_site_key')).toMatchObject({ ok: false, status: 401 });
    // A report over 30 days of raw visits costs 31; the allowance is 1000 a day.
    if (first.ok) await chargeToken(d1, first.id, first.used, 31);
    expect(await useToken(d1, `Bearer ${token}`)).toMatchObject({ ok: true, used: 31 });
    raw.prepare('UPDATE api_tokens SET calls = 1000').run();
    expect(await useToken(d1, `Bearer ${token}`)).toMatchObject({ ok: false, status: 429 });
    expect(await useToken(d1, `Bearer ${token}`, Date.now() + DAY)).toMatchObject({ ok: true, used: 0 });
  });

  it('speaks MCP: initialize, list tools, call one, report errors as tool results', async () => {
    const { d1, raw } = migratedD1();
    const site = makeSite(raw);
    await view(d1, site, 'visitor-aaaa', 'session-aaaa', Date.now() - HOUR, 'https://shop.test/', 'https://t.co/a');

    const init = (await handleRpc(d1, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })) as any;
    expect(init.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'minilytics' } });
    expect(await handleRpc(d1, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();

    const list = (await handleRpc(d1, { jsonrpc: '2.0', id: 2, method: 'tools/list' })) as any;
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['list_sites', 'portfolio', 'site_summary', 'breakdown', 'payments', 'revenue', 'tracking_health', 'page_quality']));

    const call = (await handleRpc(d1, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'breakdown', arguments: { site: 'shop.test', dimension: 'source', period: '7d' } } })) as any;
    expect(JSON.parse(call.result.content[0].text).rows[0]).toMatchObject({ label: 'X', visitors: 1 });

    const bad = (await handleRpc(d1, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'breakdown', arguments: { site: 'nope', dimension: 'source' } } })) as any;
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain('Shop (shop.test)');

    expect(((await handleRpc(d1, { jsonrpc: '2.0', id: 5, method: 'nope' })) as any).error.code).toBe(-32601);
  });

  it('refuses long ranges on reports that read raw visits, and never returns customer details', async () => {
    const { d1, raw } = migratedD1();
    const site = makeSite(raw);
    const now = Date.now();
    await view(d1, site, 'visitor-aaaa', 'session-aaaa', now - HOUR);
    await recordPayment(d1, site, { id: 'pay_1', provider: 'api', ts: now - 60_000, amount: 2900, kind: 'payment', currency: 'USD', visitorId: 'visitor-aaaa', email: 'jane@example.com', name: 'Jane Doe' });
    await expect(runReport(d1, 'breakdown', { site: site.id, dimension: 'source', period: '12m' })).rejects.toBeInstanceOf(ReportError);
    const meter = { spent: 0 };
    await runReport(d1, 'breakdown', { site: site.id, dimension: 'source', period: '30d' }, meter);
    expect(meter.spent).toBeGreaterThanOrEqual(30);
    await runReport(d1, 'site_summary', { site: site.id, period: '12m' }, meter);
    expect(meter.spent).toBeLessThan(35); // reports answered from daily rows cost 1 whatever the range
    const summary = (await runReport(d1, 'site_summary', { site: 'Shop', period: '12m' })) as any;
    expect(summary.current).toMatchObject({ visitors: 1, revenue: 2900 });
    const payments = JSON.stringify(await runReport(d1, 'payments', { site: site.id, period: '7d' }));
    expect(payments).toContain('"amount":2900');
    expect(payments).not.toContain('jane');
    expect(payments).not.toContain('Jane');
    const all = (await runReport(d1, 'portfolio', {})) as any;
    expect(all.sites[0]).not.toHaveProperty('series');
  });
});
