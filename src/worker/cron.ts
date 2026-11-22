// Scheduled work, once an hour: finish yesterday's daily rows, check that every site is still being tracked,
// spot traffic spikes, refresh exchange rates once a day and send the weekly summary.
import type { Env, Site, SiteWithOwner } from './env';
import { formatMoney, refreshRates } from './fx';
import { dayKey, dayNumber, dayStart } from './lib/time';
import { getSetting, notify, raiseAlert, resolveAlert, setSetting } from './notify';
import { inWorkspace } from './payments';
import { loadDays, totals, type DayRow } from './rollups';
import { trimIssues } from './signals';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A site has to average this many visits a day before silence means anything. */
const MIN_DAILY_VISITS = 5;
const SPIKE_FACTOR = 3;
const SPIKE_MIN_VISITS = 50;
const HISTORY_DAYS = 42;

export interface CronReport {
  sites: number;
  daysComplete: boolean;
  alerts: string[];
  daily: boolean;
  digest: boolean;
  errors: string[];
}

/** How many hours without a visit is unusual for a site with this many visits a day. */
export function quietLimitHours(perDay: number): number | null {
  if (perDay < MIN_DAILY_VISITS) return null;
  // About 25 visits would normally have arrived in this time, so none at all is no accident, even at night.
  return Math.min(96, Math.max(3, 600 / perDay));
}

const pct = (cur: number, prev: number) => (prev ? ` (${cur >= prev ? '+' : ''}${Math.round(((cur - prev) / prev) * 100)}%)` : '');

export async function runScheduled(env: Env, now = Date.now(), origin = '', fetcher: typeof fetch = fetch): Promise<CronReport> {
  const db = env.DB;
  const report: CronReport = { sites: 0, daysComplete: true, alerts: [], daily: false, digest: false, errors: [] };
  const attempt = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      report.errors.push(`${name}: ${(e as Error).message}`);
    }
  };

  // On a hosted install only the owner's own sites are watched; other accounts' sites are not theirs to hear about.
  const sites = (
    await db.prepare('SELECT s.*, u.email AS owner_email FROM sites s LEFT JOIN users u ON u.id = s.owner_id ORDER BY s.created_at').all<SiteWithOwner>()
  ).results.filter((s) => inWorkspace(env, s));
  report.sites = sites.length;
  if (!sites.length) return report;
  const today = (s: Pick<Site, 'timezone'>) => dayNumber(now, s.timezone);

  // Finished days of the last six weeks (what the portfolio, the checks and the weekly summary read). Once a
  // day is final this costs one read for all sites; longer ranges are filled in when somebody asks for them.
  let days = new Map<string, DayRow[]>();
  await attempt('days', async () => {
    const res = await loadDays(db, sites, (s) => today(s) - HISTORY_DAYS, now, { skipToday: true, maxSites: 20 });
    days = res.rows;
    report.daysComplete = res.complete;
  });

  const open = new Set<string>();
  await attempt('alerts', async () => {
    for (const r of (await db.prepare('SELECT key FROM alerts WHERE resolved_at IS NULL').all<{ key: string }>()).results) open.add(r.key);
  });

  await attempt('tracking', async () => {
    const watched = sites.map((site) => {
      const t = today(site);
      const perDay = totals(days.get(site.id) ?? [], t - 7, t - 1).sessions / 7;
      return { site, perDay, limit: quietLimitHours(perDay) };
    });
    // Only sites busy enough for silence to mean something are asked for their last visit (one row each).
    const asked = watched.filter((w) => w.limit !== null || open.has(`silent:${w.site.id}`));
    const [lasts, recent] = await Promise.all([
      asked.length
        ? db.batch<{ ts: number | null }>(asked.map((w) => db.prepare('SELECT MAX(started_at) AS ts FROM sessions WHERE site_id = ?').bind(w.site.id)))
        : Promise.resolve([]),
      // Visits per site in the last 24 hours, in one indexed query.
      db
        .prepare(`SELECT site_id, COUNT(*) AS n FROM sessions WHERE site_id IN (${sites.map(() => '?').join(',')}) AND started_at >= ? GROUP BY site_id`)
        .bind(...sites.map((x) => x.id), now - DAY)
        .all<{ site_id: string; n: number }>(),
    ]);
    const lastOf = new Map(asked.map((w, i) => [w.site.id, lasts[i].results[0]?.ts ?? null]));
    const last24 = new Map(recent.results.map((r) => [r.site_id, r.n]));

    for (const { site, perDay, limit } of watched) {
      const link = origin ? `\n${origin}/site/${site.id}` : '';

      // Silence: nothing for far longer than this site's usual gap between visits.
      const lastTs = lastOf.get(site.id) ?? null;
      const key = `silent:${site.id}`;
      if (limit && lastTs && now - lastTs > limit * HOUR) {
        if (!open.has(key)) {
          const hours = Math.round((now - lastTs) / HOUR);
          const title = `⚠️ ${site.name} stopped sending visits`;
          const body = `Nothing recorded for ${hours} hours; it usually gets about ${Math.round(perDay)} visits a day. Check that the script is still on ${site.domain}.`;
          if (await raiseAlert(db, { siteId: site.id, kind: 'tracking', key, title, body, now })) {
            report.alerts.push(key);
            await notify(db, 'health', title, body + link);
          }
        }
      } else if (open.has(key) && lastTs && now - lastTs < HOUR && (await resolveAlert(db, key, now))) {
        await notify(db, 'health', `✅ ${site.name} is sending visits again`, link.trim());
      }

      // A spike: the last 24 hours brought several times a normal day.
      const n = last24.get(site.id) ?? 0;
      if (n >= SPIKE_MIN_VISITS && perDay >= 1 && n > SPIKE_FACTOR * perDay) {
        const spikeKey = `spike:${site.id}:${dayKey(Math.floor(now / DAY))}`;
        const seen = await db.prepare('SELECT 1 FROM alerts WHERE key = ? LIMIT 1').bind(spikeKey).first();
        if (!seen) {
          const top = await db
            .prepare('SELECT source, COUNT(*) AS c FROM sessions WHERE site_id = ? AND started_at >= ? GROUP BY source ORDER BY c DESC LIMIT 1')
            .bind(site.id, now - DAY)
            .first<{ source: string; c: number }>();
          const title = `📈 Traffic spike on ${site.name}`;
          const body = `${n} visits in the last 24 hours, against about ${Math.round(perDay)} on a normal day.${top ? ` Most come from ${top.source} (${top.c}).` : ''}`;
          await db
            .prepare('INSERT INTO alerts (site_id, kind, key, ts, title, body, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(site.id, 'spike', spikeKey, now, title, body, now)
            .run();
          report.alerts.push(spikeKey);
          await notify(db, 'spike', title, body + link);
        }
      }
    }
  });

  await attempt('webhooks', async () => {
    const rows = (await db.prepare('SELECT site_id, provider, fail_count, last_error FROM webhook_status').all<{ site_id: string; provider: string; fail_count: number; last_error: string | null }>()).results;
    for (const r of rows) {
      const site = sites.find((s) => s.id === r.site_id);
      if (!site) continue;
      const key = `webhook:${r.site_id}:${r.provider}`;
      const name = r.provider === 'stripe' ? 'Stripe' : 'Dodo';
      if (r.fail_count >= 3 && !open.has(key)) {
        const title = `⚠️ ${site.name}: ${name} webhook is being rejected`;
        const body = `${r.fail_count} events in a row failed the signature check, so payments are not being recorded. Paste the current signing secret into the site's settings.`;
        if (await raiseAlert(db, { siteId: site.id, kind: 'webhook', key, title, body, now })) {
          report.alerts.push(key);
          await notify(db, 'health', title, body + (origin ? `\n${origin}/site/${site.id}/settings` : ''));
        }
      } else if (r.fail_count === 0 && open.has(key)) await resolveAlert(db, key, now);
    }
  });

  // Once per UTC day.
  const utcDay = dayKey(Math.floor(now / DAY));
  if ((await getSetting(db, 'cron_daily')) !== utcDay) {
    report.daily = true;
    await setSetting(db, 'cron_daily', utcDay);
    await attempt('rates', async () => {
      await refreshRates(db, fetcher);
    });
    await attempt('prune', async () => {
      await db.batch([
        db.prepare('DELETE FROM stat_cache WHERE expires_at < ?').bind(now),
        db.prepare('DELETE FROM login_failures WHERE ts < ?').bind(now - DAY),
        db.prepare('DELETE FROM alerts WHERE ts < ?').bind(now - 120 * DAY),
        db.prepare('DELETE FROM cloud_visits WHERE day < ?').bind(Math.floor(now / DAY) - 120),
        // Per-page and per-form counters are kept for 400 days.
        db.prepare('DELETE FROM page_metrics WHERE day < ?').bind(Math.floor(now / DAY) - 400),
        db.prepare('DELETE FROM form_stats WHERE day < ?').bind(Math.floor(now / DAY) - 400),
        ...trimIssues(db, now),
      ]);
    });
  }

  // Monday morning (UTC): the week that just ended.
  const d = new Date(now);
  if (d.getUTCDay() === 1 && d.getUTCHours() >= 7) {
    const key = `digest:${utcDay}`;
    if ((await getSetting(db, 'cron_digest')) !== key) {
      await setSetting(db, 'cron_digest', key);
      await attempt('digest', async () => {
        const text = await weeklyDigest(db, sites, days, now);
        if (!text) return;
        report.digest = true;
        const title = '📊 Last week on your sites';
        await db.prepare('INSERT INTO alerts (site_id, kind, key, ts, title, body, resolved_at) VALUES (NULL, ?, ?, ?, ?, ?, ?)').bind('digest', key, now, title, text, now).run();
        await notify(db, 'digest', title, text + (origin ? `\n${origin}` : ''));
      });
    }
  }
  return report;
}

/** Visitors and revenue of the last seven finished days per site, against the seven before. */
export async function weeklyDigest(db: D1Database, sites: Site[], days: Map<string, DayRow[]>, now = Date.now()): Promise<string | null> {
  const since = Math.min(...sites.map((s) => dayStart(dayNumber(now, s.timezone) - 14, s.timezone)));
  const pays = (
    await db
      .prepare(`SELECT site_id, ts, amount, kind FROM payments WHERE site_id IN (${sites.map(() => '?').join(',')}) AND ts >= ?`)
      .bind(...sites.map((s) => s.id), since)
      .all<{ site_id: string; ts: number; amount: number; kind: string }>()
  ).results;

  const lines: { text: string; revenue: number; visitors: number }[] = [];
  for (const site of sites) {
    const t = dayNumber(now, site.timezone);
    const rows = days.get(site.id) ?? [];
    const cur = totals(rows, t - 7, t - 1);
    const prev = totals(rows, t - 14, t - 8);
    const inWeek = (from: number, to: number) => pays.filter((p) => p.site_id === site.id && p.ts >= dayStart(from, site.timezone) && p.ts < dayStart(to + 1, site.timezone));
    const curPays = inWeek(t - 7, t - 1);
    const revenue = curPays.reduce((a, p) => a + p.amount, 0);
    const prevRevenue = inWeek(t - 14, t - 8).reduce((a, p) => a + p.amount, 0);
    const sales = curPays.filter((p) => p.kind === 'payment').length;
    if (!cur.visitors && !prev.visitors && !revenue) continue;
    let text = `• ${site.name}: ${cur.visitors.toLocaleString('en')} visitor${cur.visitors === 1 ? '' : 's'}${pct(cur.visitors, prev.visitors)}`;
    if (revenue) text += `, ${formatMoney(revenue, site.currency)}${pct(revenue, prevRevenue)} from ${sales} payment${sales === 1 ? '' : 's'}`;
    else if (prevRevenue > 0) text += `, no revenue (${formatMoney(prevRevenue, site.currency)} the week before)`;
    lines.push({ text, revenue, visitors: cur.visitors });
  }
  if (!lines.length) return null;
  lines.sort((a, b) => b.revenue - a.revenue || b.visitors - a.visitors);
  return lines.map((l) => l.text).join('\n');
}
