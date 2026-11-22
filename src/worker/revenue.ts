// Revenue beyond the period total: new versus renewal, subscriptions (MRR, churn) and what a customer is worth by source.
import type { Site } from './env';
import { currencyDecimals } from './fx';

const DAY = 86_400_000;

export interface PayRow {
  id: string;
  ts: number;
  amount: number;
  kind: string;
  renewal: number;
  visitor_id: string | null;
  customer_id: string | null;
  email: string | null;
  subscription_id: string | null;
  period_days: number | null;
}

const customerKey = (p: PayRow) => p.customer_id ?? p.email ?? p.visitor_id ?? p.id;

export interface SubscriptionStats {
  /** Monthly recurring revenue in minor units. */
  mrr: number;
  active: number;
  /** Subscriptions that ended (no renewal, or refunded) in the last 30 days. */
  churned30: number;
  /** True when a billing period had to be assumed (a single payment with no period on record counts as monthly). */
  estimated: boolean;
}

/**
 * Subscriptions as far as payments can tell: one is active while its last payment's period (plus a few days
 * of grace) has not run out and that payment was not refunded. There is no cancellation event, so a
 * cancelled subscription counts until the period it paid for ends.
 */
export function subscriptionStats(rows: PayRow[], now: number): SubscriptionStats {
  const subs = new Map<string, PayRow[]>();
  for (const p of rows) {
    if (p.kind !== 'payment' || !p.subscription_id) continue;
    if (!subs.has(p.subscription_id)) subs.set(p.subscription_id, []);
    subs.get(p.subscription_id)!.push(p);
  }
  const refunds = rows.filter((p) => p.kind === 'refund');
  const out: SubscriptionStats = { mrr: 0, active: 0, churned30: 0, estimated: false };

  for (const pays of subs.values()) {
    pays.sort((a, b) => a.ts - b.ts);
    const last = pays[pays.length - 1];
    let period = pays.find((p) => p.period_days)?.period_days ?? null;
    if (!period && pays.length > 1) {
      const gaps = pays.slice(1).map((p, i) => (p.ts - pays[i].ts) / DAY).sort((a, b) => a - b);
      period = Math.round(gaps[Math.floor(gaps.length / 2)]);
    }
    if (!period || period < 1) {
      period = 30;
      out.estimated = true;
    }
    const grace = Math.max(3, period * 0.15);
    let endsAt = last.ts + (period + grace) * DAY;
    const refund = refunds.find(
      (r) => r.ts >= last.ts && Math.abs(r.amount) >= last.amount * 0.9 && ((!!r.customer_id && r.customer_id === last.customer_id) || (!!r.visitor_id && r.visitor_id === last.visitor_id)),
    );
    if (refund) endsAt = refund.ts;
    if (endsAt > now) {
      out.active++;
      out.mrr += (last.amount * 30.4375) / period;
    } else if (endsAt > now - 30 * DAY) out.churned30++;
  }
  out.mrr = Math.round(out.mrr);
  return out;
}

const BY: Record<string, string> = {
  source: 's.source',
  channel: 's.channel',
  campaign: 's.utm_campaign',
  country: 's.country',
  entry_page: 's.entry_page',
};

export async function revenueSummary(
  db: D1Database,
  site: Site,
  range: { from: number; to: number },
  opts: { attr?: 'last' | 'first'; by?: string } = {},
  now = Date.now(),
) {
  const by = BY[opts.by ?? 'source'] ? (opts.by ?? 'source') : 'source';
  const col = opts.attr === 'first' ? 'p.first_session_id' : 'p.session_id';
  const [all, sources] = await db.batch([
    db
      .prepare(
        `SELECT id, ts, amount, kind, renewal, visitor_id, customer_id, email, subscription_id, period_days
         FROM payments WHERE site_id = ? ORDER BY ts DESC LIMIT 20000`,
      )
      .bind(site.id),
    // Every payment ever, by where the customer came from. Sessions and visitors are fetched by primary key.
    db
      .prepare(
        `SELECT ${BY[by]} AS label, MAX(s.referrer_domain) AS extra,
                COUNT(DISTINCT CASE WHEN p.kind = 'payment' THEN COALESCE(p.customer_id, p.email, p.visitor_id, p.id) END) AS customers,
                SUM(p.amount) AS revenue,
                AVG(CASE WHEN p.kind = 'payment' AND p.renewal = 0 AND v.first_seen IS NOT NULL THEN p.ts - v.first_seen END) AS avg_ms
         FROM payments p
         LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = ${col}
         LEFT JOIN visitors v ON v.site_id = p.site_id AND v.id = p.visitor_id
         WHERE p.site_id = ? GROUP BY label ORDER BY revenue DESC LIMIT 100`,
      )
      .bind(site.id),
  ]);
  const rows = all.results as unknown as PayRow[];

  const inRange = rows.filter((p) => p.ts >= range.from && p.ts < range.to);
  const sum = (list: PayRow[]) => list.reduce((a, p) => a + p.amount, 0);
  const newPays = inRange.filter((p) => p.kind === 'payment' && !p.renewal);
  const renewals = inRange.filter((p) => p.kind === 'payment' && p.renewal);
  const refunds = inRange.filter((p) => p.kind === 'refund');

  const paid = rows.filter((p) => p.kind === 'payment');
  const customers = new Set(paid.map(customerKey));
  const repeat = new Set(paid.filter((p) => p.renewal).map(customerKey));
  const total = sum(rows);

  return {
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
    period: {
      newRevenue: sum(newPays),
      renewalRevenue: sum(renewals),
      refunds: sum(refunds),
      net: sum(inRange),
      newCustomers: new Set(newPays.map(customerKey)).size,
      payments: newPays.length + renewals.length,
    },
    allTime: {
      revenue: total,
      customers: customers.size,
      /** Net revenue per customer so far. */
      ltv: customers.size ? Math.round(total / customers.size) : 0,
      repeatRate: customers.size ? repeat.size / customers.size : 0,
    },
    subscriptions: subscriptionStats(rows, now),
    by,
    sources: (sources.results as { label: string | null; extra: string | null; customers: number; revenue: number; avg_ms: number | null }[]).map((r) => ({
      label: r.label,
      extra: r.extra,
      customers: r.customers,
      revenue: r.revenue,
      ltv: r.customers ? Math.round(r.revenue / r.customers) : 0,
      daysToConvert: r.avg_ms === null ? null : r.avg_ms / DAY,
    })),
  };
}
