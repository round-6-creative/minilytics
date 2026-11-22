// "Is tracking working?" for one site: when the last visit and webhook arrived, how payments were matched,
// and what was filtered out.
import type { Site } from './env';
import { dayKey, dayNumber } from './lib/time';

export type CheckState = 'ok' | 'warn' | 'off';

export interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

const HOUR = 3_600_000;

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 2) return 'just now';
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

export async function siteHealth(db: D1Database, site: Site, now = Date.now()) {
  const today = dayNumber(now, site.timezone);
  const [last, week, hooks, matched, pending, bots, signals, issues] = await db.batch([
    db.prepare('SELECT MAX(started_at) AS ts FROM sessions WHERE site_id = ?').bind(site.id),
    db.prepare('SELECT SUM(sessions) AS sessions, COUNT(*) AS days FROM daily_stats WHERE site_id = ? AND day >= ? AND day < ?').bind(site.id, today - 7, today),
    db.prepare('SELECT * FROM webhook_status WHERE site_id = ?').bind(site.id),
    db
      .prepare(
        `SELECT COALESCE(matched_by, CASE WHEN visitor_id IS NULL THEN 'none' ELSE 'metadata' END) AS how, COUNT(*) AS n
         FROM payments WHERE site_id = ? AND kind = 'payment' AND ts > ? GROUP BY how`,
      )
      .bind(site.id, now - 90 * 24 * HOUR),
    db.prepare('SELECT COUNT(*) AS n FROM pending_payments WHERE site_id = ?').bind(site.id),
    db.prepare('SELECT day, network, count FROM cloud_visits WHERE site_id = ? AND day >= ? ORDER BY day DESC, count DESC').bind(site.id, today - 6),
    db.prepare('SELECT MAX(day) AS day, SUM(n) AS n FROM page_metrics WHERE site_id = ? AND day >= ?').bind(site.id, today - 6),
    db.prepare('SELECT kind, COUNT(*) AS n, SUM(count) AS hits FROM issues WHERE site_id = ? AND last_ts > ? GROUP BY kind').bind(site.id, now - 7 * 24 * HOUR),
  ]);

  const lastTs = (last.results[0] as { ts: number | null } | undefined)?.ts ?? null;
  const w = week.results[0] as { sessions: number | null; days: number } | undefined;
  const perDay = w?.days ? (w.sessions ?? 0) / 7 : null;
  const checks: Check[] = [];

  if (!lastTs) {
    checks.push({ id: 'events', label: 'Receiving visits', state: 'warn', detail: 'No visit recorded yet. Add the script to the site.' });
  } else {
    const quiet = now - lastTs;
    // Quiet for much longer than this site's usual gap between visits.
    const limit = perDay && perDay >= 5 ? Math.min(96, Math.max(3, 600 / perDay)) * HOUR : 7 * 24 * HOUR;
    checks.push({
      id: 'events',
      label: 'Receiving visits',
      state: quiet > limit ? 'warn' : 'ok',
      detail: `Last visit ${ago(quiet)}${perDay !== null ? `; about ${Math.round(perDay)} a day over the last week` : ''}.`,
    });
  }

  const hookRows = hooks.results as { provider: string; last_ok_at: number | null; last_fail_at: number | null; last_error: string | null; fail_count: number }[];
  for (const provider of ['stripe', 'dodo'] as const) {
    const configured = provider === 'stripe' ? !!site.stripe_webhook_secret : !!site.dodo_webhook_secret;
    const row = hookRows.find((h) => h.provider === provider);
    const label = provider === 'stripe' ? 'Stripe webhook' : 'Dodo webhook';
    if (!configured) {
      checks.push({ id: `webhook_${provider}`, label, state: 'off', detail: 'Not connected.' });
    } else if (row && row.fail_count > 0) {
      checks.push({
        id: `webhook_${provider}`,
        label,
        state: 'warn',
        detail: `${row.fail_count} rejected in a row, the last one ${ago(now - (row.last_fail_at ?? now))}. ${row.last_error ?? ''}`.trim(),
      });
    } else if (row?.last_ok_at) {
      checks.push({ id: `webhook_${provider}`, label, state: 'ok', detail: `Last event received ${ago(now - row.last_ok_at)}.` });
    } else {
      checks.push({ id: `webhook_${provider}`, label, state: 'ok', detail: 'Connected. No event received since this check was added.' });
    }
  }

  const how = Object.fromEntries((matched.results as { how: string; n: number }[]).map((r) => [r.how, r.n]));
  const payments = Object.values(how).reduce((a, n) => a + n, 0);
  const unmatched = how.none ?? 0;
  if (payments) {
    checks.push({
      id: 'attribution',
      label: 'Payments linked to a visitor',
      state: unmatched / payments > 0.25 ? 'warn' : 'ok',
      detail: `${payments - unmatched} of ${payments} in the last 90 days.`,
    });
  }
  const waiting = (pending.results[0] as { n: number } | undefined)?.n ?? 0;
  if (waiting) {
    checks.push({ id: 'pending', label: 'Payments waiting for a product', state: 'warn', detail: `${waiting} Dodo payment${waiting > 1 ? 's' : ''} for a product not yet linked to this site.` });
  }

  const sig = signals.results[0] as { day: number | null; n: number | null } | undefined;
  checks.push(
    sig?.day
      ? { id: 'script', label: 'Script version', state: 'ok', detail: 'The current script is installed (scroll depth and page speed are arriving).' }
      : { id: 'script', label: 'Script version', state: 'off', detail: 'No scroll or speed data in the last week: no visits yet, or the site serves an older copy of the script.' },
  );

  const cloudRows = bots.results as { day: number; network: string; count: number }[];
  const byNetwork = new Map<string, number>();
  for (const b of cloudRows) byNetwork.set(b.network, (byNetwork.get(b.network) ?? 0) + b.count);
  const cloudTotal = cloudRows.reduce((a, b) => a + b.count, 0);
  const weekVisits = w?.sessions ?? 0;
  if (cloudTotal) {
    checks.push({
      id: 'cloud',
      label: 'Visits from cloud networks',
      state: weekVisits && cloudTotal / weekVisits > 0.2 ? 'warn' : 'ok',
      detail: `${cloudTotal} in the last week came straight from servers (${[...byNetwork.keys()].slice(0, 3).join(', ')}), most likely scripts. They are counted as visits; filter by Network to see them.`,
    });
  }

  return {
    checks,
    ok: !checks.some((c) => c.state === 'warn'),
    lastVisitAt: lastTs,
    visitsPerDay: perDay,
    matchedBy: how,
    cloudVisits: {
      total: cloudTotal,
      today: cloudRows.filter((b) => b.day === today).reduce((a, b) => a + b.count, 0),
      byNetwork: [...byNetwork.entries()].map(([network, count]) => ({ network, count })).sort((a, b) => b.count - a.count),
      since: dayKey(today - 6),
    },
    issues: Object.fromEntries((issues.results as { kind: string; n: number; hits: number }[]).map((r) => [r.kind, { distinct: r.n, hits: r.hits }])),
  };
}
