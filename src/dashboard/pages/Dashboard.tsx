import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { navigate } from '../App';
import { GoalsPanel } from '../components/GoalsPanel';
import { InsightsPanel } from '../components/InsightsPanel';
import { Logo } from '../components/Logo';
import { OverviewCard } from '../components/OverviewCard';
import { Panel, renderLabel } from '../components/Panel';
import { RevenuePanel } from '../components/RevenuePanel';
import { Toolbar } from '../components/Toolbar';
import { VisitorModal } from '../components/VisitorModal';
import { qs, type Overview, type Site } from '../lib/api';
import { DashContext, type Dash } from '../lib/context';
import { fmtMoney } from '../lib/format';
import { useApi } from '../lib/useApi';
import { useQueryState } from '../lib/useQueryState';

// The globe pulls in a map library, so it's only downloaded when opened.
const LiveView = lazy(() => import('../components/LiveView'));

const FILTER_LABELS: Record<string, { label: string; dim: string }> = {
  channel: { label: 'Channel', dim: 'channel' },
  source: { label: 'Referrer', dim: 'source' },
  utm_campaign: { label: 'Campaign', dim: 'campaign' },
  utm_term: { label: 'Keyword', dim: 'keyword' },
  utm_source: { label: 'UTM source', dim: 'utm_source' },
  utm_medium: { label: 'UTM medium', dim: 'utm_medium' },
  ref: { label: 'Ref', dim: 'ref' },
  country: { label: 'Country', dim: 'country' },
  region: { label: 'Region', dim: 'region' },
  city: { label: 'City', dim: 'city' },
  browser: { label: 'Browser', dim: 'browser' },
  os: { label: 'OS', dim: 'os' },
  device: { label: 'Device', dim: 'device' },
  page: { label: 'Visited page', dim: 'page' },
  entry_page: { label: 'Entry page', dim: 'entry_page' },
  hostname: { label: 'Hostname', dim: 'hostname' },
  cloud: { label: 'Network', dim: 'cloud' },
  goal: { label: 'Completed goal', dim: 'goal' },
};

/** A site's dashboard. With `share`, the read-only version behind a share link: totals only, no login. */
export function Dashboard({ siteId, share }: { siteId?: string; share?: string }) {
  const readonly = !!share;
  const base = share ? `/api/share/${share}` : `/api/sites/${siteId}`;
  const [q, update] = useQueryState();
  const [reloadKey, setReloadKey] = useState(0);
  const [visitor, setVisitor] = useState<string | null>(null);
  const [live, setLive] = useState(() => new URLSearchParams(window.location.search).get('live') === '1');

  // "M" opens the live map, like DataFast.
  useEffect(() => {
    if (readonly) return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key.toLowerCase() === 'm' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) setLive(true);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [readonly]);
  const { data: ownSites } = useApi<Site[]>(readonly ? null : '/api/sites');
  const { data: shared, error: shareError } = useApi<Site>(share ? base : null);
  const sites = readonly ? (shared ? [shared] : null) : ownSites;
  const site = readonly ? shared ?? undefined : sites?.find((s) => s.id === siteId);
  const { data: overview, loading, error: overviewError } = useApi<Overview>(site ? `${base}/overview?${qs(q)}` : null, reloadKey);

  const addFilter = useCallback((key: string, value: string) => update({ filters: { ...q.filters, [key]: value } }), [q.filters, update]);
  const removeFilter = (key: string) => {
    const { [key]: _, ...rest } = q.filters;
    update({ filters: rest });
  };

  const dash: Dash | null = useMemo(() => {
    if (!site) return null;
    const decimals = overview?.decimals ?? 2;
    return {
      base,
      readonly,
      site,
      q,
      reloadKey,
      decimals,
      money: (minor, compact) => fmtMoney(minor, site.currency, decimals, compact),
      addFilter,
      openVisitor: setVisitor,
    };
  }, [base, readonly, site, q, reloadKey, overview?.decimals, addFilter]);

  if (share && shareError) {
    return (
      <div className="mx-auto max-w-md px-6 py-24 text-center">
        <Logo />
        <p className="mt-6 text-stone-600">This shared dashboard is not available any more. Ask whoever sent you the link for a new one.</p>
      </div>
    );
  }
  if (sites && !site) {
    return (
      <div className="p-10 text-center">
        Site not found.{' '}
        <button className="underline" onClick={() => navigate('/')}>
          Back to websites
        </button>
      </div>
    );
  }
  if (!dash || !site) return null;

  return (
    <DashContext.Provider value={dash}>
      <div className="mx-auto max-w-[1480px] px-3 py-6 sm:px-6 lg:py-10">
        <Toolbar
          site={site}
          sites={sites!}
          q={q}
          update={update}
          overview={overview}
          onRefresh={() => setReloadKey((k) => k + 1)}
          onLive={() => setLive(true)}
          loading={loading}
          readonly={readonly}
          base={base}
        />
        {overviewError && <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">{overviewError}</p>}

        {Object.keys(q.filters).length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {Object.entries(q.filters).map(([k, v]) => (
              <span key={k} className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white py-1 pl-3 pr-1 text-sm shadow-card">
                <span className="text-stone-500">{FILTER_LABELS[k]?.label ?? k} is</span>
                <span className="flex items-center gap-1.5 font-medium">{renderLabel(FILTER_LABELS[k]?.dim ?? k, { label: v || null })}</span>
                <button className="rounded-lg px-1.5 text-stone-400 hover:bg-stone-100 hover:text-ink" onClick={() => removeFilter(k)} aria-label="Remove filter">
                  ✕
                </button>
              </span>
            ))}
            <button className="text-sm text-stone-500 underline-offset-2 hover:underline" onClick={() => update({ filters: {} })}>
              Clear all
            </button>
          </div>
        )}

        <div className="mt-5">
          <OverviewCard data={overview} onLive={() => setLive(true)} />
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Panel
            tabs={[
              { label: 'Channel', dim: 'channel', filter: 'channel' },
              { label: 'Referrer', dim: 'source', filter: 'source' },
              { label: 'Campaign', dim: 'campaign', filter: 'utm_campaign' },
              { label: 'Keyword', dim: 'keyword', filter: 'utm_term' },
            ]}
          />
          <Panel
            tabs={[
              { label: 'Country', dim: 'country', filter: 'country' },
              { label: 'Region', dim: 'region', filter: 'region' },
              { label: 'City', dim: 'city', filter: 'city' },
            ]}
          />
          <Panel
            tabs={[
              { label: 'Page', dim: 'page', filter: 'page' },
              { label: 'Entry page', dim: 'entry_page', filter: 'entry_page' },
              { label: 'Exit link', dim: 'exit_link' },
              { label: 'Hostname', dim: 'hostname', filter: 'hostname' },
            ]}
          />
          <Panel
            tabs={[
              { label: 'Browser', dim: 'browser', filter: 'browser' },
              { label: 'OS', dim: 'os', filter: 'os' },
              { label: 'Device', dim: 'device', filter: 'device' },
              { label: 'Network', dim: 'cloud', filter: 'cloud' },
            ]}
          />
        </div>

        <div className="mt-5">
          <RevenuePanel />
        </div>

        <div className="mt-5">
          <GoalsPanel totalVisitors={overview?.current.visitors ?? 0} />
        </div>

        <div className="mt-5">
          <InsightsPanel />
        </div>

        <p className="mt-8 text-center text-xs text-stone-400">
          Times in {site.timezone} · Revenue in {site.currency}
          {readonly ? (
            <> · Read-only view shared with Minilytics</>
          ) : (
            <>
              {' · '}
              <button className="underline-offset-2 hover:underline" onClick={() => navigate(`/site/${site.id}/settings`)}>
                Settings & install
              </button>
            </>
          )}
        </p>
      </div>
      {live && !readonly && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-[#070b1a]" />}>
          <LiveView onClose={() => setLive(false)} />
        </Suspense>
      )}
      <VisitorModal key={visitor ?? 'none'} visitorId={visitor} onClose={() => setVisitor(null)} />
    </DashContext.Provider>
  );
}
