// Workspace settings, the alerts inbox, and messages sent to a chat webhook (Slack, Discord, Telegram or any URL).

export interface NotifyPrefs {
  /** Where messages go. Empty = nowhere; alerts still show in the dashboard. */
  url: string;
  sale: boolean;
  refund: boolean;
  health: boolean;
  spike: boolean;
  digest: boolean;
  /** Address of the dashboard, remembered when the settings are saved, for links in scheduled messages. */
  origin: string;
}

export const DEFAULT_PREFS: NotifyPrefs = { url: '', sale: true, refund: true, health: true, spike: true, digest: true, origin: '' };

export type NotifyKind = 'sale' | 'refund' | 'health' | 'spike' | 'digest' | 'test';

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export function setSetting(db: D1Database, key: string, value: string) {
  return db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

const prefsCache = new WeakMap<D1Database, { prefs: NotifyPrefs; at: number }>();

export async function getPrefs(db: D1Database, fresh = false): Promise<NotifyPrefs> {
  const hit = prefsCache.get(db);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.prefs;
  let prefs = { ...DEFAULT_PREFS };
  try {
    const raw = await getSetting(db, 'notify');
    if (raw) prefs = { ...prefs, ...JSON.parse(raw) };
  } catch {}
  prefsCache.set(db, { prefs, at: Date.now() });
  return prefs;
}

export async function savePrefs(db: D1Database, patch: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
  const cur = await getPrefs(db, true);
  const next: NotifyPrefs = { ...cur };
  if (typeof patch.url === 'string') next.url = patch.url.trim().slice(0, 500);
  if (typeof patch.origin === 'string' && /^https?:\/\//.test(patch.origin)) next.origin = patch.origin.slice(0, 200);
  for (const k of ['sale', 'refund', 'health', 'spike', 'digest'] as const) if (typeof patch[k] === 'boolean') next[k] = patch[k]!;
  await setSetting(db, 'notify', JSON.stringify(next));
  prefsCache.set(db, { prefs: next, at: Date.now() });
  return next;
}

/** Only https URLs on public hostnames: the worker must not be usable to reach internal addresses. */
export function validWebhookUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return false; // no raw IPs
    return true;
  } catch {
    return false;
  }
}

/** The request each kind of destination expects. */
export function webhookRequest(url: string, title: string, body: string, extra: Record<string, unknown> = {}): { url: string; init: RequestInit } {
  const text = body ? `${title}\n${body}` : title;
  const u = new URL(url);
  const json = (payload: unknown, target = url) => ({
    url: target,
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
  });
  if (u.hostname === 'hooks.slack.com') return json({ text: body ? `*${title}*\n${body}` : `*${title}*` });
  if (/(^|\.)discord(app)?\.com$/.test(u.hostname)) return json({ content: body ? `**${title}**\n${body}` : `**${title}**` });
  if (u.hostname === 'api.telegram.org') {
    // https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>
    const chat = u.searchParams.get('chat_id');
    u.search = '';
    return json({ chat_id: chat, text, disable_web_page_preview: true }, u.toString());
  }
  if (u.hostname === 'ntfy.sh' || u.hostname.startsWith('ntfy.')) {
    return { url, init: { method: 'POST', headers: { title: title.replace(/[^\x20-\x7e]/g, '').trim() || 'Minilytics' }, body: body || title } };
  }
  return json({ title, body, text, ...extra });
}

/** Send to the configured webhook if this kind is switched on. Never throws: a notification must not break ingestion. */
export async function notify(db: D1Database, kind: NotifyKind, title: string, body = '', extra: Record<string, unknown> = {}): Promise<boolean> {
  try {
    const prefs = await getPrefs(db);
    if (!prefs.url || !validWebhookUrl(prefs.url)) return false;
    if (kind !== 'test' && !prefs[kind]) return false;
    const req = webhookRequest(prefs.url, title, body, { kind, ...extra });
    const res = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface Alert {
  id: number;
  site_id: string | null;
  kind: string;
  key: string;
  ts: number;
  title: string;
  body: string | null;
  resolved_at: number | null;
  dismissed_at: number | null;
}

/**
 * Raise an alert once per `key`: while one with that key is open, nothing happens.
 * Returns true when it is new (so the caller sends the notification once too).
 */
export async function raiseAlert(db: D1Database, a: { siteId: string | null; kind: string; key: string; title: string; body?: string; now?: number }): Promise<boolean> {
  const open = await db.prepare('SELECT id FROM alerts WHERE key = ? AND resolved_at IS NULL LIMIT 1').bind(a.key).first();
  if (open) return false;
  await db
    .prepare('INSERT INTO alerts (site_id, kind, key, ts, title, body) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(a.siteId, a.kind, a.key, a.now ?? Date.now(), a.title.slice(0, 200), a.body?.slice(0, 2000) ?? null)
    .run();
  return true;
}

/** Close the open alert with this key, if any. Returns true when there was one. */
export async function resolveAlert(db: D1Database, key: string, now = Date.now()): Promise<boolean> {
  const res = await db.prepare('UPDATE alerts SET resolved_at = ? WHERE key = ? AND resolved_at IS NULL').bind(now, key).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Alerts that are still open or happened in the last two weeks, newest first, without the dismissed ones. */
export async function listAlerts(db: D1Database, siteIds: string[] | null, now = Date.now()): Promise<Alert[]> {
  const res = await db
    .prepare('SELECT * FROM alerts WHERE (ts > ? OR resolved_at IS NULL) AND dismissed_at IS NULL ORDER BY ts DESC LIMIT 50')
    .bind(now - 14 * 86_400_000)
    .all<Alert>();
  return res.results.filter((a) => !siteIds || !a.site_id || siteIds.includes(a.site_id));
}
