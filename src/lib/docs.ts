import manifest from '../../docs/manifest.json';
import { headingsOf, parseMarkdown, plainInline, type Block, type Heading } from '@/lib/markdown';

/**
 * The documentation, bundled into the client: one markdown file per page under
 * docs/ at the repository root, ordered by docs/manifest.json. Bundling (rather
 * than fetching) keeps it working offline and inside the portable exe.
 */

const sources = import.meta.glob('../../docs/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface DocPage {
  slug: string;
  title: string;
  section: string;
  /** An app route this page explains, for the "Open in app" button. */
  app?: string;
  blocks: Block[];
  headings: Heading[];
}

export interface DocSection {
  title: string;
  pages: DocPage[];
}

function sourceFor(slug: string): string {
  return sources[`../../docs/${slug}.md`] ?? `# ${slug}\n\nThis page is missing.`;
}

export const DOC_SECTIONS: DocSection[] = manifest.sections.map((section) => ({
  title: section.title,
  pages: section.pages.map((page) => {
    const blocks = parseMarkdown(sourceFor(page.slug));
    return {
      slug: page.slug,
      title: page.title,
      section: section.title,
      app: 'app' in page ? (page as { app?: string }).app : undefined,
      blocks,
      headings: headingsOf(blocks),
    };
  }),
}));

export const DOC_PAGES: DocPage[] = DOC_SECTIONS.flatMap((section) => section.pages);

export function findDoc(slug: string | undefined): DocPage | undefined {
  return DOC_PAGES.find((page) => page.slug === slug);
}

/* --------------------------------- Search -------------------------------- */

interface SearchEntry {
  page: DocPage;
  /** The heading this text sits under; null for the page's introduction. */
  heading: Heading | null;
  text: string;
  lower: string;
}

function blockText(block: Block): string {
  switch (block.type) {
    case 'heading':
      return '';
    case 'paragraph':
      return plainInline(block.text);
    case 'code':
      return block.code;
    case 'quote':
      return plainInline(block.lines.join(' '));
    case 'list':
      return block.items.map((item) => plainInline(item.text)).join(' · ');
    case 'table':
      return [block.header, ...block.rows].map((row) => row.map(plainInline).join(' | ')).join(' · ');
    default:
      return '';
  }
}

let index: SearchEntry[] | null = null;

function searchIndex(): SearchEntry[] {
  if (index) return index;
  index = [];
  for (const page of DOC_PAGES) {
    let heading: Heading | null = null;
    let parts: string[] = [];
    const flush = () => {
      const text = parts.join(' ').replace(/\s+/g, ' ').trim();
      const title = heading ? heading.text : page.title;
      if (text || heading) index!.push({ page, heading, text: `${title}. ${text}`, lower: `${title} ${text}`.toLowerCase() });
      parts = [];
    };
    for (const block of page.blocks) {
      if (block.type === 'heading' && block.depth > 1) {
        flush();
        heading = { depth: block.depth, text: plainInline(block.text), id: block.id };
      } else if (block.type !== 'heading') {
        parts.push(blockText(block));
      }
    }
    flush();
  }
  return index;
}

export interface SearchHit {
  page: DocPage;
  heading: Heading | null;
  snippet: string;
  terms: string[];
}

/** Every term must appear; titles and headings count for more than body text. */
export function searchDocs(query: string, limit = 30): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1).slice(0, 8);
  if (!terms.length) return [];
  const scored: Array<SearchHit & { score: number }> = [];
  for (const entry of searchIndex()) {
    if (!terms.every((term) => entry.lower.includes(term))) continue;
    const title = `${entry.page.title} ${entry.heading?.text ?? ''}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 5;
      score += Math.min(entry.lower.split(term).length - 1, 5);
    }
    if (!entry.heading) score += 1;
    scored.push({ page: entry.page, heading: entry.heading, snippet: snippetOf(entry.text, terms), terms, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

function snippetOf(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const first = Math.min(...terms.map((term) => lower.indexOf(term)).filter((at) => at >= 0));
  const start = Math.max(0, first - 60);
  const end = Math.min(text.length, start + 200);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
