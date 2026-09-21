import sanitizeHtml from 'sanitize-html';

/**
 * Server-side sanitisation for ticket descriptions and comments.
 *
 * Rich text is pasted in from Word, Outlook and web pages, which means the
 * markup arriving here is arbitrary and occasionally hostile. The client also
 * cleans what it pastes, but that is a convenience for the person typing -
 * this is the boundary that actually decides what gets stored, because a
 * request can be made without going anywhere near the editor.
 *
 * Allow-list, never deny-list: anything not named here is dropped.
 */
const ALLOWED_TAGS = [
  'p', 'br', 'div', 'span',
  'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code',
  'a', 'img',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'hr',
];

/**
 * Inline styles are the main thing that survives a paste from Word, so a
 * narrow set is kept to preserve intent. Anything that could position an
 * element over the rest of the page is not on the list.
 */
const ALLOWED_STYLES = {
  '*': {
    'text-align': [/^(left|right|center|justify)$/],
    'font-weight': [/^(normal|bold|[1-9]00)$/],
    'font-style': [/^(normal|italic)$/],
    'text-decoration': [/^(none|underline|line-through)$/],
    // Hex, rgb() and named colours only - no url() and no expressions.
    color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i, /^[a-z]+$/i],
    'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i, /^[a-z]+$/i],
  },
} satisfies sanitize_html_styles;

type sanitize_html_styles = Record<string, Record<string, RegExp[]>>;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    col: ['span'],
    '*': ['style'],
  },
  allowedStyles: ALLOWED_STYLES,
  // javascript:, vbscript: and friends never reach an href or a src.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // Images may also be inline data, which is how a pasted screenshot arrives
  // before it is extracted into an attachment.
  allowedSchemesByTag: { img: ['http', 'https', 'data'], a: ['http', 'https', 'mailto', 'tel'] },
  allowProtocolRelative: false,
  // Drop the contents of anything not allowed, rather than unwrapping it -
  // otherwise a <script> body would survive as visible text.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed'],
  transformTags: {
    // An untrusted link opening in a new tab can reach back through
    // window.opener unless it is told not to.
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
    }),
    // Word and Outlook emit <font> and presentational tags that carry no
    // meaning here; map the common ones onto semantic equivalents.
    font: 'span',
    center: 'div',
  },
};

/** Images pasted inline, before extraction, must still be real images. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

export function sanitizeRichText(html: string): string {
  const cleaned = sanitizeHtml(html, OPTIONS);

  // sanitize-html permits any data: URI on an img once the scheme is allowed,
  // so the payload itself is checked here: an image, base64, nothing else.
  return sanitizeHtml(cleaned, {
    ...OPTIONS,
    exclusiveFilter: (frame) => {
      if (frame.tag !== 'img') return false;
      const src = frame.attribs.src ?? '';
      return src.startsWith('data:') && !DATA_IMAGE.test(src);
    },
  });
}

/**
 * True when the markup carries nothing a reader would see.
 *
 * `<p><br></p>` is what an emptied contentEditable leaves behind, and it
 * should count as an empty description rather than as content.
 */
export function isEffectivelyEmpty(html: string): boolean {
  const withoutMedia = html.replace(/<img\b[^>]*>/gi, 'x');
  const text = sanitizeHtml(withoutMedia, { allowedTags: [], allowedAttributes: {} });
  return text.replace(/&nbsp;/gi, ' ').trim().length === 0;
}

/** Plain-text rendering, for notification bodies and search previews. */
export function richTextToPlain(html: string): string {
  const spaced = html
    .replace(/<\/(p|div|h[1-6]|blockquote|pre|table)>/gi, '\n\n')
    .replace(/<\/(li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  return sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
