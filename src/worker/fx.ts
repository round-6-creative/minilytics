// Currency helpers: minor units, and daily exchange rates to bring a payment into the site's currency.

export function currencyDecimals(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "$29.00" from minor units, for messages written on the server. */
export function formatMoney(minor: number, currency: string): string {
  const v = minor / 10 ** currencyDecimals(currency);
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
}

/** Units of each currency per one US dollar. */
export type Rates = Map<string, number>;

// Kept per database binding for an hour; rates change once a day.
const cache = new WeakMap<D1Database, { rates: Rates; at: number }>();

export async function loadRates(db: D1Database, fresh = false): Promise<Rates> {
  const hit = cache.get(db);
  if (!fresh && hit && Date.now() - hit.at < 3_600_000) return hit.rates;
  const res = await db.prepare('SELECT currency, per_usd FROM fx_rates').all<{ currency: string; per_usd: number }>();
  const rates: Rates = new Map(res.results.map((r) => [r.currency, r.per_usd]));
  cache.set(db, { rates, at: Date.now() });
  return rates;
}

/** Fetch today's reference rates (European Central Bank, via frankfurter.dev: free, no key, no data sent). */
export async function refreshRates(db: D1Database, fetcher: typeof fetch = fetch): Promise<number> {
  const res = await fetcher('https://api.frankfurter.dev/v1/latest?base=USD', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`rates: HTTP ${res.status}`);
  const data = (await res.json()) as { date?: string; rates?: Record<string, number> };
  const rows = Object.entries(data.rates ?? {})
    .filter(([c, r]) => /^[A-Z]{3}$/.test(c) && typeof r === 'number' && r > 0)
    .map(([currency, per_usd]) => ({ currency, per_usd, day: data.date ?? '' }));
  if (!rows.length) throw new Error('rates: empty response');
  rows.push({ currency: 'USD', per_usd: 1, day: data.date ?? '' });
  await db
    .prepare(
      `INSERT OR REPLACE INTO fx_rates (currency, per_usd, day)
       SELECT json_extract(value, '$.currency'), json_extract(value, '$.per_usd'), json_extract(value, '$.day') FROM json_each(?)`,
    )
    .bind(JSON.stringify(rows))
    .run();
  cache.delete(db);
  return rows.length;
}

/** Convert minor units of `from` into minor units of `to`, or null when a rate is missing. */
export function convertMinor(amount: number, from: string, to: string, rates: Rates): number | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return amount;
  const rf = rates.get(f);
  const rt = rates.get(t);
  if (!rf || !rt) return null;
  const major = amount / 10 ** currencyDecimals(f);
  return Math.round((major / rf) * rt * 10 ** currencyDecimals(t));
}
