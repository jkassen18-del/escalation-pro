import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, Info, Link as LinkIcon, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A small Markdown renderer for the documentation pages.
 *
 * It builds React elements directly and never produces an HTML string, so
 * there is nothing to sanitise: text is always text, and a link only becomes
 * a link when its target is a docs page, an app route, or an http(s)/mailto
 * address. It covers what the docs use - headings, paragraphs, nested lists,
 * tables, fenced code, block quotes (with Note/Tip/Warning callouts), rules,
 * and inline code, bold, italics and links - and nothing else.
 */

export interface Heading {
  depth: number;
  text: string;
  id: string;
}

type Block =
  | { type: 'heading'; depth: number; text: string; id: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'quote'; lines: string[] }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'table'; header: string[]; align: Array<'left' | 'center' | 'right' | null>; rows: string[][] }
  | { type: 'rule' };

interface ListItem {
  text: string;
  children: Block[];
}

/** GitHub-style heading slugs, so `#the-alert-pipeline` style links keep working. */
export function slugify(text: string): string {
  return plainInline(text)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

/** Inline markup stripped, for slugs, search and the "On this page" list. */
export function plainInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1$2');
}

const FENCE = /^\s*```\s*([\w+-]*)\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  // Split on pipes that are not escaped and not inside inline code.
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i];
    if (char === '`') inCode = !inCode;
    if (char === '\\' && row[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const used = new Map<string, number>();
  return parseLines(lines, used);
}

function uniqueId(text: string, used: Map<string, number>): string {
  const base = slugify(text) || 'section';
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return seen ? `${base}-${seen}` : base;
}

function parseLines(lines: string[], used: Map<string, number>): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const indent = line.match(/^\s*/)![0].length;
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i].slice(Math.min(indent, lines[i].match(/^\s*/)![0].length)));
        i += 1;
      }
      i += 1;
      blocks.push({ type: 'code', lang: fence[1] ?? '', code: code.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const text = heading[2];
      blocks.push({ type: 'heading', depth: heading[1].length, text, id: uniqueId(text, used) });
      i += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', lines: quote });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
      });
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { block, next } = parseList(lines, i, used);
      blocks.push(block);
      i = next;
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]))
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }
  return blocks;
}

function parseList(lines: string[], start: number, used: Map<string, number>): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[start])!;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]);
    if (!match || match[1].length !== baseIndent) break;
    if (/\d/.test(match[2]) !== ordered) break;
    const text: string[] = [match[3]];
    const body: string[] = [];
    i += 1;
    // Continuation lines and nested content: anything indented past the marker,
    // and blank lines followed by indented content.
    while (i < lines.length) {
      const current = lines[i];
      if (!current.trim()) {
        const nextLine = lines[i + 1];
        if (nextLine !== undefined && nextLine.match(/^\s*/)![0].length > baseIndent && nextLine.trim()) {
          body.push('');
          i += 1;
          continue;
        }
        break;
      }
      const indent = current.match(/^\s*/)![0].length;
      if (indent <= baseIndent) break;
      if (!body.length && !LIST_ITEM.test(current) && !FENCE.test(current) && !/^\s*\|/.test(current) && !/^\s*>/.test(current)) {
        text.push(current.trim());
      } else {
        body.push(current);
      }
      i += 1;
    }
    const minIndent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length), Infinity);
    const children = body.length ? parseLines(body.map((l) => l.slice(Number.isFinite(minIndent) ? minIndent : 0)), used) : [];
    items.push({ text: text.join(' '), children });
    while (i < lines.length && !lines[i].trim() && LIST_ITEM.test(lines[i + 1] ?? '') && LIST_ITEM.exec(lines[i + 1])![1].length === baseIndent) {
      i += 1;
    }
  }
  return { block: { type: 'list', ordered, items }, next: i };
}

export function headingsOf(blocks: Block[]): Heading[] {
  const out: Heading[] = [];
  const walk = (list: Block[]) => {
    for (const block of list) {
      if (block.type === 'heading') out.push({ depth: block.depth, text: plainInline(block.text), id: block.id });
      if (block.type === 'list') for (const item of block.items) walk(item.children);
    }
  };
  walk(blocks);
  return out;
}

/** Every link target in a page, for the docs link checker. */
export function linksOf(source: string): string[] {
  const out: string[] = [];
  for (const block of parseMarkdown(source)) collectLinks(block, out);
  return out;
}

function collectLinks(block: Block, out: string[]) {
  const scan = (text: string) => {
    const withoutCode = text.replace(/`[^`]*`/g, '');
    for (const match of withoutCode.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) out.push(match[1]);
  };
  if (block.type === 'heading' || block.type === 'paragraph') scan(block.text);
  if (block.type === 'quote') scan(block.lines.join(' '));
  if (block.type === 'table') [...block.header, ...block.rows.flat()].forEach(scan);
  if (block.type === 'list')
    for (const item of block.items) {
      scan(item.text);
      item.children.forEach((child) => collectLinks(child, out));
    }
}

/* -------------------------------- Inline -------------------------------- */

export interface LinkTarget {
  kind: 'docs' | 'app' | 'external' | 'anchor' | 'invalid';
  to: string;
}

/**
 * Where a Markdown link points. `monitoring.md#heartbeats` and `/docs/monitoring`
 * are docs pages; other absolute paths are app routes; only http(s) and mailto
 * leave the app. Anything else (javascript:, data:, ...) is not a link.
 */
export function resolveLink(href: string): LinkTarget {
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return { kind: 'external', to: href };
  if (href.startsWith('#')) return { kind: 'anchor', to: href };
  const docs = /^(?:\.\/)?([a-z0-9-]+)\.md(#[\w-]+)?$/i.exec(href);
  if (docs) return { kind: 'docs', to: `/docs/${docs[1]}${docs[2] ?? ''}` };
  if (href.startsWith('/docs')) return { kind: 'docs', to: href };
  if (/^\/[\w/?=&.-]*$/.test(href)) return { kind: 'app', to: href };
  return { kind: 'invalid', to: href };
}

function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const nodes: ReactNode[] = [];
  // code | link | autolink | bold | italic(*) | italic(_)
  const pattern = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]]+)\]\(([^)\s]+)\)|<((?:https?:\/\/|mailto:)[^>\s]+)>|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|(?<![\w_])_([^_\s][^_]*?)_(?![\w_])/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const key = `${keyPrefix}-${index++}`;
    if (match[1]) {
      nodes.push(
        <code key={key} className="rounded-xs bg-[var(--surface-3)] px-1 py-px font-mono text-[0.85em]">
          {match[2]}
        </code>,
      );
    } else if (match[3] !== undefined) {
      nodes.push(<DocLink key={key} href={match[4]}>{renderInline(match[3], key)}</DocLink>);
    } else if (match[5]) {
      nodes.push(<DocLink key={key} href={match[5]}>{match[5]}</DocLink>);
    } else if (match[6] !== undefined) {
      nodes.push(<strong key={key} className="font-semibold">{renderInline(match[6], key)}</strong>);
    } else if (match[7] !== undefined || match[8] !== undefined) {
      nodes.push(<em key={key}>{renderInline((match[7] ?? match[8])!, key)}</em>);
    }
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const linkClass = 'text-[var(--accent)] underline-offset-2 hover:underline';

function DocLink({ href, children }: { href: string; children: ReactNode }) {
  const target = resolveLink(href);
  if (target.kind === 'external') {
    return (
      <a href={target.to} target="_blank" rel="noopener noreferrer" className={linkClass}>
        {children}
      </a>
    );
  }
  if (target.kind === 'anchor') {
    return (
      <a href={target.to} className={linkClass}>
        {children}
      </a>
    );
  }
  if (target.kind === 'docs' || target.kind === 'app') {
    return (
      <Link to={target.to} className={linkClass}>
        {children}
      </Link>
    );
  }
  return <>{children}</>;
}

/* -------------------------------- Blocks -------------------------------- */

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (http, permissions): the text is selectable anyway.
    }
  };
  return (
    <div className="group relative my-3">
      {lang && <span className="absolute top-1.5 left-3 text-2xs uppercase tracking-wide text-subtle">{lang}</span>}
      <button
        type="button"
        onClick={copy}
        className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 rounded-xs border bg-[var(--surface)] px-1.5 py-0.5 text-2xs text-muted opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
        aria-label="Copy code"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className={cn('overflow-x-auto rounded-md border bg-[var(--surface-2)] px-3 pb-3 font-mono text-xs leading-relaxed', lang ? 'pt-6' : 'pt-3')}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Callout({ lines }: { lines: string[] }) {
  const first = lines.join(' ');
  const kind = /^\*\*(warning|important|caution)\b/i.test(first) ? 'warning' : /^\*\*(note|tip|info)\b/i.test(first) ? 'note' : null;
  const inner = parseLines(lines, new Map());
  const Icon = kind === 'warning' ? TriangleAlert : Info;
  return (
    <div
      className={cn(
        'my-3 flex gap-2.5 rounded-md border px-3 py-2.5 text-sm',
        kind === 'warning'
          ? 'border-[var(--priority-high)]/40 bg-[var(--priority-high)]/5'
          : kind === 'note'
            ? 'border-[var(--accent)]/30 bg-[var(--accent)]/5'
            : 'border-l-4 bg-[var(--surface-2)]',
      )}
    >
      {kind && <Icon className={cn('mt-0.5 size-4 shrink-0', kind === 'warning' ? 'text-[var(--priority-high)]' : 'text-[var(--accent)]')} />}
      <div className="min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{renderBlocks(inner, 'q')}</div>
    </div>
  );
}

function HeadingBlock({ depth, text, id }: { depth: number; text: string; id: string }) {
  const sizes: Record<number, string> = {
    1: 'mt-0 mb-3 text-2xl font-semibold tracking-tight',
    2: 'mt-9 mb-3 border-b pb-1.5 text-lg font-semibold tracking-tight',
    3: 'mt-6 mb-2 text-base font-semibold',
    4: 'mt-5 mb-1.5 text-sm font-semibold',
    5: 'mt-4 mb-1 text-sm font-semibold',
    6: 'mt-4 mb-1 text-xs font-semibold uppercase tracking-wide',
  };
  const Tag = `h${depth}` as 'h1';
  return (
    <Tag id={id} className={cn('group scroll-mt-20', sizes[depth])}>
      {renderInline(text, id)}
      {depth > 1 && (
        <a href={`#${id}`} className="ml-1.5 inline-flex align-middle text-[var(--fg-subtle)] opacity-0 transition-opacity group-hover:opacity-100" aria-label="Link to this section">
          <LinkIcon className="size-3.5" />
        </a>
      )}
    </Tag>
  );
}

function renderBlocks(blocks: Block[], keyPrefix: string): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (block.type) {
      case 'heading':
        return <HeadingBlock key={key} depth={block.depth} text={block.text} id={block.id} />;
      case 'paragraph':
        return (
          <p key={key} className="my-3 leading-relaxed">
            {renderInline(block.text, key)}
          </p>
        );
      case 'code':
        return <CodeBlock key={key} code={block.code} lang={block.lang} />;
      case 'quote':
        return <Callout key={key} lines={block.lines} />;
      case 'rule':
        return <hr key={key} className="my-6" />;
      case 'table':
        return (
          <div key={key} className="my-4 overflow-x-auto rounded-md border">
            <table className="w-full border-collapse text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr>
                  {block.header.map((cell, c) => (
                    <th key={c} style={{ textAlign: block.align[c] ?? 'left' }} className="border-b px-3 py-2 font-semibold whitespace-nowrap">
                      {renderInline(cell, `${key}-h${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r} className="border-b last:border-b-0 align-top">
                    {block.header.map((_, c) => (
                      <td key={c} style={{ textAlign: block.align[c] ?? 'left' }} className="px-3 py-2 leading-relaxed">
                        {renderInline(row[c] ?? '', `${key}-${r}-${c}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'list': {
        const ListTag = block.ordered ? 'ol' : 'ul';
        return (
          <ListTag key={key} className={cn('my-3 space-y-1.5 pl-5 leading-relaxed', block.ordered ? 'list-decimal' : 'list-disc')}>
            {block.items.map((item, n) => (
              <li key={n} className="pl-1 [&>div>*:first-child]:mt-1.5">
                {renderInline(item.text, `${key}-${n}`)}
                {item.children.length > 0 && <div>{renderBlocks(item.children, `${key}-${n}`)}</div>}
              </li>
            ))}
          </ListTag>
        );
      }
      default:
        return <Fragment key={key} />;
    }
  });
}

export function Markdown({ blocks }: { blocks: Block[] }) {
  return <div className="text-sm text-[var(--fg)]">{renderBlocks(blocks, 'b')}</div>;
}

export type { Block };
