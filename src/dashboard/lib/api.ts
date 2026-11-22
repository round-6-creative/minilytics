export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: init?.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) {
    window.dispatchEvent(new Event('ml:logout'));
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

export interface Site {
  id: string;
  name: string;
  domain: string;
  timezone: string;
  currency: string;
  api_key: string;
  dodo_webhook_secret: string | null;
  dodo_product_ids?: string | null;
  stripe_webhook_secret?: string | null;
  stripe_app?: string | null;
  created_at: number;
  visitors24h?: number;
  online?: number;
}

export interface Kpis {
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

export interface Overview {
  range: { from: number; to: number; granularity: 'hour' | 'day' | 'week' | 'month' };
  currency: string;
  decimals: number;
  current: Kpis;
  previous: Kpis;
  online: number;
  series: { bucket: string; visitors: number; pageviews: number; revenue: number; payments: number }[];
}

export interface BreakdownRow {
  label: string | null;
  visitors: number;
  pageviews?: number;
  revenue: number;
  customers: number;
  extra?: string | null;
}

export type Filters = Record<string, string>;

export interface Query {
  period: string;
  from?: string;
  to?: string;
  granularity?: string;
  filters: Filters;
  /** 'first' credits a payment to the visitor's first visit instead of the last one that came from somewhere. */
  attr?: string;
}

export function qs(q: Query, extra: Record<string, string | number> = {}) {
  const p = new URLSearchParams();
  p.set('period', q.period);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.granularity) p.set('granularity', q.granularity);
  if (Object.keys(q.filters).length) p.set('filters', JSON.stringify(q.filters));
  if (q.attr === 'first') p.set('attr', 'first');
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
}

export interface Alert {
  id: number;
  site_id: string | null;
  kind: string;
  ts: number;
  title: string;
  body: string | null;
  resolved_at: number | null;
}

export interface PortfolioSite {
  id: string;
  name: string;
  domain: string;
  timezone: string;
  currency: string;
  decimals: number;
  online: number;
  current: Kpis;
  previous: Kpis;
  series: { day: string; visitors: number; newVisitors: number; sessions: number; pageviews: number; revenue: number }[];
  alerts: number;
}

export interface Portfolio {
  period: string;
  sites: PortfolioSite[];
  totals: {
    online: number;
    current: { visitors: number; sessions: number; customers: number; payments: number };
    previous: { visitors: number; sessions: number; customers: number; payments: number };
    /** Every site's revenue in one currency; null when a rate is missing. */
    revenue: { currency: string; decimals: number; current: number | null; previous: number | null };
    revenueByCurrency: { currency: string; decimals: number; amount: number }[];
  } | null;
  alerts: Alert[];
  complete: boolean;
}

export interface HealthCheck {
  id: string;
  label: string;
  state: 'ok' | 'warn' | 'off';
  detail: string;
}

export interface Health {
  checks: HealthCheck[];
  ok: boolean;
}

export interface RevenueSummary {
  currency: string;
  decimals: number;
  period: { newRevenue: number; renewalRevenue: number; refunds: number; net: number; newCustomers: number; payments: number };
  allTime: { revenue: number; customers: number; ltv: number; repeatRate: number };
  subscriptions: { mrr: number; active: number; churned30: number; estimated: boolean };
  by: string;
  sources: { label: string | null; extra: string | null; customers: number; revenue: number; ltv: number; daysToConvert: number | null }[];
}

export interface Audience {
  daily: { day: string; new: number; returning: number }[];
  cohorts: { week: string; size: number; active: number[] }[];
}

export interface BuyerPages {
  buyers: number;
  visitors: number;
  pages: { path: string; buyers: number; buyerShare: number; visitors: number; visitorShare: number }[];
}

export interface PageQuality {
  path: string;
  exits: number;
  scroll: number | null;
  reachedHalf: number | null;
  reachedEnd: number | null;
  lcp: number | null;
  lcpGood: number | null;
  lcpPoor: number | null;
  lcpSamples: number;
  inp: number | null;
  inpGood: number | null;
  cls: number | null;
  clsGood: number | null;
}

export interface Issue {
  kind: 'error' | '404';
  key: string;
  detail: string | null;
  count: number;
  first_ts: number;
  last_ts: number;
  last_path: string | null;
  last_browser: string | null;
}

export interface Annotation {
  id: string;
  day: string;
  text: string;
}

export interface Me {
  loggedIn: boolean;
  hosted: boolean;
  user: {
    id: string;
    email: string | null;
    name: string | null;
    avatar: string | null;
    admin: boolean;
    paid: boolean;
    plan_status: string;
    plan_until: number | null;
  } | null;
}

export interface PlanInfo {
  hosted: boolean;
  price: string;
  interval: string;
  spots: number;
  spotsLeft: number | null;
  nextPrice: string | null;
  /** Earlier prices whose spots are all sold, oldest first. */
  soldOut?: { price: string; spots: number }[];
  checkout: boolean;
  supportEmail: string | null;
}
