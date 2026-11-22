import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { googleFaviconUrl } from '../shared/sources';
import { handleEvent } from './collect';
import { forgetSite, type AppEnv, type Site } from './env';
import { clearSession, currentUser, googleCallback, googleStart, isHosted, requireUser, setSession, siteAccessSql } from './auth';
import { billingWebhook, checkout, planInfo } from './billing';
import { createToken, handleMcp, listTokens, REPORTS, ReportError, requireToken, runReport } from './agent';
import { runScheduled, weeklyDigest } from './cron';
import { findFavicon } from './favicon';
import { siteHealth } from './health';
import { passwordsMatch, randomId } from './lib/crypto';
import { dayNumber, dayOfKey } from './lib/time';
import { getPrefs, notify, savePrefs, validWebhookUrl } from './notify';
import { handleDodoWebhook, handleGoalApi, handlePaymentApi, handleStripeWebhook, learnDodoProducts, rematchPayments } from './payments';
import { portfolio, siteSummary } from './portfolio';
import { revenueSummary } from './revenue';
import { forgetDays, loadDays } from './rollups';
import { dismissIssue, formStats, listIssues, pageQuality } from './signals';
import { breakdown, buyerPages, ctxFor, customers, funnel, makeCtx, newVsReturning, overview, realtime, retention, visitorProfile, visitors, type FunnelStep } from './stats';

const app = new Hono<AppEnv>();
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60_000;

// ---------- public: tracking, webhooks, server-side API

app.use('/api/event', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], maxAge: 86400 }));
app.post('/api/event', handleEvent);
app.post('/api/webhooks/dodo/:siteId', handleDodoWebhook);
app.post('/api/webhooks/stripe/:siteId', handleStripeWebhook);
app.post('/api/v1/payments', handlePaymentApi);
app.post('/api/v1/goals', handleGoalApi);

// ---------- read-only API and MCP server for scripts and AI agents (Authorization: Bearer mlr_...)

app.use('/api/v1/reports', requireToken);
app.use('/api/v1/reports/*', requireToken);
app.get('/api/v1/reports', (c) => c.json(REPORTS.map((r) => ({ name: r.name, description: r.description, parameters: r.inputSchema.properties }))));
app.get('/api/v1/reports/:name', async (c) => {
  const { filters, ...rest } = c.req.query();
  let parsed: unknown;
  try {
    parsed = filters ? JSON.parse(filters) : undefined;
  } catch {
    return c.json({ error: 'filters must be JSON, e.g. {"source":"Google"}' }, 400);
  }
  try {
    return c.json(await runReport(c.env.DB, c.req.param('name'), { ...rest, filters: parsed }, c.get('meter')));
  } catch (e) {
    if (e instanceof ReportError) return c.json({ error: e.message }, 400);
    throw e;
  }
});
app.post('/api/mcp', requireToken, handleMcp);
app.all('/api/mcp', (c) => c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Send JSON-RPC requests with POST' } }, 405));

// ---------- login

app.post('/api/auth/login', async (c) => {
  if (isHosted(c.env)) return c.json({ error: 'Use "Continue with Google".' }, 400);
  if (!c.env.ADMIN_PASSWORD || !c.env.SESSION_SECRET) {
    return c.json({ error: 'Set ADMIN_PASSWORD and SESSION_SECRET (see README).' }, 500);
  }
  // Lock an IP out after too many wrong passwords, so a public dashboard can't be brute-forced.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const now = Date.now();
  const recent = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND ts > ?')
    .bind(ip, now - LOCKOUT_MS)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_FAILURES) {
    return c.json({ error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429);
  }
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  if (!password || !passwordsMatch(password, c.env.ADMIN_PASSWORD)) {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO login_failures (ip, ts) VALUES (?, ?)').bind(ip, now),
      c.env.DB.prepare('DELETE FROM login_failures WHERE ts < ?').bind(now - LOCKOUT_MS),
    ]);
    await new Promise((r) => setTimeout(r, 500));
    return c.json({ error: 'Wrong password' }, 401);
  }
  await c.env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run();
  await setSession(c, 'admin');
  return c.json({ ok: true });
});

app.get('/api/auth/google', googleStart);
app.get('/api/auth/google/callback', googleCallback);

app.post('/api/auth/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => {
  const user = await currentUser(c);
  return c.json({ loggedIn: !!user, hosted: isHosted(c.env), user });
});

// ---------- billing (hosted mode)

app.get('/api/public/plan', async (c) => c.json(await planInfo(c.env)));
app.post('/api/billing/webhook', billingWebhook);
app.get('/api/billing/checkout', requireUser, checkout);

// ---------- dashboard API (login required)

app.use('/api/sites', requireUser);
app.use('/api/sites/*', requireUser);
app.use('/api/portfolio', requireUser);
app.use('/api/alerts/*', requireUser);
app.use('/api/workspace/*', requireUser);
// Notifications and tokens cover every site, so on a hosted install only the owner may touch them.
app.use('/api/workspace/*', async (c, next) => {
  if (isHosted(c.env) && !c.get('user').admin) return c.json({ error: 'Only the owner can change workspace settings' }, 403);
  await next();
});

const loadSite = async (c: Context<AppEnv>, next: Next) => {
  const access = siteAccessSql(c.env, c.get('user'));
  const site = await c.env.DB.prepare(`SELECT s.* FROM sites s WHERE s.id = ? AND ${access.sql}`)
    .bind(c.req.param('id'), ...access.params)
    .first<Site>();
  if (!site) return c.json({ error: 'site not found' }, 404);
  c.set('site', site);
  await next();
};
app.use('/api/sites/:id', loadSite);
app.use('/api/sites/:id/*', loadSite);

function cleanDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const mask = (secret: string | null | undefined) => (secret ? '••••••••' : null);
const publicSite = (s: Site) => ({ ...s, dodo_webhook_secret: mask(s.dodo_webhook_secret), stripe_webhook_secret: mask(s.stripe_webhook_secret) });

async function accessibleSites(c: Context<AppEnv>): Promise<Site[]> {
  const access = siteAccessSql(c.env, c.get('user'));
  return (await c.env.DB.prepare(`SELECT s.* FROM sites s WHERE ${access.sql} ORDER BY s.created_at`).bind(...access.params).all<Site>()).results;
}

app.get('/api/sites', async (c) => {
  const now = Date.now();
  const sites = await accessibleSites(c);
  if (!sites.length) return c.json([]);
  // Naming the sites lets the (site, time) index answer this; without them every visit ever recorded is read.
  const stats = await c.env.DB.prepare(
    `SELECT site_id, COUNT(DISTINCT visitor_id) AS visitors,
            COUNT(DISTINCT CASE WHEN last_seen_at > ? THEN visitor_id END) AS online
     FROM sessions WHERE site_id IN (${sites.map(() => '?').join(',')}) AND started_at > ? GROUP BY site_id`,
  )
    .bind(now - 5 * 60_000, ...sites.map((s) => s.id), now - 86_400_000)
    .all<{ site_id: string; visitors: number; online: number }>();
  const by = new Map(stats.results.map((r) => [r.site_id, r]));
  return c.json(
    sites.map((s) => ({
      ...publicSite(s),
      visitors24h: by.get(s.id)?.visitors ?? 0,
      online: by.get(s.id)?.online ?? 0,
    })),
  );
});

// ---------- every site on one screen, and the alerts inbox

app.get('/api/portfolio', async (c) => {
  const p = await portfolio(c.env.DB, await accessibleSites(c), c.req.query('period') ?? '30d');
  // Workspace-wide alerts (the weekly summary) are the owner's.
  if (isHosted(c.env) && !c.get('user').admin) p.alerts = p.alerts.filter((a) => a.site_id);
  return c.json(p);
});

app.post('/api/alerts/:id/dismiss', async (c) => {
  const ids = (await accessibleSites(c)).map((s) => s.id);
  const all = c.req.param('id') === 'all';
  const rows = (
    await c.env.DB.prepare(`SELECT id, site_id FROM alerts WHERE dismissed_at IS NULL${all ? '' : ' AND id = ?'} LIMIT 500`)
      .bind(...(all ? [] : [Number(c.req.param('id')) || 0]))
      .all<{ id: number; site_id: string | null }>()
  ).results.filter((a) => (a.site_id ? ids.includes(a.site_id) : !isHosted(c.env) || c.get('user').admin));
  if (rows.length) {
    await c.env.DB.prepare(`UPDATE alerts SET dismissed_at = ? WHERE id IN (${rows.map(() => '?').join(',')})`)
      .bind(Date.now(), ...rows.map((r) => r.id))
      .run();
  }
  return c.json({ ok: true, dismissed: rows.length });
});

// ---------- workspace: notifications and read tokens

const publicPrefs = (p: Awaited<ReturnType<typeof getPrefs>>) => ({ ...p, url: p.url ? p.url.replace(/^(https:\/\/[^/]+\/).*$/, '$1') + '••••••' : '', configured: !!p.url, origin: undefined });

app.get('/api/workspace/notifications', async (c) => c.json(publicPrefs(await getPrefs(c.env.DB, true))));

app.patch('/api/workspace/notifications', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const patch: Record<string, unknown> = { origin: new URL(c.req.url).origin };
  if (typeof b.url === 'string' && !b.url.includes('•')) {
    const url = b.url.trim();
    if (url && !validWebhookUrl(url)) return c.json({ error: 'Enter an https:// webhook address (Slack, Discord, Telegram, ntfy or your own)' }, 400);
    patch.url = url;
  }
  for (const k of ['sale', 'refund', 'health', 'spike', 'digest']) if (typeof b[k] === 'boolean') patch[k] = b[k];
  return c.json(publicPrefs(await savePrefs(c.env.DB, patch)));
});

app.post('/api/workspace/notifications/test', async (c) => {
  const sent = await notify(c.env.DB, 'test', '👋 Minilytics is connected', 'Sales, alerts and the weekly summary will arrive here.');
  return sent ? c.json({ ok: true }) : c.json({ error: 'The webhook did not accept the message. Check the address.' }, 400);
});

// What the weekly summary would say right now.
app.get('/api/workspace/digest', async (c) => {
  const sites = await accessibleSites(c);
  const now = Date.now();
  const { rows } = await loadDays(c.env.DB, sites, (s) => dayNumber(now, s.timezone) - 15, now);
  return c.json({ text: sites.length ? await weeklyDigest(c.env.DB, sites, rows, now) : null });
});

// Run the hourly checks now (the scheduled job does the same).
app.post('/api/workspace/run-checks', async (c) => c.json(await runScheduled(c.env, Date.now(), new URL(c.req.url).origin)));

app.get('/api/workspace/tokens', async (c) => c.json(await listTokens(c.env.DB)));
app.post('/api/workspace/tokens', async (c) => {
  const b = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens').first<{ n: number }>();
  if ((count?.n ?? 0) >= 20) return c.json({ error: 'Delete a token first (20 at most)' }, 400);
  return c.json(await createToken(c.env.DB, b.name ?? ''));
});
app.delete('/api/workspace/tokens/:tid', async (c) => {
  await c.env.DB.prepare('DELETE FROM api_tokens WHERE id = ?').bind(c.req.param('tid')).run();
  return c.json({ ok: true });
});

app.post('/api/sites', async (c) => {
  const user = c.get('user');
  if (isHosted(c.env) && !user.paid) return c.json({ error: 'Choose a plan to add websites.' }, 402);
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const domain = cleanDomain(b.domain ?? '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return c.json({ error: 'Enter a domain like example.com' }, 400);
  const tz = b.timezone && validTimezone(b.timezone) ? b.timezone : 'UTC';
  const site: Site = {
    id: randomId(8),
    name: (b.name || domain).slice(0, 100),
    domain,
    timezone: tz,
    currency: (b.currency || 'USD').toUpperCase().slice(0, 3),
    api_key: 'ml_' + randomId(16),
    dodo_webhook_secret: null,
    created_at: Date.now(),
  };
  await c.env.DB.prepare(
    'INSERT INTO sites (id, name, domain, timezone, currency, api_key, dodo_webhook_secret, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(site.id, site.name, site.domain, site.timezone, site.currency, site.api_key, null, site.created_at, isHosted(c.env) ? user.id : null)
    .run();
  return c.json(publicSite(site));
});

app.get('/api/sites/:id', (c) => c.json(publicSite(c.get('site'))));

app.patch('/api/sites/:id', async (c) => {
  const site = c.get('site');
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const next = { ...site };
  if (typeof b.name === 'string' && b.name.trim()) next.name = b.name.trim().slice(0, 100);
  if (typeof b.domain === 'string') {
    const d = cleanDomain(b.domain);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return c.json({ error: 'Enter a domain like example.com' }, 400);
    next.domain = d;
  }
  if (typeof b.timezone === 'string') {
    if (!validTimezone(b.timezone)) return c.json({ error: 'Unknown timezone' }, 400);
    next.timezone = b.timezone;
  }
  const timezoneChanged = next.timezone !== site.timezone;
  if (typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency)) next.currency = b.currency.toUpperCase();
  if (typeof b.dodo_webhook_secret === 'string' && !b.dodo_webhook_secret.includes('•')) {
    next.dodo_webhook_secret = b.dodo_webhook_secret.trim() || null;
  }
  if (typeof b.stripe_webhook_secret === 'string' && !b.stripe_webhook_secret.includes('•')) {
    next.stripe_webhook_secret = b.stripe_webhook_secret.trim() || null;
  }
  if (typeof b.stripe_app === 'string') {
    const app = b.stripe_app.trim();
    if (app && !/^[\w-]{1,64}$/.test(app)) return c.json({ error: 'Use letters, numbers, - and _ only' }, 400);
    next.stripe_app = app || null;
  }
  if (typeof b.dodo_product_ids === 'string') {
    const ids = b.dodo_product_ids.split(/[\s,]+/).filter((x) => /^pdt_[\w-]+$/.test(x));
    next.dodo_product_ids = ids.join(',') || null;
  }
  await c.env.DB.prepare(
    'UPDATE sites SET name = ?, domain = ?, timezone = ?, currency = ?, dodo_webhook_secret = ?, dodo_product_ids = ?, stripe_webhook_secret = ?, stripe_app = ? WHERE id = ?',
  )
    .bind(
      next.name,
      next.domain,
      next.timezone,
      next.currency,
      next.dodo_webhook_secret,
      next.dodo_product_ids ?? null,
      next.stripe_webhook_secret ?? null,
      next.stripe_app ?? null,
      site.id,
    )
    .run();
  forgetSite(site.id);
  // Days are counted in the site's timezone, so its daily rows are rebuilt under the new one.
  if (timezoneChanged) await forgetDays(c.env.DB, site.id);
  return c.json(publicSite(next));
});

app.get('/api/sites/:id/favicon', async (c) => {
  const { domain } = c.get('site');
  const icon = await findFavicon(domain);
  c.header('Cache-Control', 'private, max-age=3600');
  if (!icon) return c.redirect(googleFaviconUrl(domain));
  // The bytes come from the site, and an SVG opened directly would otherwise run on the dashboard's origin.
  c.header('Content-Type', icon.type);
  c.header('Content-Security-Policy', 'sandbox');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(icon.body);
});

app.post('/api/sites/:id/rotate-key', async (c) => {
  const key = 'ml_' + randomId(16);
  await c.env.DB.prepare('UPDATE sites SET api_key = ? WHERE id = ?').bind(key, c.get('site').id).run();
  return c.json({ api_key: key });
});

app.delete('/api/sites/:id', async (c) => {
  const id = c.get('site').id;
  await c.env.DB.batch(
    [
      'events', 'sessions', 'visitors', 'payments', 'funnels', 'payment_claims', 'pending_payments', 'dodo_products', 'daily_stats', 'page_metrics',
      'issues', 'form_stats', 'cloud_visits', 'webhook_status', 'alerts', 'share_links', 'annotations', 'saved_views',
    ].map((t) =>
      c.env.DB.prepare(`DELETE FROM ${t} WHERE site_id = ?`).bind(id),
    ).concat(c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(id)),
  );
  forgetSite(id);
  return c.json({ ok: true });
});

// ---------- stats

app.get('/api/sites/:id/overview', async (c) => c.json(await overview(makeCtx(c))));

app.get('/api/sites/:id/breakdown', (c) => getBreakdown(c));

// Dodo payments that couldn't be placed on a site yet, grouped by product.
app.get('/api/sites/:id/pending-payments', async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT product_id, COUNT(*) AS count, SUM(json_extract(payload, '$.amount')) AS amount, MAX(json_extract(payload, '$.currency')) AS currency
     FROM pending_payments WHERE site_id = ? GROUP BY product_id ORDER BY MAX(ts) DESC`,
  )
    .bind(c.get('site').id)
    .all();
  return c.json(r.results);
});
app.post('/api/sites/:id/pending-payments', async (c) => {
  const b = await c.req.json<{ product_id?: string }>().catch(() => ({}) as { product_id?: string });
  if (!b.product_id || !/^pdt_[\w-]+$/.test(b.product_id)) return c.json({ error: 'product_id is required' }, 400);
  await learnDodoProducts(c.env.DB, c.get('site'), [b.product_id]);
  return c.json({ ok: true });
});
app.post('/api/sites/:id/rematch', async (c) => c.json(await rematchPayments(c.env.DB, c.get('site'))));
app.get('/api/sites/:id/realtime', async (c) => c.json(await realtime(c.env.DB, c.get('site'))));
app.get('/api/sites/:id/customers', async (c) => c.json(await customers(makeCtx(c))));
app.get('/api/sites/:id/visitors', async (c) => c.json(await visitors(makeCtx(c))));
app.get('/api/sites/:id/visitors/:vid', async (c) =>
  c.json(await visitorProfile(c.env.DB, c.get('site'), c.req.param('vid'))),
);

// ---------- reports shared by the dashboard and by read-only share links

const listFunnels = async (c: Context<AppEnv>) => {
  const res = await c.env.DB.prepare('SELECT * FROM funnels WHERE site_id = ? ORDER BY created_at').bind(c.get('site').id).all();
  return c.json(res.results.map((f: any) => ({ ...f, steps: JSON.parse(f.steps) })));
};
const funnelStats = async (c: Context<AppEnv>) => {
  const f = await c.env.DB.prepare('SELECT * FROM funnels WHERE id = ? AND site_id = ?')
    .bind(c.req.param('fid'), c.get('site').id)
    .first<{ steps: string }>();
  if (!f) return c.json({ error: 'funnel not found' }, 404);
  return c.json(await funnel(makeCtx(c), JSON.parse(f.steps)));
};
const getBreakdown = async (c: Context<AppEnv>) => {
  try {
    return c.json(await breakdown(makeCtx(c), c.req.query('dim') ?? 'source', Number(c.req.query('limit')) || 100));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
};
const getRevenue = async (c: Context<AppEnv>) => {
  const ctx = makeCtx(c);
  return c.json(await revenueSummary(c.env.DB, ctx.site, ctx.range, { attr: ctx.attr, by: c.req.query('by') }));
};
const getAudience = async (c: Context<AppEnv>) => {
  const ctx = makeCtx(c);
  const [daily, cohorts] = await Promise.all([newVsReturning(ctx), retention(c.env.DB, ctx.site)]);
  return c.json({ daily, cohorts });
};
const getAnnotations = async (c: Context<AppEnv>) =>
  c.json((await c.env.DB.prepare('SELECT id, day, text FROM annotations WHERE site_id = ? ORDER BY day').bind(c.get('site').id).all()).results);
const getPageQuality = async (c: Context<AppEnv>) => c.json(await pageQuality(c.env.DB, c.get('site'), makeCtx(c).range));
const getForms = async (c: Context<AppEnv>) => c.json(await formStats(c.env.DB, c.get('site'), makeCtx(c).range));

const SHARE_MAX_DAYS = 92;

/** The stats a share link may show: totals and breakdowns, never visitors, customers or settings. */
const SHARED: Record<string, (c: Context<AppEnv>) => Promise<Response>> = {
  overview: async (c) => c.json(await overview(makeCtx(c))),
  breakdown: getBreakdown,
  funnels: listFunnels,
  revenue: getRevenue,
  audience: getAudience,
  annotations: getAnnotations,
  'page-quality': getPageQuality,
  forms: getForms,
  'buyer-pages': async (c) => c.json(await buyerPages(makeCtx(c))),
};

const loadShare = async (c: Context<AppEnv>, next: Next) => {
  const token = c.req.param('token') ?? '';
  const site = /^[\w-]{16,64}$/.test(token)
    ? await c.env.DB.prepare('SELECT s.* FROM share_links l JOIN sites s ON s.id = l.site_id WHERE l.token = ?').bind(token).first<Site>()
    : null;
  if (!site) return c.json({ error: 'This link is not valid any more' }, 404);
  c.set('site', site);
  // Anyone holding the link can call these, so one call may not read more than about three months of visits.
  const { range } = ctxFor(c.env.DB, site, c.req.query());
  if (range.to - range.from > SHARE_MAX_DAYS * 86_400_000 + 3_600_000) return c.json({ error: `A shared dashboard shows up to ${SHARE_MAX_DAYS} days at a time` }, 400);
  await next();
};
app.use('/api/share/:token', loadShare);
app.use('/api/share/:token/*', loadShare);
app.get('/api/share/:token', (c) => {
  const s = c.get('site');
  return c.json({ id: s.id, name: s.name, domain: s.domain, timezone: s.timezone, currency: s.currency, created_at: s.created_at });
});
app.get('/api/share/:token/funnels/:fid/stats', funnelStats);
app.get('/api/share/:token/:report', (c) => {
  const handler = SHARED[c.req.param('report')];
  return handler ? handler(c) : c.json({ error: 'not found' }, 404);
});

app.get('/api/sites/:id/revenue', getRevenue);
app.get('/api/sites/:id/audience', getAudience);
app.get('/api/sites/:id/buyer-pages', async (c) => c.json(await buyerPages(makeCtx(c))));
app.get('/api/sites/:id/page-quality', getPageQuality);
app.get('/api/sites/:id/forms', getForms);
app.get('/api/sites/:id/summary', async (c) => c.json(await siteSummary(c.env.DB, c.get('site'), makeCtx(c).range)));
app.get('/api/sites/:id/health', async (c) => c.json(await siteHealth(c.env.DB, c.get('site'))));

app.get('/api/sites/:id/issues', async (c) => c.json(await listIssues(c.env.DB, c.get('site'))));
app.delete('/api/sites/:id/issues', async (c) => {
  const b = await c.req.json<{ kind?: string; key?: string }>().catch(() => ({}) as { kind?: string; key?: string });
  await dismissIssue(c.env.DB, c.get('site'), b.kind ?? null, b.key ?? null);
  return c.json({ ok: true });
});

app.get('/api/sites/:id/annotations', getAnnotations);
app.post('/api/sites/:id/annotations', async (c) => {
  const b = await c.req.json<{ day?: string; text?: string }>().catch(() => ({}) as { day?: string; text?: string });
  const text = b.text?.trim().slice(0, 200);
  if (!b.day || !/^\d{4}-\d{2}-\d{2}$/.test(b.day) || !Number.isFinite(dayOfKey(b.day)) || !text) return c.json({ error: 'A note needs a date and a text' }, 400);
  const id = randomId(8);
  await c.env.DB.prepare('INSERT INTO annotations (id, site_id, day, text, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, c.get('site').id, b.day, text, Date.now()).run();
  return c.json({ id, day: b.day, text });
});
app.delete('/api/sites/:id/annotations/:aid', async (c) => {
  await c.env.DB.prepare('DELETE FROM annotations WHERE id = ? AND site_id = ?').bind(c.req.param('aid'), c.get('site').id).run();
  return c.json({ ok: true });
});

app.get('/api/sites/:id/views', async (c) =>
  c.json((await c.env.DB.prepare('SELECT id, name, query FROM saved_views WHERE site_id = ? ORDER BY created_at').bind(c.get('site').id).all()).results),
);
app.post('/api/sites/:id/views', async (c) => {
  const b = await c.req.json<{ name?: string; query?: string }>().catch(() => ({}) as { name?: string; query?: string });
  const name = b.name?.trim().slice(0, 60);
  if (!name || typeof b.query !== 'string') return c.json({ error: 'A view needs a name' }, 400);
  const id = randomId(8);
  await c.env.DB.prepare('INSERT INTO saved_views (id, site_id, name, query, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, c.get('site').id, name, b.query.replace(/^\?/, '').slice(0, 2000), Date.now())
    .run();
  return c.json({ id, name, query: b.query });
});
app.delete('/api/sites/:id/views/:vid', async (c) => {
  await c.env.DB.prepare('DELETE FROM saved_views WHERE id = ? AND site_id = ?').bind(c.req.param('vid'), c.get('site').id).run();
  return c.json({ ok: true });
});

app.get('/api/sites/:id/shares', async (c) =>
  c.json((await c.env.DB.prepare('SELECT token, name, created_at FROM share_links WHERE site_id = ? ORDER BY created_at').bind(c.get('site').id).all()).results),
);
app.post('/api/sites/:id/shares', async (c) => {
  const b = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const token = randomId(16);
  const name = b.name?.trim().slice(0, 60) || 'Shared link';
  await c.env.DB.prepare('INSERT INTO share_links (token, site_id, name, created_at) VALUES (?, ?, ?, ?)').bind(token, c.get('site').id, name, Date.now()).run();
  return c.json({ token, name });
});
app.delete('/api/sites/:id/shares/:token', async (c) => {
  await c.env.DB.prepare('DELETE FROM share_links WHERE token = ? AND site_id = ?').bind(c.req.param('token'), c.get('site').id).run();
  return c.json({ ok: true });
});

app.get('/api/sites/:id/funnels', listFunnels);

app.post('/api/sites/:id/funnels', async (c) => {
  const b = await c.req.json<{ name?: string; steps?: FunnelStep[] }>().catch(() => ({}) as { name?: string; steps?: FunnelStep[] });
  const steps = (b.steps ?? [])
    .filter((s) => (s.type === 'page' || s.type === 'goal') && typeof s.value === 'string' && s.value.trim())
    .slice(0, 10)
    .map((s) => ({ type: s.type, value: s.value.trim().slice(0, 200) }));
  if (!b.name?.trim() || steps.length < 2) return c.json({ error: 'A funnel needs a name and at least 2 steps' }, 400);
  const id = randomId(8);
  await c.env.DB.prepare('INSERT INTO funnels (id, site_id, name, steps, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, c.get('site').id, b.name.trim().slice(0, 100), JSON.stringify(steps), Date.now())
    .run();
  return c.json({ id, name: b.name.trim(), steps });
});

app.delete('/api/sites/:id/funnels/:fid', async (c) => {
  await c.env.DB.prepare('DELETE FROM funnels WHERE id = ? AND site_id = ?').bind(c.req.param('fid'), c.get('site').id).run();
  return c.json({ ok: true });
});

app.get('/api/sites/:id/funnels/:fid/stats', funnelStats);

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// Everything else is the dashboard (static files).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // Hourly (see "triggers" in wrangler.jsonc).
  async scheduled(_event: ScheduledController, env: AppEnv['Bindings'], ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const origin = (await getPrefs(env.DB).catch(() => null))?.origin ?? '';
        const report = await runScheduled(env, Date.now(), origin);
        if (report.errors.length) console.error('scheduled', JSON.stringify(report));
      })(),
    );
  },
};

export { app };
