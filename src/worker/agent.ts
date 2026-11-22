// Read-only access for scripts and AI agents: API tokens, the reports they can run, and an MCP endpoint.
// Everything here answers from the same bounded queries the dashboard uses, so an agent never needs to
// query the database itself.
import type { Context, Next } from 'hono';
import type { AppEnv, Site } from './env';
import { siteHealth } from './health';
import { randomId } from './lib/crypto';
import { resolveRange } from './lib/time';
import { portfolio, siteSummary } from './portfolio';
import { revenueSummary } from './revenue';
import { formStats, listIssues, pageQuality } from './signals';
import { breakdown, ctxFor, customers } from './stats';

const DAY = 86_400_000;
/** Reports that read raw visits accept at most this many days, so one call can never be a large scan. */
const MAX_RAW_DAYS = 92;
/**
 * What a token may spend per UTC day. A report costs 1, plus 1 for every day of raw visits it reads, so the
 * worst a token can do in a day stays well inside the database's daily read allowance.
 */
const DAILY_BUDGET = 1000;
/** Reports one MCP request may run. */
const MAX_CALLS_PER_REQUEST = 4;

// ---------- tokens

export async function sha256Hex(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createToken(db: D1Database, name: string, now = Date.now()) {
  const token = 'mlr_' + randomId(20);
  const id = randomId(6);
  await db
    .prepare('INSERT INTO api_tokens (id, name, token_hash, hint, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, name.trim().slice(0, 60) || 'Token', await sha256Hex(token), token.slice(-4), now)
    .run();
  return { id, token };
}

export async function listTokens(db: D1Database) {
  return (await db.prepare('SELECT id, name, hint, created_at, last_used_at FROM api_tokens ORDER BY created_at').all()).results;
}

/** Tracks what the reports of one request cost, to charge the token afterwards. */
export interface Meter {
  spent: number;
}

/** Whether the token is valid and has budget left today. Nothing is charged yet; see chargeToken. */
export async function useToken(
  db: D1Database,
  header: string | undefined,
  now = Date.now(),
): Promise<{ ok: true; id: string; used: number } | { ok: false; status: 401 | 429; error: string }> {
  const token = header?.replace(/^Bearer\s+/i, '').trim();
  if (!token || !token.startsWith('mlr_')) return { ok: false, status: 401, error: 'Send a read token: Authorization: Bearer mlr_...' };
  const row = await db
    .prepare('SELECT id, calls_day, calls FROM api_tokens WHERE token_hash = ?')
    .bind(await sha256Hex(token))
    .first<{ id: string; calls_day: number | null; calls: number }>();
  if (!row) return { ok: false, status: 401, error: 'Unknown or revoked token' };
  const used = row.calls_day === Math.floor(now / DAY) ? row.calls : 0;
  if (used >= DAILY_BUDGET) {
    return { ok: false, status: 429, error: `This token has used today's allowance (${DAILY_BUDGET}; long ranges of raw visits cost more). It resets at midnight UTC.` };
  }
  return { ok: true, id: row.id, used };
}

export function chargeToken(db: D1Database, id: string, used: number, cost: number, now = Date.now()) {
  return db
    .prepare('UPDATE api_tokens SET last_used_at = ?, calls_day = ?, calls = ? WHERE id = ?')
    .bind(now, Math.floor(now / DAY), used + Math.max(1, Math.ceil(cost)), id)
    .run();
}

/** Check the token, run the request, then charge what its reports cost (at least 1). */
export const requireToken = async (c: Context<AppEnv>, next: Next) => {
  const auth = await useToken(c.env.DB, c.req.header('authorization'));
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const meter: Meter = { spent: 0 };
  c.set('meter', meter);
  try {
    await next();
  } finally {
    await chargeToken(c.env.DB, auth.id, auth.used, meter.spent).catch(() => {});
  }
};

// ---------- reports

type Args = Record<string, unknown>;

export class ReportError extends Error {}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);

async function allSites(db: D1Database): Promise<Site[]> {
  return (await db.prepare('SELECT * FROM sites ORDER BY created_at').all<Site>()).results;
}

/** Find a site by id, domain or name. */
async function findSite(db: D1Database, ref: unknown): Promise<Site> {
  const key = str(ref)?.toLowerCase();
  if (!key) throw new ReportError('"site" is required: a site id, domain or name (see list_sites)');
  const sites = await allSites(db);
  const site =
    sites.find((s) => s.id === key) ??
    sites.find((s) => s.domain.toLowerCase() === key.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')) ??
    sites.find((s) => s.name.toLowerCase() === key);
  if (!site) throw new ReportError(`No site matches "${key}". Known sites: ${sites.map((s) => `${s.name} (${s.domain})`).join(', ')}`);
  return site;
}

function query(args: Args): Record<string, string | undefined> {
  const filters = args.filters && typeof args.filters === 'object' ? JSON.stringify(args.filters) : str(args.filters);
  return { period: str(args.period) ?? '30d', from: str(args.from), to: str(args.to), filters, attr: str(args.attribution) ?? str(args.attr) };
}

/** A range for a report that reads raw visits: refuse anything long enough to be an expensive scan, and charge for its length. */
function rawCtx(db: D1Database, site: Site, args: Args, meter?: Meter) {
  const ctx = ctxFor(db, site, query(args));
  if (ctx.range.to - ctx.range.from > MAX_RAW_DAYS * DAY + 3_600_000) {
    throw new ReportError(`This report reads individual visits, so it covers at most ${MAX_RAW_DAYS} days. Use a shorter period, or site_summary for long ranges.`);
  }
  if (meter) meter.spent += Math.ceil((ctx.range.to - ctx.range.from) / DAY);
  return ctx;
}

const publicSite = (s: Site) => ({ id: s.id, name: s.name, domain: s.domain, timezone: s.timezone, currency: s.currency, created_at: new Date(s.created_at).toISOString() });

const PERIOD = {
  type: 'string',
  description: 'today, yesterday, 7d, 30d (default), 90d, 12m, all, or custom together with from/to (YYYY-MM-DD, in the site timezone)',
};
const SITE = { type: 'string', description: 'Site id, domain or name' };

export interface Report {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run: (db: D1Database, args: Args, meter?: Meter) => Promise<unknown>;
}

export const REPORTS: Report[] = [
  {
    name: 'list_sites',
    description: 'The websites tracked by this Minilytics installation, with their timezone and currency.',
    inputSchema: { type: 'object', properties: {} },
    run: async (db) => (await allSites(db)).map(publicSite),
  },
  {
    name: 'portfolio',
    description:
      'Every site side by side for a period: visitors, visits, revenue, customers and conversion, each against the previous period, plus open alerts. Money is in minor units (cents) of each site currency. Start here for "how are the products doing".',
    inputSchema: { type: 'object', properties: { period: { type: 'string', enum: ['today', '7d', '30d', '90d', '12m'], description: 'Default 30d' } } },
    run: async (db, a) => {
      const p = await portfolio(db, await allSites(db), str(a.period) ?? '30d');
      // The daily series is for charts; an agent asked for a comparison does not need it.
      return { ...p, sites: p.sites.map(({ series: _series, ...s }) => s) };
    },
  },
  {
    name: 'site_summary',
    description:
      'One site over any range of whole days: unique visitors, visits, pageviews, bounce rate, revenue, customers and conversion, against the previous period, with a daily series. Cheap for any length of range. No filters.',
    inputSchema: { type: 'object', properties: { site: SITE, period: PERIOD, from: { type: 'string' }, to: { type: 'string' } }, required: ['site'] },
    run: async (db, a) => {
      const site = await findSite(db, a.site);
      return siteSummary(db, site, resolveRange(query(a), site.timezone, site.created_at));
    },
  },
  {
    name: 'breakdown',
    description: `Visitors, revenue and customers of one site split by a dimension. Use it for "which source / campaign / country / page made money". At most ${MAX_RAW_DAYS} days.`,
    inputSchema: {
      type: 'object',
      properties: {
        site: SITE,
        dimension: {
          type: 'string',
          enum: ['channel', 'source', 'campaign', 'keyword', 'utm_source', 'utm_medium', 'utm_content', 'ref', 'country', 'region', 'city', 'browser', 'os', 'device', 'page', 'entry_page', 'exit_page', 'exit_link', 'goal', 'hostname', 'referrer'],
        },
        period: PERIOD,
        from: { type: 'string' },
        to: { type: 'string' },
        filters: { type: 'object', description: 'Optional, e.g. {"source":"Google","country":"BR"}. Keys: channel, source, utm_campaign, utm_source, utm_medium, ref, country, device, browser, os, entry_page, page, goal.' },
        attribution: { type: 'string', enum: ['last', 'first'], description: 'Which visit gets a payment: the last one with a source (default) or the first ever.' },
        limit: { type: 'number', description: 'Rows to return, default 25' },
      },
      required: ['site', 'dimension'],
    },
    run: async (db, a, meter) => {
      const site = await findSite(db, a.site);
      const rows = await breakdown(rawCtx(db, site, a, meter), str(a.dimension) ?? 'source', 200);
      const limit = Math.max(1, Math.min(200, Number(a.limit) || 25));
      return { site: site.name, currency: site.currency, rows: rows.sort((x, y) => y.revenue - x.revenue || y.visitors - x.visitors).slice(0, limit) };
    },
  },
  {
    name: 'payments',
    description: `Payments of one site in a period with the source credited for each, how it was matched to a visitor, and time to convert. At most ${MAX_RAW_DAYS} days. Customer names and emails are not included.`,
    inputSchema: { type: 'object', properties: { site: SITE, period: PERIOD, from: { type: 'string' }, to: { type: 'string' }, attribution: { type: 'string', enum: ['last', 'first'] } }, required: ['site'] },
    run: async (db, a, meter) => {
      const site = await findSite(db, a.site);
      const rows = (await customers(rawCtx(db, site, a, meter))) as Record<string, any>[];
      return {
        site: site.name,
        currency: site.currency,
        payments: rows.map((r) => ({
          at: new Date(r.ts).toISOString(),
          amount: r.amount,
          renewal: !!r.renewal,
          source: r.source ?? null,
          first_source: r.first_source ?? null,
          last_source: r.last_source ?? null,
          campaign: r.utm_campaign ?? r.ref ?? null,
          country: r.country ?? null,
          entry_page: r.entry_page ?? null,
          matched_by: r.visitor_id ? (r.matched_by ?? 'metadata') : null,
          visits_before: r.visits ?? 0,
          days_to_convert: r.first_seen ? Math.round(((r.ts - r.first_seen) / DAY) * 10) / 10 : null,
        })),
      };
    },
  },
  {
    name: 'revenue',
    description: 'Revenue detail for one site: new versus renewal revenue and refunds in the period, estimated MRR and active subscriptions, lifetime value, and customers and revenue by source (all time).',
    inputSchema: {
      type: 'object',
      properties: { site: SITE, period: PERIOD, from: { type: 'string' }, to: { type: 'string' }, by: { type: 'string', enum: ['source', 'channel', 'campaign', 'country', 'entry_page'] }, attribution: { type: 'string', enum: ['last', 'first'] } },
      required: ['site'],
    },
    run: async (db, a) => {
      const site = await findSite(db, a.site);
      const q = query(a);
      return revenueSummary(db, site, resolveRange(q, site.timezone, site.created_at), { attr: q.attr === 'first' ? 'first' : 'last', by: str(a.by) });
    },
  },
  {
    name: 'tracking_health',
    description: 'Whether tracking works on a site: last visit, payment webhooks, share of payments linked to a visitor, events filtered as bots, and recent errors.',
    inputSchema: { type: 'object', properties: { site: SITE }, required: ['site'] },
    run: async (db, a) => siteHealth(db, await findSite(db, a.site)),
  },
  {
    name: 'page_quality',
    description: 'Per page: how far visitors scroll and Core Web Vitals (LCP, INP, CLS), plus form completion and current JavaScript errors and missing pages (404).',
    inputSchema: { type: 'object', properties: { site: SITE, period: PERIOD, from: { type: 'string' }, to: { type: 'string' } }, required: ['site'] },
    run: async (db, a) => {
      const site = await findSite(db, a.site);
      const range = resolveRange(query(a), site.timezone, site.created_at);
      const [pages, forms, issues] = await Promise.all([pageQuality(db, site, range, 50), formStats(db, site, range), listIssues(db, site)]);
      return { site: site.name, pages, forms, issues: issues.slice(0, 50) };
    },
  },
];

export async function runReport(db: D1Database, name: string, args: Args, meter?: Meter): Promise<unknown> {
  const report = REPORTS.find((r) => r.name === name);
  if (!report) throw new ReportError(`Unknown report "${name}". Available: ${REPORTS.map((r) => r.name).join(', ')}`);
  if (meter) meter.spent += 1;
  return report.run(db, args, meter);
}

// ---------- MCP (Model Context Protocol), stateless JSON-RPC over HTTP

const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
}

const INSTRUCTIONS =
  'Minilytics is revenue-first web analytics for several websites. Call `portfolio` for an overview of every site, `site_summary` for one site over time, ' +
  '`breakdown` for sources, campaigns, countries or pages, `payments` and `revenue` for who paid and what customers are worth. ' +
  'Amounts are integers in minor units (cents) of the site currency. All data is read-only.';

/** Answer one JSON-RPC message; null for notifications, which get no reply. */
export async function handleRpc(db: D1Database, msg: RpcRequest, meter?: Meter): Promise<Record<string, unknown> | null> {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
  if (msg.method.startsWith('notifications/')) return null;

  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return ok({
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'minilytics', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: REPORTS.map((r) => ({ name: r.name, description: r.description, inputSchema: r.inputSchema, annotations: { readOnlyHint: true } })),
      });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      try {
        const result = await runReport(db, name, (msg.params?.arguments as Args) ?? {}, meter);
        return ok({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (e) {
        // A tool error is a normal result the model can read and correct, not a protocol failure.
        const message = e instanceof ReportError ? e.message : `The report failed: ${(e as Error).message}`;
        return ok({ content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(c: Context<AppEnv>) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as RpcRequest[];
  // Each report is several database queries, and one request may only make so many.
  const calls = messages.filter((m) => m?.method === 'tools/call').length;
  if (messages.length > 20 || calls > MAX_CALLS_PER_REQUEST) {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `At most ${MAX_CALLS_PER_REQUEST} tool calls per request` } }, 400);
  }
  const replies = [];
  for (const m of messages) {
    const r = await handleRpc(c.env.DB, m ?? {}, c.get('meter'));
    if (r) replies.push(r);
  }
  if (!replies.length) return c.body(null, 202);
  return c.json(batch ? replies : replies[0]);
}
