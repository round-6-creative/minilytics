import { useEffect, useState } from 'react';
import { navigate, useMe } from '../App';
import { Favicon } from '../components/Icons';
import { Logo } from '../components/Logo';
import { Modal } from '../components/Modal';
import { api, type Portfolio, type PortfolioSite, type Site } from '../lib/api';
import { fmtAgo, fmtMoney, fmtNumber, fmtPct } from '../lib/format';
import { useApi } from '../lib/useApi';

const PERIODS = [
  { value: 'today', label: 'Today', previous: 'yesterday' },
  { value: '7d', label: '7 days', previous: 'the 7 days before' },
  { value: '30d', label: '30 days', previous: 'the 30 days before' },
  { value: '90d', label: '90 days', previous: 'the 90 days before' },
  { value: '12m', label: '12 months', previous: 'the year before' },
];

function Change({ cur, prev }: { cur: number; prev: number }) {
  // Nothing to compare with (the site is younger than the period before).
  if (!prev) return <span className="text-xs text-stone-400">—</span>;
  const pct = (cur - prev) / prev;
  const up = pct >= 0;
  return (
    <span className={`text-xs ${up ? 'text-emerald-600' : 'text-red-500'}`}>
      {Math.abs(Math.round(pct * 100))}% {up ? '↑' : '↓'}
    </span>
  );
}

/** Visitors as an area and revenue as bars, one point per day. */
function Sparkline({ series }: { series: PortfolioSite['series'] }) {
  const W = 240;
  const H = 48;
  const n = series.length;
  if (n < 2) return <div style={{ height: H }} />;
  const maxV = Math.max(1, ...series.map((d) => d.visitors));
  const maxR = Math.max(1, ...series.map((d) => d.revenue));
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => H - 2 - (v / maxV) * (H - 6);
  const line = series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.visitors).toFixed(1)}`).join(' ');
  const bar = W / n;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-12 w-full" aria-hidden>
      {series.map((d, i) =>
        d.revenue > 0 ? <rect key={i} x={x(i) - bar * 0.3} y={H - (d.revenue / maxR) * (H * 0.55)} width={bar * 0.6} height={(d.revenue / maxR) * (H * 0.55)} fill="#e07b5f" opacity={0.75} rx={1} /> : null,
      )}
      <path d={`${line} L${W},${H} L0,${H} Z`} fill="#8dbdf0" opacity={0.18} />
      <path d={line} fill="none" stroke="#7cb1ea" strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

const ALERT_TONE: Record<string, string> = {
  tracking: 'border-amber-200 bg-amber-50 text-amber-900',
  webhook: 'border-amber-200 bg-amber-50 text-amber-900',
  spike: 'border-sky-200 bg-sky-50 text-sky-900',
  digest: 'border-stone-200 bg-white text-stone-800',
};

export function Sites() {
  const { me } = useMe();
  const [period, setPeriod] = useState(() => {
    try {
      return localStorage.getItem('ml_portfolio_period') || '30d';
    } catch {
      return '30d';
    }
  });
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const { data, error } = useApi<Portfolio>(`/api/portfolio?period=${period}`, version);
  const sites = data?.sites;

  useEffect(() => {
    if (sites && !sites.length) setAdding(true);
  }, [sites]);
  // Keep "online now" and today's numbers current while the page is open.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && setVersion((v) => v + 1), 5 * 60_000);
    return () => clearInterval(t);
  }, []);

  function choose(p: string) {
    setPeriod(p);
    try {
      localStorage.setItem('ml_portfolio_period', p);
    } catch {}
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    window.dispatchEvent(new Event('ml:logout'));
  }

  async function dismiss(id: number | 'all') {
    await api(`/api/alerts/${id}/dismiss`, { method: 'POST' });
    setVersion((v) => v + 1);
  }

  const t = data?.totals;
  const prevLabel = PERIODS.find((p) => p.value === period)?.previous ?? 'the period before';
  const ordered = [...(sites ?? [])].sort((a, b) => b.current.revenue - a.current.revenue || b.current.visitors - a.current.visitors);
  const nameOf = (id: string | null) => sites?.find((s) => s.id === id)?.name;
  const totalRevenue = (key: 'current' | 'previous') =>
    t && t.revenue[key] !== null ? fmtMoney(t.revenue[key]!, t.revenue.currency, t.revenue.decimals, true) : null;
  const mixed = (t?.revenueByCurrency.length ?? 0) > 1;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Logo />
        <div className="flex items-center gap-2">
          {me.hosted && me.user && (
            <button className="hidden items-center gap-2 rounded-xl px-2 py-1 text-sm text-stone-600 hover:bg-stone-100 sm:flex" onClick={() => navigate('/billing')} title="Plan & billing">
              {me.user.avatar ? <img src={me.user.avatar} alt="" className="h-7 w-7 rounded-full" referrerPolicy="no-referrer" /> : null}
              {me.user.email}
            </button>
          )}
          {(!me.hosted || me.user?.admin) && (
            <button className="btn" onClick={() => navigate('/settings')} title="Notifications, API tokens and AI agents">
              ⚙️ Workspace
            </button>
          )}
          <button className="btn" onClick={logout}>
            Log out
          </button>
          <button className="btn-dark" onClick={() => setAdding(true)}>
            + Add website
          </button>
        </div>
      </div>

      <div className="mt-10 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold">Your websites</h1>
        <div className="tabs max-w-full overflow-x-auto">
          {PERIODS.map((p) => (
            <button key={p.value} className={`tab whitespace-nowrap ${p.value === period ? 'tab-active' : ''}`} onClick={() => choose(p.value)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {t && sites && sites.length > 1 && (
        <div className="card mt-5 grid grid-cols-2 divide-stone-100 sm:grid-cols-4 sm:divide-x">
          <div className="px-5 py-4">
            <div className="text-sm text-stone-500">Revenue{mixed ? `, in ${t.revenue.currency}` : ''}</div>
            <div className="mt-1 text-[28px] font-semibold leading-tight tracking-tight">
              {totalRevenue('current') ?? t.revenueByCurrency.map((r) => fmtMoney(r.amount, r.currency, r.decimals, true)).join(' + ') ?? '—'}
            </div>
            {t.revenue.current !== null && t.revenue.previous !== null ? <Change cur={t.revenue.current} prev={t.revenue.previous} /> : <span className="text-xs text-stone-400">—</span>}
          </div>
          <div className="px-5 py-4">
            <div className="text-sm text-stone-500">Visitors</div>
            <div className="mt-1 text-[28px] font-semibold leading-tight tracking-tight">{fmtNumber(t.current.visitors)}</div>
            <Change cur={t.current.visitors} prev={t.previous.visitors} />
          </div>
          <div className="px-5 py-4">
            <div className="text-sm text-stone-500">New customers</div>
            <div className="mt-1 text-[28px] font-semibold leading-tight tracking-tight">{fmtNumber(t.current.customers)}</div>
            <Change cur={t.current.customers} prev={t.previous.customers} />
          </div>
          <div className="px-5 py-4">
            <div className="flex items-center gap-1.5 text-sm text-stone-500">
              Online now <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
            </div>
            <div className="mt-1 text-[28px] font-semibold leading-tight tracking-tight">{t.online}</div>
            <span className="text-xs text-stone-400">across {sites.length} sites</span>
          </div>
        </div>
      )}
      {t && sites && sites.length > 1 && (
        <p className="mt-2 px-1 text-xs text-stone-400">
          Changes compare with {prevLabel}. Visitors are counted per site, so someone who visits two sites counts twice.
          {mixed && t.revenue.current !== null ? ` Other currencies are converted at today’s reference rate.` : ''}
        </p>
      )}

      {data && data.alerts.length > 0 && (
        <div className="mt-5 space-y-2">
          <div className="flex items-center justify-between px-1">
            <div className="text-sm font-medium text-stone-600">Alerts</div>
            <button className="text-xs text-stone-400 hover:text-ink" onClick={() => dismiss('all')}>
              Dismiss all
            </button>
          </div>
          {data.alerts.slice(0, 6).map((a) => (
            <div key={a.id} className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${ALERT_TONE[a.kind] ?? ALERT_TONE.digest} ${a.resolved_at && a.kind !== 'digest' && a.kind !== 'spike' ? 'opacity-60' : ''}`}>
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {a.title}
                  {a.resolved_at && (a.kind === 'tracking' || a.kind === 'webhook') ? ' (resolved)' : ''}
                </div>
                {a.body && <div className="mt-0.5 whitespace-pre-line opacity-80">{a.body}</div>}
                <div className="mt-1 text-xs opacity-60">
                  {fmtAgo(Date.now() - a.ts)} ago
                  {a.site_id && nameOf(a.site_id) && (
                    <>
                      {' · '}
                      <button className="underline underline-offset-2" onClick={() => navigate(a.kind === 'webhook' || a.kind === 'tracking' ? `/site/${a.site_id}/settings` : `/site/${a.site_id}`)}>
                        Open {nameOf(a.site_id)}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <button className="rounded-lg px-1.5 opacity-50 hover:bg-black/5 hover:opacity-100" onClick={() => dismiss(a.id)} aria-label="Dismiss">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {!data && !error && [0, 1, 2].map((i) => <div key={i} className="card h-[218px] animate-pulse" />)}
        {ordered.map((s) => {
          const money = (v: number) => fmtMoney(v, s.currency, s.decimals, true);
          return (
            <button key={s.id} onClick={() => navigate(`/site/${s.id}?period=${period}`)} className="card p-5 text-left transition hover:-translate-y-0.5 hover:shadow-md">
              <div className="flex items-center gap-3">
                <Favicon domain={s.domain} siteId={s.id} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{s.name}</div>
                  <div className="truncate text-sm text-stone-500">{s.domain}</div>
                </div>
                {s.alerts > 0 && (
                  <span className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800" title="An open alert needs attention">
                    ⚠️ {s.alerts}
                  </span>
                )}
                <div className="flex shrink-0 items-center gap-1.5 text-sm text-stone-600" title="Visitors on the site right now">
                  <span className={`h-2 w-2 rounded-full ${s.online ? 'animate-pulse bg-green-500' : 'bg-stone-300'}`} />
                  {s.online}
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <div>
                  <div className="text-xs text-stone-500">Revenue</div>
                  <div className={`text-xl font-semibold tracking-tight ${s.current.revenue > 0 ? 'text-revenue' : ''}`}>{money(s.current.revenue)}</div>
                  <Change cur={s.current.revenue} prev={s.previous.revenue} />
                </div>
                <div>
                  <div className="text-xs text-stone-500">Visitors</div>
                  <div className="text-xl font-semibold tracking-tight">{fmtNumber(s.current.visitors)}</div>
                  <Change cur={s.current.visitors} prev={s.previous.visitors} />
                </div>
                <div>
                  <div className="text-xs text-stone-500">Conversion</div>
                  <div className="text-xl font-semibold tracking-tight">{s.current.customers ? fmtPct(s.current.conversionRate, s.current.conversionRate >= 0.1 ? 0 : 2) : '—'}</div>
                  <span className="text-xs text-stone-400">
                    {s.current.customers} customer{s.current.customers === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
              <div className="mt-3">
                <Sparkline series={s.series} />
              </div>
            </button>
          );
        })}
        {sites && !sites.length && (
          <div className="card col-span-full p-10 text-center text-stone-500">No websites yet. Add your first one to get a tracking snippet.</div>
        )}
      </div>
      {data && !data.complete && <p className="mt-3 text-center text-xs text-stone-400">Older days are still being added up; the numbers for long periods fill in within the hour.</p>}
      <AddSite open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'SGD', 'JPY', 'BRL'];

function AddSite({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const site = await api<Site>('/api/sites', { method: 'POST', json: { domain, name, timezone, currency } });
      navigate(`/site/${site.id}/settings`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a website" width="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Domain</label>
          <input className="input" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} autoFocus />
          <p className="mt-1 text-xs text-stone-500">Subdomains (app.example.com) are tracked under the same site.</p>
        </div>
        <div>
          <label className="label">Name</label>
          <input className="input" placeholder="My SaaS" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Timezone</label>
            <input className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </div>
          <div>
            <label className="label">Revenue currency</label>
            <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-dark w-full" disabled={!domain}>
          Add website
        </button>
      </form>
    </Modal>
  );
}
