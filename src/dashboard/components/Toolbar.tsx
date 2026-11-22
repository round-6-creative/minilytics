import { useEffect, useRef, useState, type ReactNode } from 'react';
import { navigate } from '../App';
import { api, type Overview, type Query, type Site } from '../lib/api';
import { dayInTz } from '../lib/format';
import { useApi } from '../lib/useApi';
import { Favicon } from './Icons';

/** A shared link shows at most about three months at a time. */
const SHARED_PERIODS = ['today', 'yesterday', '24h', '48h', '7d', '30d', '90d'];

interface SavedView {
  id: string;
  name: string;
  query: string;
}

export const PERIODS: { value: string; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '48h', label: 'Last 2 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '12m', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
];

const GRANULARITIES = [
  { value: 'hour', label: 'Hourly' },
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];

export function Dropdown({ button, children, align = 'left' }: { button: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [open]);
  return (
    <div className="relative flex" ref={ref}>
      <div className="flex" onClick={() => setOpen((o) => !o)}>
        {button}
      </div>
      {open && (
        <div className={`card absolute top-full z-40 mt-2 min-w-[200px] overflow-hidden p-1 ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const Chevron = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-400">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

function itemCls(active: boolean) {
  return `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-stone-100 ${active ? 'font-medium text-ink' : 'text-stone-600'}`;
}

export function Toolbar({
  site,
  sites,
  q,
  update,
  overview,
  onRefresh,
  onLive,
  loading,
  readonly = false,
  base,
}: {
  readonly?: boolean;
  base: string;
  site: Site;
  sites: Site[];
  q: Query;
  update: (p: Partial<Query>) => void;
  overview: Overview | null;
  onRefresh: () => void;
  onLive: () => void;
  loading: boolean;
}) {
  const [from, setFrom] = useState(q.from ?? '');
  const [to, setTo] = useState(q.to ?? '');
  const [viewsVersion, setViewsVersion] = useState(0);
  const { data: views } = useApi<SavedView[]>(readonly ? null : `${base}/views`, viewsVersion);
  const periods = readonly ? PERIODS.filter((p) => SHARED_PERIODS.includes(p.value)) : PERIODS;

  async function saveView() {
    const name = prompt('Name this view (the current period and filters are saved)');
    if (!name?.trim()) return;
    await api(`${base}/views`, { method: 'POST', json: { name, query: window.location.search.replace(/^\?/, '') } });
    setViewsVersion((v) => v + 1);
  }

  const label =
    q.period === 'custom'
      ? q.from === q.to
        ? new Date(q.from + 'T00:00:00Z').toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
        : `${q.from} → ${q.to}`
      : PERIODS.find((p) => p.value === q.period)?.label ?? 'Last 30 days';

  function shift(dir: -1 | 1) {
    if (!overview) return;
    const { from, to } = overview.range;
    const span = Math.max(to - from, 86_400_000);
    const nf = from + dir * span;
    const nt = nf + span - 1;
    if (nf > Date.now()) return;
    update({ period: 'custom', from: dayInTz(nf, site.timezone), to: dayInTz(Math.min(nt, Date.now()), site.timezone) });
  }
  const canForward = overview ? overview.range.to < Date.now() - 60_000 : false;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {readonly ? (
        <div className="btn h-11 cursor-default px-4 text-base hover:bg-white">
          <Favicon domain={site.domain} size={22} />
          <span className="max-w-[220px] truncate font-semibold">{site.name}</span>
        </div>
      ) : (
      <Dropdown
        button={
          <button className="btn h-11 px-4 text-base">
            <Favicon domain={site.domain} siteId={site.id} size={22} />
            <span className="max-w-[180px] truncate font-semibold">{site.name}</span>
            <Chevron />
          </button>
        }
      >
        {(close) => (
          <>
            {sites.map((s) => (
              <button
                key={s.id}
                className={itemCls(s.id === site.id)}
                onClick={() => {
                  close();
                  navigate(`/site/${s.id}${window.location.search}`);
                }}
              >
                <Favicon domain={s.domain} siteId={s.id} size={16} /> {s.name}
              </button>
            ))}
            <div className="my-1 border-t border-stone-100" />
            <button className={itemCls(false)} onClick={() => navigate(`/site/${site.id}/settings`)}>
              ⚙️ Site settings & install
            </button>
            <button className={itemCls(false)} onClick={() => navigate('/')}>
              ← All websites
            </button>
          </>
        )}
      </Dropdown>
      )}

      <div className="flex h-11 items-stretch rounded-xl border border-stone-200 bg-white shadow-card">
        <button className="rounded-l-xl px-3 text-xl text-stone-500 hover:bg-stone-50" onClick={() => shift(-1)} aria-label="Previous period">
          ‹
        </button>
        <Dropdown
          button={
            <button className="flex h-full items-center gap-2 border-x border-stone-200 px-4 text-base font-medium hover:bg-stone-50">
              {label} <Chevron />
            </button>
          }
        >
          {(close) => (
            <>
              {periods.map((p) => (
                <button
                  key={p.value}
                  className={itemCls(q.period === p.value)}
                  onClick={() => {
                    close();
                    update({ period: p.value, granularity: undefined });
                  }}
                >
                  {p.label}
                </button>
              ))}
              <div className="my-1 border-t border-stone-100" />
              <form
                className="space-y-2 p-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!from || !to) return;
                  close();
                  update({ period: 'custom', from, to: to < from ? from : to, granularity: undefined });
                }}
              >
                <div className="text-xs font-medium text-stone-500">Custom range</div>
                <input type="date" className="input py-1.5" value={from} onChange={(e) => setFrom(e.target.value)} />
                <input type="date" className="input py-1.5" value={to} onChange={(e) => setTo(e.target.value)} />
                <button className="btn-dark w-full py-1.5">Apply</button>
              </form>
            </>
          )}
        </Dropdown>
        <button
          className="rounded-r-xl px-3 text-xl text-stone-500 hover:bg-stone-50 disabled:opacity-30"
          onClick={() => shift(1)}
          disabled={!canForward}
          aria-label="Next period"
        >
          ›
        </button>
      </div>

      <Dropdown
        button={
          <button className="btn h-11 px-4 text-base">
            {GRANULARITIES.find((g) => g.value === (q.granularity ?? overview?.range.granularity))?.label ?? 'Daily'} <Chevron />
          </button>
        }
      >
        {(close) =>
          GRANULARITIES.map((g) => (
            <button
              key={g.value}
              className={itemCls((q.granularity ?? overview?.range.granularity) === g.value)}
              onClick={() => {
                close();
                update({ granularity: g.value });
              }}
            >
              {g.label}
            </button>
          ))
        }
      </Dropdown>

      <Dropdown
        button={
          <button className="btn h-11 px-4 text-base" title="Which visit gets the credit for a payment">
            {q.attr === 'first' ? 'First touch' : 'Last touch'} <Chevron />
          </button>
        }
      >
        {(close) => (
          <div className="w-72">
            {[
              { value: undefined, label: 'Last touch', hint: 'The last visit that came from somewhere before paying. A direct return visit does not take the credit.' },
              { value: 'first', label: 'First touch', hint: 'The visit that first brought the customer to the site.' },
            ].map((m) => (
              <button
                key={m.label}
                className={`${itemCls((q.attr ?? undefined) === m.value)} flex-col !items-start !gap-0.5`}
                onClick={() => {
                  close();
                  update({ attr: m.value });
                }}
              >
                <span>{m.label}</span>
                <span className="text-xs font-normal text-stone-500">{m.hint}</span>
              </button>
            ))}
          </div>
        )}
      </Dropdown>

      {!readonly && (
        <Dropdown
          button={
            <button className="btn h-11 px-4 text-base" title="Saved periods and filters">
              Views <Chevron />
            </button>
          }
        >
          {(close) => (
            <div className="w-64">
              {views?.map((v) => (
                <div key={v.id} className="flex items-center">
                  <button
                    className={`${itemCls(false)} min-w-0 flex-1`}
                    onClick={() => {
                      close();
                      navigate(`/site/${site.id}?${v.query}`);
                    }}
                  >
                    <span className="truncate">{v.name}</span>
                  </button>
                  <button
                    className="rounded-lg px-2 py-1 text-stone-400 hover:bg-stone-100 hover:text-ink"
                    aria-label={`Delete view ${v.name}`}
                    onClick={async () => {
                      await api(`${base}/views/${v.id}`, { method: 'DELETE' });
                      setViewsVersion((x) => x + 1);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {views && !views.length && <div className="px-3 py-2 text-sm text-stone-500">No saved views yet.</div>}
              <div className="my-1 border-t border-stone-100" />
              <button
                className={itemCls(false)}
                onClick={() => {
                  close();
                  saveView();
                }}
              >
                ＋ Save the current view
              </button>
            </div>
          )}
        </Dropdown>
      )}

      {!readonly && (
        <button className="btn h-11 px-4 text-base" onClick={onLive} title="Live map (M)">
          <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" /> Live
        </button>
      )}

      <button className="btn h-11 w-11 px-0" onClick={onRefresh} aria-label="Refresh">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? 'animate-spin' : ''}>
          <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      </button>
    </div>
  );
}
