import { useEffect, useState } from 'react';
import { navigate } from '../App';
import { Logo } from '../components/Logo';
import { api } from '../lib/api';
import { fmtAgo } from '../lib/format';
import { useApi } from '../lib/useApi';
import { Code, CopyField, Section } from './Settings';

interface Prefs {
  url: string;
  configured: boolean;
  sale: boolean;
  refund: boolean;
  health: boolean;
  spike: boolean;
  digest: boolean;
}

interface Token {
  id: string;
  name: string;
  hint: string;
  created_at: number;
  last_used_at: number | null;
}

const SWITCHES: { key: keyof Omit<Prefs, 'url' | 'configured'>; label: string; hint: string }[] = [
  { key: 'sale', label: 'Each payment', hint: 'The amount and the source that brought the customer' },
  { key: 'refund', label: 'Refunds', hint: '' },
  { key: 'health', label: 'Tracking problems', hint: 'A busy site stops sending visits, or a payment webhook keeps being rejected' },
  { key: 'spike', label: 'Traffic spikes', hint: 'A site gets several times its normal day, with the source it comes from' },
  { key: 'digest', label: 'Weekly summary', hint: 'Monday morning: visitors and revenue per site against the week before' },
];

/** Settings that cover every site: where notifications go, and read access for scripts and AI agents. */
export function Workspace() {
  const origin = window.location.origin;
  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:py-12">
      <div className="flex items-center justify-between">
        <button className="btn" onClick={() => navigate('/')}>
          ← All websites
        </button>
        <Logo />
      </div>
      <h1 className="text-2xl font-semibold">Workspace</h1>
      <Notifications />
      <Tokens origin={origin} />
      <Checks />
    </div>
  );
}

function Notifications() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const { data: digest } = useApi<{ text: string | null }>('/api/workspace/digest');

  useEffect(() => {
    api<Prefs>('/api/workspace/notifications').then((p) => {
      setPrefs(p);
      setUrl(p.url);
    });
  }, []);

  async function save(patch: Partial<Prefs>) {
    setStatus(null);
    try {
      const p = await api<Prefs>('/api/workspace/notifications', { method: 'PATCH', json: patch });
      setPrefs(p);
      setUrl(p.url);
      if ('url' in patch) setStatus({ ok: true, text: p.configured ? 'Saved' : 'Notifications are off' });
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message });
    }
  }

  async function test() {
    setStatus(null);
    try {
      await api('/api/workspace/notifications/test', { method: 'POST' });
      setStatus({ ok: true, text: 'Test message sent' });
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message });
    }
  }

  if (!prefs) return null;
  return (
    <Section
      title="Notifications"
      desc="Minilytics can post to a chat when something happens, so you don't have to open the dashboard to find out. Alerts also appear on the home page either way."
    >
      <label className="label">Webhook address</label>
      <div className="flex gap-2">
        <input className="input font-mono" placeholder="https://hooks.slack.com/services/…" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn-dark shrink-0" onClick={() => save({ url })}>
          Save
        </button>
        {prefs.configured && (
          <button className="btn shrink-0" onClick={test}>
            Send test
          </button>
        )}
      </div>
      {status && <p className={`mt-1 text-xs ${status.ok ? 'text-emerald-600' : 'text-red-600'}`}>{status.text}</p>}
      <details className="mt-2 text-sm text-stone-500">
        <summary className="cursor-pointer font-medium text-stone-600">Where to get one</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <b>Slack:</b> create an Incoming Webhook for a channel and paste its address.
          </li>
          <li>
            <b>Discord:</b> channel settings → Integrations → Webhooks → Copy webhook URL.
          </li>
          <li>
            <b>Telegram:</b> <code>https://api.telegram.org/bot&lt;bot token&gt;/sendMessage?chat_id=&lt;chat id&gt;</code>
          </li>
          <li>
            <b>ntfy:</b> <code>https://ntfy.sh/&lt;your topic&gt;</code> for a push notification on your phone.
          </li>
          <li>
            <b>Anything else:</b> an https address that accepts a JSON POST with <code>title</code>, <code>body</code> and <code>text</code>.
          </li>
        </ul>
        <p className="mt-2">Messages carry amounts, site names and sources. They never include a customer's name or email.</p>
      </details>

      <div className="mt-5 space-y-2.5">
        {SWITCHES.map((s) => (
          <label key={s.key} className="flex cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-stone-800" checked={prefs[s.key]} onChange={(e) => save({ [s.key]: e.target.checked })} />
            <span>
              <span className="font-medium">{s.label}</span>
              {s.hint && <span className="block text-stone-500">{s.hint}</span>}
            </span>
          </label>
        ))}
      </div>

      {digest?.text && (
        <div className="mt-5">
          <div className="label">What this week's summary would say</div>
          <pre className="whitespace-pre-wrap rounded-xl bg-stone-50 p-4 font-sans text-sm text-stone-700">{digest.text}</pre>
        </div>
      )}
    </Section>
  );
}

function Tokens({ origin }: { origin: string }) {
  const [version, setVersion] = useState(0);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState('');
  const { data } = useApi<Token[]>('/api/workspace/tokens', version);
  const token = fresh ?? 'mlr_your_token';

  return (
    <Section
      title="Read access for scripts and AI agents"
      desc="A token can read every site's statistics and nothing else: it cannot change anything, and it never returns a customer's name or email. Long ranges of raw visits are refused, so an agent cannot use up the database's daily allowance."
    >
      <div className="space-y-2">
        {data?.map((t) => (
          <div key={t.id} className="flex items-center justify-between rounded-xl border border-stone-200 px-3 py-2 text-sm">
            <div>
              <span className="font-medium">{t.name}</span> <code className="text-xs text-stone-500">mlr_…{t.hint}</code>
              <div className="text-xs text-stone-500">{t.last_used_at ? `last used ${fmtAgo(Date.now() - t.last_used_at)} ago` : 'never used'}</div>
            </div>
            <button
              className="text-xs text-red-600 hover:underline"
              onClick={async () => {
                if (!confirm(`Delete the token "${t.name}"? Anything using it stops working.`)) return;
                await api(`/api/workspace/tokens/${t.id}`, { method: 'DELETE' });
                setVersion((v) => v + 1);
              }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          try {
            const r = await api<{ token: string }>('/api/workspace/tokens', { method: 'POST', json: { name } });
            setFresh(r.token);
            setName('');
            setVersion((v) => v + 1);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <input className="input" placeholder="What will use it? e.g. Claude Code" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <button className="btn-dark shrink-0">Create token</button>
      </form>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      {fresh && (
        <div className="mt-3 rounded-xl bg-emerald-50 p-3">
          <p className="mb-2 text-sm text-emerald-900">Copy this token now. It is shown only once.</p>
          <CopyField value={fresh} />
        </div>
      )}

      <div className="mt-6 space-y-3 text-sm">
        <div className="font-medium">Connect an AI agent (MCP)</div>
        <p className="text-stone-500">
          The agent can then answer questions like “which source made money this week?” or “how are the products doing?” from the same numbers this dashboard shows.
        </p>
        <Code label="Claude Code">{`claude mcp add --transport http minilytics ${origin}/api/mcp \\
  --header "Authorization: Bearer ${token}"`}</Code>
        <Code label="Any MCP client (JSON)">{`{
  "mcpServers": {
    "minilytics": {
      "type": "http",
      "url": "${origin}/api/mcp",
      "headers": { "Authorization": "Bearer ${token}" }
    }
  }
}`}</Code>
        <div className="pt-2 font-medium">Or plain HTTP</div>
        <Code label="curl">{`curl -H "Authorization: Bearer ${token}" \\
  "${origin}/api/v1/reports/portfolio?period=30d"

# the list of reports and their parameters
curl -H "Authorization: Bearer ${token}" ${origin}/api/v1/reports`}</Code>
      </div>
    </Section>
  );
}

interface CheckReport {
  sites: number;
  alerts: string[];
  errors: string[];
}

function Checks() {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<CheckReport | null>(null);
  return (
    <Section title="Hourly checks" desc="Once an hour Minilytics adds up finished days, checks that each busy site is still sending visits and that payment webhooks are accepted, and looks for traffic spikes.">
      <button
        className="btn"
        disabled={running}
        onClick={async () => {
          setRunning(true);
          try {
            setReport(await api<CheckReport>('/api/workspace/run-checks', { method: 'POST' }));
          } finally {
            setRunning(false);
          }
        }}
      >
        {running ? 'Checking…' : 'Run the checks now'}
      </button>
      {report && (
        <p className={`mt-2 text-sm ${report.errors.length ? 'text-red-600' : 'text-stone-600'}`}>
          {report.errors.length
            ? `A check failed: ${report.errors.join('; ')}`
            : `Checked ${report.sites} site${report.sites === 1 ? '' : 's'}. ${report.alerts.length ? `${report.alerts.length} new alert${report.alerts.length === 1 ? '' : 's'} on the home page.` : 'Nothing new to report.'}`}
        </p>
      )}
    </Section>
  );
}
