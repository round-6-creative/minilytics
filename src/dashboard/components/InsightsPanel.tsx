import { useState } from 'react';
import { api, qs, type Audience, type BuyerPages, type Issue, type PageQuality } from '../lib/api';
import { useDash } from '../lib/context';
import { fmtAgo, fmtNumber, fmtPct } from '../lib/format';
import { useApi } from '../lib/useApi';

type Tab = 'pages' | 'retention' | 'buyers' | 'forms' | 'issues';

const LABELS: Record<Tab, string> = {
  pages: 'Scroll & speed',
  retention: 'Retention',
  buyers: 'What buyers read',
  forms: 'Forms',
  issues: 'Errors & 404s',
};

const Empty = ({ children }: { children: React.ReactNode }) => <div className="p-8 text-center text-sm text-stone-500">{children}</div>;
const Loading = () => <div className="h-40 animate-pulse" />;

/** How well the site works for the people who reach it: engagement and speed per page, who comes back, what buyers read, forms, errors. */
export function InsightsPanel() {
  const { readonly } = useDash();
  const tabs: Tab[] = readonly ? ['pages', 'retention', 'buyers', 'forms'] : ['pages', 'retention', 'buyers', 'forms', 'issues'];
  const [tab, setTab] = useState<Tab>('pages');
  return (
    <div className="card p-3">
      <div className="pb-3">
        <div className="tabs overflow-x-auto">
          {tabs.map((t) => (
            <button key={t} className={`tab whitespace-nowrap ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
              {LABELS[t]}
            </button>
          ))}
        </div>
      </div>
      {tab === 'pages' && <Pages />}
      {tab === 'retention' && <Retention />}
      {tab === 'buyers' && <Buyers />}
      {tab === 'forms' && <Forms />}
      {tab === 'issues' && <Issues />}
    </div>
  );
}

/** Green, amber or red by the share of visits that were good. */
function Rated({ value, good, format }: { value: number | null; good: number | null; format: (v: number) => string }) {
  if (value === null) return <span className="text-stone-300">—</span>;
  const tone = good === null ? 'text-stone-700' : good >= 0.75 ? 'text-emerald-600' : good >= 0.5 ? 'text-amber-600' : 'text-red-500';
  return (
    <span className={tone} title={good === null ? undefined : `${fmtPct(good)} of visits were good`}>
      {format(value)}
    </span>
  );
}

function Pages() {
  const { base, q, reloadKey, addFilter } = useDash();
  const { data } = useApi<PageQuality[]>(`${base}/page-quality?${qs(q)}`, reloadKey);
  if (!data) return <Loading />;
  if (!data.length)
    return <Empty>No measurements in this period yet. They start arriving once visitors load the current script (it refreshes within an hour of an update).</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="text-left text-stone-500">
            <th className="px-3 pb-2 font-medium">Page</th>
            <th className="pb-2 text-right font-medium">Measured</th>
            <th className="pb-2 text-right font-medium" title="Average of the deepest point each visitor reached">Scrolled</th>
            <th className="pb-2 text-right font-medium" title="Visitors who reached the end of the page">Read to the end</th>
            <th className="pb-2 text-right font-medium" title="Largest contentful paint: when the main content appeared. Good is 2.5 s or less.">Loads in</th>
            <th className="pb-2 text-right font-medium" title="Interaction to next paint: how long the page takes to react to a click or key. Good is 200 ms or less.">Reacts in</th>
            <th className="px-3 pb-2 text-right font-medium" title="Cumulative layout shift: how much the page jumps while loading. Good is 0.1 or less.">Layout shift</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.path} className="cursor-pointer border-t border-stone-100 hover:bg-stone-50" onClick={() => addFilter('page', r.path)} title="Filter by visitors who saw this page">
              <td className="max-w-[340px] truncate px-3 py-2 font-medium">{r.path}</td>
              <td className="py-2 text-right text-stone-500">{fmtNumber(Math.max(r.exits, r.lcpSamples))}</td>
              <td className="py-2 text-right">{r.scroll === null ? '—' : `${Math.round(r.scroll)}%`}</td>
              <td className="py-2 text-right">{r.reachedEnd === null ? '—' : fmtPct(r.reachedEnd)}</td>
              <td className="py-2 text-right">
                <Rated value={r.lcp} good={r.lcpGood} format={(v) => `${(v / 1000).toFixed(1)} s`} />
              </td>
              <td className="py-2 text-right">
                <Rated value={r.inp} good={r.inpGood} format={(v) => `${Math.round(v)} ms`} />
              </td>
              <td className="px-3 py-2 text-right">
                <Rated value={r.cls} good={r.clsGood} format={(v) => v.toFixed(2)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 pt-3 text-xs text-stone-400">Speed is measured in visitors’ own browsers. Green means at least three in four visits were good, red fewer than half.</p>
    </div>
  );
}

function Retention() {
  const { base, q, reloadKey } = useDash();
  const { data } = useApi<Audience>(`${base}/audience?${qs(q)}`, reloadKey);
  if (!data) return <Loading />;
  const max = Math.max(1, ...data.daily.map((d) => d.new + d.returning));
  const returning = data.daily.reduce((a, d) => a + d.returning, 0);
  const all = data.daily.reduce((a, d) => a + d.new + d.returning, 0);
  const weeks = Math.max(0, ...data.cohorts.map((c) => c.active.length));
  const day = (s: string) => new Date(s + 'T00:00:00Z').toLocaleDateString('en', { day: 'numeric', month: 'short', timeZone: 'UTC' });

  return (
    <div className="grid gap-6 px-3 pb-2 lg:grid-cols-2">
      <div>
        <div className="mb-1 text-sm font-medium text-stone-600">New and returning visitors per day</div>
        <div className="mb-3 text-xs text-stone-500">
          {all ? `${fmtPct(returning / all)} of daily visits in this period were people who had been here before.` : 'No visits in this period.'}
        </div>
        <div className="flex h-40 items-end gap-px">
          {data.daily.map((d) => (
            <div key={d.day} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end">
              <div className="bg-revenue/70" style={{ height: `${(d.returning / max) * 100}%` }} />
              <div className="rounded-t-sm bg-visitors" style={{ height: `${(d.new / max) * 100}%`, minHeight: d.new ? 1 : 0 }} />
              <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-xs text-white group-hover:block">
                {day(d.day)}: {d.new} new, {d.returning} returning
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-4 text-xs text-stone-500">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-visitors" /> New
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-revenue/70" /> Returning
          </span>
        </div>
      </div>

      <div>
        <div className="mb-1 text-sm font-medium text-stone-600">Who came back, by the week they first visited</div>
        <div className="mb-3 text-xs text-stone-500">Each row is one week’s new visitors; each column is how many of them visited again that many weeks later.</div>
        {!data.cohorts.some((c) => c.size) ? (
          <div className="py-6 text-sm text-stone-400">Not enough history yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-stone-500">
                  <th className="pb-1 pr-2 text-left font-medium">First visit</th>
                  <th className="pb-1 pr-2 text-right font-medium">Visitors</th>
                  {Array.from({ length: weeks - 1 }, (_, i) => (
                    <th key={i} className="pb-1 text-center font-medium">
                      +{i + 1}w
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.cohorts.map((c) => (
                  <tr key={c.week}>
                    <td className="whitespace-nowrap py-0.5 pr-2 text-stone-600">Week of {day(c.week)}</td>
                    <td className="py-0.5 pr-2 text-right font-medium">{fmtNumber(c.size)}</td>
                    {Array.from({ length: weeks - 1 }, (_, i) => {
                      const n = c.active[i + 1];
                      if (n === undefined) return <td key={i} />;
                      const share = c.size ? n / c.size : 0;
                      return (
                        <td key={i} className="p-0.5">
                          <div
                            className="rounded px-1 py-1 text-center text-stone-800"
                            style={{ background: `rgba(141, 189, 240, ${Math.min(1, share * 4 + (n ? 0.08 : 0))})` }}
                            title={`${n} of ${c.size} came back`}
                          >
                            {c.size ? fmtPct(share, share < 0.1 && share > 0 ? 1 : 0) : '—'}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Buyers() {
  const { base, q, reloadKey, addFilter } = useDash();
  const { data } = useApi<BuyerPages>(`${base}/buyer-pages?${qs(q)}`, reloadKey);
  if (!data) return <Loading />;
  if (!data.buyers) return <Empty>No new customer in this period is linked to a visit, so there is nothing to compare yet.</Empty>;
  return (
    <div className="overflow-x-auto">
      <p className="px-3 pb-3 text-sm text-stone-500">
        Pages the {data.buyers} new customer{data.buyers === 1 ? '' : 's'} of this period saw before paying, next to how many of all {fmtNumber(data.visitors)} visitors saw them. A page most
        buyers read and few visitors find is worth sending more people to.
      </p>
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="text-left text-stone-500">
            <th className="px-3 pb-2 font-medium">Page</th>
            <th className="pb-2 text-right font-medium">Buyers who saw it</th>
            <th className="pb-2 text-right font-medium">All visitors who saw it</th>
            <th className="px-3 pb-2 text-right font-medium" title="Share of buyers divided by share of all visitors">Buyers vs visitors</th>
          </tr>
        </thead>
        <tbody>
          {data.pages.map((p) => {
            const lift = p.visitorShare ? p.buyerShare / p.visitorShare : null;
            return (
              <tr key={p.path} className="cursor-pointer border-t border-stone-100 hover:bg-stone-50" onClick={() => addFilter('page', p.path)}>
                <td className="max-w-[340px] truncate px-3 py-2 font-medium">{p.path}</td>
                <td className="py-2 text-right">
                  {fmtPct(p.buyerShare)} <span className="text-stone-400">({p.buyers})</span>
                </td>
                <td className="py-2 text-right">
                  {fmtPct(p.visitorShare)} <span className="text-stone-400">({fmtNumber(p.visitors)})</span>
                </td>
                <td className={`px-3 py-2 text-right font-medium ${lift !== null && lift >= 1.5 ? 'text-emerald-600' : 'text-stone-600'}`}>{lift === null ? '—' : `${lift.toFixed(1)}×`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Forms() {
  const { base, q, reloadKey } = useDash();
  const { data } = useApi<{ form: string; starts: number; submits: number }[]>(`${base}/forms?${qs(q)}`, reloadKey);
  if (!data) return <Loading />;
  if (!data.length)
    return (
      <Empty>
        No form activity in this period. Forms are tracked automatically; name one with <code className="rounded bg-stone-100 px-1">data-ml-form="signup"</code>, or skip one with{' '}
        <code className="rounded bg-stone-100 px-1">data-ml-ignore</code>.
      </Empty>
    );
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-stone-500">
          <th className="px-3 pb-2 font-medium">Form</th>
          <th className="pb-2 text-right font-medium" title="Visitors who typed something in it">Started</th>
          <th className="pb-2 text-right font-medium">Submitted</th>
          <th className="px-3 pb-2 text-right font-medium">Completed</th>
        </tr>
      </thead>
      <tbody>
        {data.map((f) => {
          // A form submitted without typing (a single button, autofill) has more submits than starts.
          const rate = f.starts ? Math.min(1, f.submits / f.starts) : null;
          return (
            <tr key={f.form} className="border-t border-stone-100">
              <td className="px-3 py-2 font-medium">{f.form}</td>
              <td className="py-2 text-right">{fmtNumber(f.starts)}</td>
              <td className="py-2 text-right">{fmtNumber(f.submits)}</td>
              <td className={`px-3 py-2 text-right font-medium ${rate !== null && rate < 0.5 ? 'text-red-500' : ''}`}>{rate === null ? '—' : fmtPct(rate)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Issues() {
  const { base } = useDash();
  const [version, setVersion] = useState(0);
  const { data } = useApi<Issue[]>(`${base}/issues`, version);
  if (!data) return <Loading />;
  if (!data.length) return <Empty>No JavaScript errors or missing pages seen in the last month.</Empty>;
  const dismiss = async (body: { kind?: string; key?: string }) => {
    await api(`${base}/issues`, { method: 'DELETE', json: body });
    setVersion((v) => v + 1);
  };
  const section = (kind: Issue['kind'], title: string, hint: string) => {
    const rows = data.filter((i) => i.kind === kind);
    if (!rows.length) return null;
    return (
      <div className="mb-4">
        <div className="flex items-baseline justify-between px-3 pb-1">
          <div className="text-sm font-medium text-stone-600">
            {title} <span className="font-normal text-stone-400">· {hint}</span>
          </div>
          <button className="text-xs text-stone-400 hover:text-ink" onClick={() => dismiss({ kind })}>
            Clear all
          </button>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {rows.map((i) => (
              <tr key={i.key} className="border-t border-stone-100 align-top">
                <td className="px-3 py-2">
                  <div className="break-all font-medium">{i.key}</div>
                  <div className="break-all text-xs text-stone-500">
                    {kind === '404' ? (i.detail ? `linked from ${i.detail}` : 'opened directly') : [i.detail, i.last_path && `on ${i.last_path}`, i.last_browser].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td className="whitespace-nowrap py-2 text-right">{fmtNumber(i.count)}×</td>
                <td className="whitespace-nowrap px-3 py-2 text-right text-stone-500">{fmtAgo(Date.now() - i.last_ts)} ago</td>
                <td className="py-2 pr-3 text-right">
                  <button className="rounded-lg px-1.5 text-stone-400 hover:bg-stone-100 hover:text-ink" onClick={() => dismiss({ kind, key: i.key })} title="Dismiss (it comes back if it happens again)">
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };
  return (
    <div>
      {section('404', 'Missing pages', 'visitors landed on a page that does not exist')}
      {section('error', 'JavaScript errors', 'something broke in a visitor’s browser')}
    </div>
  );
}
