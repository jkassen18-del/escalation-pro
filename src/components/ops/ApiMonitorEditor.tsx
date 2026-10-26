import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Plus, Send, Terminal, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { opsApi } from '@/lib/ops-api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import {
  ASSERTION_OPS,
  ASSERTION_OP_LABELS,
  HTTP_METHODS,
  type ApiAssertion,
  type ApiAuth,
  type ApiTryResult,
  type AssertionSource,
  type HttpMethod,
  type MonitorConfig,
} from '@shared/ops';

/**
 * The HTTP / API monitor: build a request (or paste a cURL command), send it,
 * then click what to watch in the real response.
 */

type Pairs = Array<{ key: string; value: string }>;
const toPairs = (record: Record<string, string> | undefined): Pairs => Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
const fromPairs = (pairs: Pairs): Record<string, string> | undefined => {
  const entries = pairs.filter((pair) => pair.key.trim()).map((pair) => [pair.key.trim(), pair.value] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
};

/* ---------------------------------- cURL ---------------------------------- */

/** Splits a shell command into words, honouring quotes and line continuations. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  const text = command.replace(/\\\r?\n/g, ' ');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current) words.push(current);
      current = '';
      started = false;
    } else if (char === '\\' && i + 1 < text.length) {
      current += text[++i];
    } else {
      current += char;
    }
  }
  if (started || current) words.push(current);
  return words;
}

/** Reads the parts of a cURL command a monitor can use. Exported for tests. */
export function parseCurl(command: string): { target: string; config: MonitorConfig } | null {
  const words = shellWords(command.trim());
  if (!words.length || !/curl(\.exe)?$/i.test(words[0])) return null;
  let target = '';
  let method: string | undefined;
  const headers: Record<string, string> = {};
  let body: string | undefined;
  let auth: ApiAuth | undefined;
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    const next = () => words[++i] ?? '';
    if (word === '-X' || word === '--request') method = next().toUpperCase();
    else if (word === '-H' || word === '--header') {
      const header = next();
      const index = header.indexOf(':');
      if (index > 0) headers[header.slice(0, index).trim()] = header.slice(index + 1).trim();
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json'].includes(word)) {
      const value = next();
      body = body ? `${body}&${value}` : value;
      if (word === '--json') headers['Content-Type'] ??= 'application/json';
    } else if (word === '-u' || word === '--user') {
      const [username, ...rest] = next().split(':');
      auth = { type: 'basic', username, password: rest.join(':') };
    } else if (word === '--url') target = next();
    else if (word === '-I' || word === '--head') method = 'HEAD';
    else if (/^https?:\/\//i.test(word)) target = word;
    else if (['-o', '--output', '-A', '--user-agent', '-e', '--referer', '-m', '--max-time', '--connect-timeout', '-b', '--cookie'].includes(word)) i += 1;
  }
  if (!target) return null;

  // An Authorization: Bearer header becomes a stored, encrypted credential.
  const authHeader = Object.keys(headers).find((name) => name.toLowerCase() === 'authorization');
  if (authHeader && /^bearer\s+/i.test(headers[authHeader])) {
    auth = { type: 'bearer', token: headers[authHeader].replace(/^bearer\s+/i, '') };
    delete headers[authHeader];
  }
  const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
  const bodyType: MonitorConfig['bodyType'] = !body ? undefined : contentType.includes('json') || /^\s*[[{]/.test(body) ? 'json' : contentType.includes('form') ? 'form' : 'text';

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const query = Object.fromEntries(url.searchParams.entries());
  url.search = '';
  return {
    target: url.toString(),
    config: {
      method: (HTTP_METHODS as readonly string[]).includes(method ?? '') ? (method as HttpMethod) : body ? 'POST' : 'GET',
      headers: Object.keys(headers).length ? headers : undefined,
      query: Object.keys(query).length ? query : undefined,
      body,
      bodyType,
      auth,
    },
  };
}

/* --------------------------------- Editor --------------------------------- */

export function ApiMonitorEditor({
  target,
  config,
  monitorId,
  onChange,
}: {
  target: string;
  config: MonitorConfig;
  monitorId?: string;
  onChange: (next: { target?: string; config: MonitorConfig }) => void;
}) {
  const [headers, setHeaders] = useState<Pairs>(toPairs(config.headers));
  const [query, setQuery] = useState<Pairs>(toPairs(config.query));
  const [curl, setCurl] = useState<string | null>(null);
  const [curlError, setCurlError] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);
  const [tried, setTried] = useState<ApiTryResult | null>(null);
  const [tryError, setTryError] = useState<string | null>(null);

  const method = config.method ?? 'GET';
  const auth: ApiAuth = config.auth ?? { type: 'none' };
  const assertions = config.assertions ?? [];
  const set = (patch: Partial<MonitorConfig>) => onChange({ config: { ...config, ...patch } });
  const setAuth = (patch: Partial<ApiAuth>) => set({ auth: { ...auth, ...patch } });
  const setAssertions = (next: ApiAssertion[]) => set({ assertions: next.length ? next : undefined });

  const updatePairs = (kind: 'headers' | 'query', pairs: Pairs) => {
    (kind === 'headers' ? setHeaders : setQuery)(pairs);
    set({ [kind]: fromPairs(pairs) });
  };

  const importCurl = () => {
    const parsed = parseCurl(curl ?? '');
    if (!parsed) {
      setCurlError('That is not a cURL command with a URL. Copy it from Postman, Insomnia or the browser (Network → Copy as cURL).');
      return;
    }
    setHeaders(toPairs(parsed.config.headers));
    setQuery(toPairs(parsed.config.query));
    onChange({ target: parsed.target, config: { ...config, ...parsed.config, assertions: config.assertions } });
    setCurl(null);
    setCurlError(null);
  };

  const send = async () => {
    setTrying(true);
    setTryError(null);
    try {
      setTried((await opsApi.monitors.tryRequest({ target, config, monitorId })).result);
    } catch (caught) {
      setTryError(caught instanceof ApiError ? caught.message : 'The request could not be sent.');
    } finally {
      setTrying(false);
    }
  };

  const addAssertion = (assertion: ApiAssertion) => setAssertions([...assertions, assertion]);

  return (
    <div className="space-y-4 rounded-md border p-3 surface-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium">Request</p>
        <Button variant="ghost" size="sm" onClick={() => setCurl(curl === null ? '' : null)}>
          <Terminal className="size-3.5" />
          {curl === null ? 'Paste a cURL command' : 'Cancel'}
        </Button>
      </div>

      {curl !== null && (
        <div className="space-y-2">
          <Textarea
            rows={4}
            value={curl}
            onChange={(event) => setCurl(event.target.value)}
            placeholder={"curl -X POST 'https://api.example.com/v1/health?region=eu' \\\n  -H 'Authorization: Bearer …' \\\n  -d '{\"deep\":true}'"}
            className="font-mono text-xs"
            autoFocus
          />
          {curlError && <p className="text-xs text-[var(--priority-urgent)]">{curlError}</p>}
          <Button size="sm" variant="secondary" onClick={importCurl} disabled={!curl.trim()}>
            Fill in the request
          </Button>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <Field label="Method">
          <Select value={method} onChange={(event) => set({ method: event.target.value as HttpMethod })}>
            {HTTP_METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
        <Field label="Authentication" hint={auth.secretSet ? 'A secret is saved. Leave its field blank to keep it.' : 'Stored encrypted; never shown again.'}>
          <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <Select value={auth.type} onChange={(event) => set({ auth: { ...auth, type: event.target.value as ApiAuth['type'] } })}>
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="basic">Username and password</option>
              <option value="apikey">API key</option>
            </Select>
            {auth.type === 'bearer' && (
              <Input type="password" value={auth.token ?? ''} onChange={(event) => setAuth({ token: event.target.value })} placeholder={auth.secretSet ? 'Saved' : 'Token'} autoComplete="off" />
            )}
            {auth.type === 'basic' && (
              <div className="grid grid-cols-2 gap-2">
                <Input value={auth.username ?? ''} onChange={(event) => setAuth({ username: event.target.value })} placeholder="Username" autoComplete="off" />
                <Input type="password" value={auth.password ?? ''} onChange={(event) => setAuth({ password: event.target.value })} placeholder={auth.secretSet ? 'Saved' : 'Password'} autoComplete="off" />
              </div>
            )}
            {auth.type === 'apikey' && (
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem] gap-2">
                <Input value={auth.keyName ?? ''} onChange={(event) => setAuth({ keyName: event.target.value })} placeholder="X-API-Key" />
                <Input type="password" value={auth.keyValue ?? ''} onChange={(event) => setAuth({ keyValue: event.target.value })} placeholder={auth.secretSet ? 'Saved' : 'Key'} autoComplete="off" />
                <Select value={auth.keyIn ?? 'header'} onChange={(event) => setAuth({ keyIn: event.target.value as 'header' | 'query' })}>
                  <option value="header">Header</option>
                  <option value="query">Query</option>
                </Select>
              </div>
            )}
          </div>
        </Field>
      </div>

      <PairsEditor label="Query parameters" pairs={query} onChange={(pairs) => updatePairs('query', pairs)} keyPlaceholder="region" valuePlaceholder="eu" />
      <PairsEditor label="Headers" pairs={headers} onChange={(pairs) => updatePairs('headers', pairs)} keyPlaceholder="Accept" valuePlaceholder="application/json" />

      {!['GET', 'HEAD'].includes(method) && (
        <div className="space-y-2">
          <Field label="Body">
            <Select value={config.bodyType ?? (config.body ? 'json' : 'none')} onChange={(event) => set({ bodyType: event.target.value as MonitorConfig['bodyType'] })} className="w-auto">
              <option value="none">No body</option>
              <option value="json">JSON</option>
              <option value="form">Form (a=1&amp;b=2)</option>
              <option value="text">Plain text</option>
            </Select>
          </Field>
          {(config.bodyType ?? (config.body ? 'json' : 'none')) !== 'none' && (
            <Textarea rows={4} value={config.body ?? ''} onChange={(event) => set({ body: event.target.value || undefined })} className="font-mono text-xs" placeholder='{"deep": true}' />
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Expected status" hint="e.g. 200-299, 200,204 or 2xx">
          <Input value={config.expectedStatus ?? ''} onChange={(event) => set({ expectedStatus: event.target.value || undefined })} placeholder="200-399" />
        </Field>
        <Field label="Slower than (ms) fails">
          <Input
            type="number"
            min={0}
            value={config.maxResponseMs ?? ''}
            onChange={(event) => set({ maxResponseMs: event.target.value ? Number(event.target.value) : undefined })}
            placeholder="No limit"
          />
        </Field>
        <Field label="Timeout (seconds)">
          <Input
            type="number"
            min={1}
            max={60}
            value={config.timeoutMs ? config.timeoutMs / 1000 : ''}
            onChange={(event) => set({ timeoutMs: event.target.value ? Number(event.target.value) * 1000 : undefined })}
            placeholder="10"
          />
        </Field>
      </div>
      <Checkbox label="Follow redirects" checked={config.followRedirects !== false} onChange={(event) => set({ followRedirects: event.target.checked })} />

      <div className="space-y-2 border-t pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium">What to monitor</p>
            <p className="text-2xs text-muted">Every check must pass, as well as the expected status. Send the request to pick values from the response.</p>
          </div>
          <Button size="sm" variant="primary" loading={trying} disabled={!/^https?:\/\//i.test(target)} onClick={() => void send()}>
            <Send className="size-3.5" />
            Send request
          </Button>
        </div>

        {assertions.length > 0 && (
          <ul className="space-y-1.5">
            {assertions.map((assertion, index) => (
              <AssertionRow
                key={index}
                assertion={assertion}
                result={tried?.assertions[index]}
                onChange={(next) => setAssertions(assertions.map((item, i) => (i === index ? next : item)))}
                onRemove={() => setAssertions(assertions.filter((_, i) => i !== index))}
              />
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => addAssertion({ source: 'json', path: '', op: 'eq', value: '' })}>
            <Plus className="size-3.5" />
            JSON value
          </Button>
          <Button size="sm" variant="ghost" onClick={() => addAssertion({ source: 'body', op: 'contains', value: '' })}>
            <Plus className="size-3.5" />
            Body text
          </Button>
          <Button size="sm" variant="ghost" onClick={() => addAssertion({ source: 'header', path: 'content-type', op: 'contains', value: 'json' })}>
            <Plus className="size-3.5" />
            Header
          </Button>
          <Button size="sm" variant="ghost" onClick={() => addAssertion({ source: 'latency', op: 'lt', value: '1000' })}>
            <Plus className="size-3.5" />
            Response time
          </Button>
        </div>

        {tryError && <p className="text-xs text-[var(--priority-urgent)]">{tryError}</p>}
        {tried && <ResponseView result={tried} onPick={addAssertion} />}
      </div>
    </div>
  );
}

function PairsEditor({
  label,
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string;
  pairs: Pairs;
  onChange: (pairs: Pairs) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-medium">{label}</p>
        <button type="button" onClick={() => onChange([...pairs, { key: '', value: '' }])} className="inline-flex items-center gap-1 text-2xs text-[var(--accent)] hover:underline">
          <Plus className="size-3" />
          Add
        </button>
      </div>
      {pairs.length === 0 ? (
        <p className="text-2xs text-subtle">None.</p>
      ) : (
        <div className="space-y-1.5">
          {pairs.map((pair, index) => (
            <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] gap-1.5">
              <Input value={pair.key} onChange={(event) => onChange(pairs.map((p, i) => (i === index ? { ...p, key: event.target.value } : p)))} placeholder={keyPlaceholder} className="font-mono text-xs" />
              <Input value={pair.value} onChange={(event) => onChange(pairs.map((p, i) => (i === index ? { ...p, value: event.target.value } : p)))} placeholder={valuePlaceholder} className="font-mono text-xs" />
              <Button variant="ghost" size="icon" onClick={() => onChange(pairs.filter((_, i) => i !== index))} aria-label={`Remove ${pair.key || 'row'}`}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SOURCE_LABELS: Record<AssertionSource, string> = { json: 'JSON value', body: 'Body', header: 'Header', status: 'Status code', latency: 'Response time (ms)' };

function AssertionRow({
  assertion,
  result,
  onChange,
  onRemove,
}: {
  assertion: ApiAssertion;
  result?: ApiTryResult['assertions'][number];
  onChange: (next: ApiAssertion) => void;
  onRemove: () => void;
}) {
  const needsPath = assertion.source === 'json' || assertion.source === 'header';
  const needsValue = !['exists', 'not_exists'].includes(assertion.op);
  return (
    <li className="rounded-sm border p-2 surface">
      <div className="grid gap-1.5 sm:grid-cols-[8rem_minmax(0,1.3fr)_9rem_minmax(0,1fr)_auto]">
        <Select value={assertion.source} onChange={(event) => onChange({ ...assertion, source: event.target.value as AssertionSource })}>
          {(Object.keys(SOURCE_LABELS) as AssertionSource[]).map((source) => (
            <option key={source} value={source}>
              {SOURCE_LABELS[source]}
            </option>
          ))}
        </Select>
        {needsPath ? (
          <Input
            value={assertion.path ?? ''}
            onChange={(event) => onChange({ ...assertion, path: event.target.value })}
            placeholder={assertion.source === 'json' ? 'data.status or items.length' : 'Header name'}
            className="font-mono text-xs"
          />
        ) : (
          <span className="hidden sm:block" />
        )}
        <Select value={assertion.op} onChange={(event) => onChange({ ...assertion, op: event.target.value as ApiAssertion['op'] })}>
          {ASSERTION_OPS.map((op) => (
            <option key={op} value={op}>
              {ASSERTION_OP_LABELS[op]}
            </option>
          ))}
        </Select>
        {needsValue ? (
          <Input value={assertion.value ?? ''} onChange={(event) => onChange({ ...assertion, value: event.target.value })} placeholder="Value" className="font-mono text-xs" />
        ) : (
          <span className="hidden sm:block" />
        )}
        <Button variant="ghost" size="icon" onClick={onRemove} aria-label="Remove this check">
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {result && (
        <p className={cn('mt-1 text-2xs', result.ok ? 'text-[var(--status-resolved)]' : 'text-[var(--priority-urgent)]')}>
          {result.ok ? 'Passes now' : 'Fails now'}: found {result.actual === null ? 'nothing' : <code className="font-mono">{result.actual.length > 60 ? `${result.actual.slice(0, 60)}…` : result.actual}</code>}
        </p>
      )}
    </li>
  );
}

/* -------------------------------- Response -------------------------------- */

function ResponseView({ result, onPick }: { result: ApiTryResult; onPick: (assertion: ApiAssertion) => void }) {
  const [tab, setTab] = useState<'body' | 'headers'>(result.json !== undefined ? 'body' : 'body');
  return (
    <div className="space-y-2 rounded-sm border p-2.5 surface">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={cn('rounded-[3px] px-1.5 py-0.5 font-mono font-semibold', result.ok ? 'bg-[var(--status-resolved)]/15 text-[var(--status-resolved)]' : 'bg-[var(--priority-urgent)]/12 text-[var(--priority-urgent)]')}
        >
          {result.status ?? 'No response'} {result.statusText}
        </span>
        {result.latencyMs !== null && <span className="text-muted">{result.latencyMs} ms</span>}
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-subtle" title={result.url}>
          {result.url}
        </span>
      </div>
      <p className={cn('text-xs', result.ok ? 'text-[var(--status-resolved)]' : 'text-[var(--priority-urgent)]')}>
        {result.ok ? 'This would pass: ' : 'This would fail: '}
        {result.message}
      </p>
      {result.status !== null && (
        <>
          <div className="flex gap-3 border-b text-xs">
            {(['body', 'headers'] as const).map((value) => (
              <button key={value} type="button" onClick={() => setTab(value)} className={cn('-mb-px border-b-2 pb-1 capitalize', tab === value ? 'border-[var(--fg)] font-medium' : 'border-transparent text-muted')}>
                {value}
              </button>
            ))}
            {result.json !== undefined && tab === 'body' && <span className="ml-auto pb-1 text-2xs text-muted">Click a value to monitor it</span>}
          </div>
          <div className="max-h-80 overflow-auto rounded-sm border p-2 font-mono text-2xs surface-2">
            {tab === 'headers' ? (
              <ul className="space-y-0.5">
                {Object.entries(result.headers).map(([name, value]) => (
                  <li key={name} className="break-all">
                    <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => onPick({ source: 'header', path: name, op: 'eq', value })} title="Monitor this header">
                      {name}
                    </button>
                    : {value}
                  </li>
                ))}
              </ul>
            ) : result.json !== undefined ? (
              <JsonNode value={result.json} path="" onPick={onPick} depth={0} />
            ) : (
              <pre className="whitespace-pre-wrap break-all">{result.body || '(empty body)'}</pre>
            )}
            {result.truncated && <p className="mt-1 text-subtle">Only the first 64 KB is shown and checked.</p>}
          </div>
        </>
      )}
    </div>
  );
}

const childPath = (parent: string, key: string | number) =>
  typeof key === 'number' ? `${parent}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? (parent ? `${parent}.${key}` : key) : `${parent}["${key}"]`;

/** A collapsible JSON tree; clicking a leaf adds "path equals value", clicking an array adds a length check. */
function JsonNode({ value, path, onPick, depth, name }: { value: unknown; path: string; onPick: (a: ApiAssertion) => void; depth: number; name?: ReactNode }) {
  const [open, setOpen] = useState(depth < 2);
  const label = name !== undefined ? <span className="text-[var(--fg-muted)]">{name}: </span> : null;

  if (value !== null && typeof value === 'object') {
    const entries: Array<[string | number, unknown]> = Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value);
    return (
      <div>
        <span className="inline-flex items-center">
          <button type="button" onClick={() => setOpen(!open)} className="text-[var(--fg-subtle)]" aria-label={open ? 'Collapse' : 'Expand'}>
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
          {label}
          {Array.isArray(value) ? (
            <button
              type="button"
              className="text-[var(--fg-subtle)] hover:text-[var(--accent)]"
              title="Monitor how many items there are"
              onClick={() => onPick({ source: 'json', path: path ? `${path}.length` : 'length', op: 'gte', value: String(value.length) })}
            >
              [{value.length} items]
            </button>
          ) : (
            <span className="text-[var(--fg-subtle)]">{'{…}'}</span>
          )}
        </span>
        {open && (
          <div className="ml-3 border-l pl-2">
            {entries.slice(0, 200).map(([key, child]) => (
              <JsonNode key={String(key)} value={child} path={childPath(path, key)} onPick={onPick} depth={depth + 1} name={String(key)} />
            ))}
            {entries.length > 200 && <p className="text-subtle">…{entries.length - 200} more</p>}
          </div>
        )}
      </div>
    );
  }

  const text = value === null ? 'null' : typeof value === 'string' ? `"${value}"` : String(value);
  return (
    <div className="ml-3">
      {label}
      <button
        type="button"
        onClick={() => onPick({ source: 'json', path, op: 'eq', value: value === null ? 'null' : String(value) })}
        className={cn(
          'rounded-[2px] px-0.5 text-left break-all hover:bg-[var(--accent)]/15',
          typeof value === 'string' ? 'text-[#3f9d4e]' : typeof value === 'number' ? 'text-[#2f80ed]' : 'text-[#c2418f]',
        )}
        title={`Monitor ${path || 'this value'}`}
      >
        {text.length > 200 ? `${text.slice(0, 200)}…` : text}
      </button>
    </div>
  );
}
