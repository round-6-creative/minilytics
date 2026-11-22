import { useState } from 'react';
import { qs, type RevenueSummary } from '../lib/api';
import { useDash } from '../lib/context';
import { fmtNumber, fmtPct } from '../lib/format';
import { useApi } from '../lib/useApi';
import { renderLabel } from './Panel';

const BY = [
  { value: 'source', label: 'Source', dim: 'source' },
  { value: 'channel', label: 'Channel', dim: 'channel' },
  { value: 'campaign', label: 'Campaign', dim: 'campaign' },
  { value: 'country', label: 'Country', dim: 'country' },
  { value: 'entry_page', label: 'Entry page', dim: 'entry_page' },
];

function Tile({ label, value, note, accent }: { label: string; value: string; note?: string; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-stone-50 px-4 py-3">
      <div className="text-xs text-stone-500">{label}</div>
      <div className={`mt-0.5 text-xl font-semibold tracking-tight ${accent ? 'text-revenue' : ''}`}>{value}</div>
      {note && <div className="text-xs text-stone-400">{note}</div>}
    </div>
  );
}

/** Where the money comes from beyond the period total: new versus repeat, subscriptions, and what a customer is worth by source. */
export function RevenuePanel() {
  const { base, q, reloadKey, money } = useDash();
  const [by, setBy] = useState('source');
  const { data } = useApi<RevenueSummary>(`${base}/revenue?${qs(q, { by })}`, reloadKey);

  // A site that has never been paid has nothing to show here.
  if (!data || data.allTime.customers === 0) return null;
  const { period, allTime, subscriptions: subs } = data;
  const dim = BY.find((b) => b.value === by)!.dim;

  return (
    <div className="card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-3 pt-1">
        <div>
          <div className="font-semibold">Revenue</div>
          <div className="text-xs text-stone-500">
            {q.attr === 'first' ? 'Credited to each customer’s first visit' : 'Credited to the last visit that came from somewhere'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 px-1 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="New customers" value={money(period.newRevenue)} note={`${period.newCustomers} in this period`} accent={period.newRevenue > 0} />
        <Tile label="Repeat payments" value={money(period.renewalRevenue)} note="renewals and returning buyers" />
        <Tile label="Refunds" value={money(period.refunds)} note={period.net !== period.newRevenue + period.renewalRevenue ? `net ${money(period.net)}` : undefined} />
        <Tile
          label={subs.estimated ? 'MRR (estimate)' : 'MRR'}
          value={money(subs.mrr)}
          note={`${subs.active} active subscription${subs.active === 1 ? '' : 's'}${subs.churned30 ? `, ${subs.churned30} ended in 30 days` : ''}`}
        />
        <Tile label="Value per customer" value={money(allTime.ltv)} note={`${allTime.customers} customer${allTime.customers === 1 ? '' : 's'}, all time`} />
        <Tile label="Paid more than once" value={fmtPct(allTime.repeatRate)} note="of all customers" />
      </div>
      {subs.estimated && (
        <p className="px-2 pt-2 text-xs text-stone-400">
          MRR is estimated: a subscription with a single payment and no billing period on record is counted as monthly.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 px-2">
        <div className="text-sm font-medium text-stone-600">Customers and revenue since the start, by</div>
        <div className="tabs overflow-x-auto">
          {BY.map((b) => (
            <button key={b.value} className={`tab whitespace-nowrap ${b.value === by ? 'tab-active' : ''}`} onClick={() => setBy(b.value)}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="text-left text-stone-500">
              <th className="px-3 pb-2 font-medium">{BY.find((b) => b.value === by)!.label}</th>
              <th className="pb-2 text-right font-medium">Customers</th>
              <th className="pb-2 text-right font-medium">Revenue</th>
              <th className="pb-2 text-right font-medium">Per customer</th>
              <th className="px-3 pb-2 text-right font-medium">Days to first payment</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((s, i) => (
              <tr key={i} className="border-t border-stone-100">
                <td className="max-w-[320px] px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {s.label === null && by === 'source' ? <span className="text-stone-400">Not linked to a visit</span> : renderLabel(dim, s)}
                  </div>
                </td>
                <td className="py-2 text-right">{fmtNumber(s.customers)}</td>
                <td className="py-2 text-right font-medium">{money(s.revenue)}</td>
                <td className="py-2 text-right">{money(s.ltv)}</td>
                <td className="px-3 py-2 text-right text-stone-500">{s.daysToConvert === null ? '—' : s.daysToConvert < 1 ? 'same day' : s.daysToConvert.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
