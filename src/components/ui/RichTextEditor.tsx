import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Bold,
  Code2,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A small rich text editor built on contentEditable.
 *
 * contentEditable is what makes "paste from Word, Outlook or a web page and
 * keep the formatting" work without any code: the browser converts the
 * clipboard's HTML flavour itself. A custom editor would have to reimplement
 * that conversion for every source.
 *
 * What arrives that way is arbitrary markup, so it is cleaned on the way in -
 * but only as a convenience for the person typing. The server sanitises again
 * on save, and that is the check that actually protects readers.
 */

/** Mirrors the server's allow-list closely enough to avoid surprises on save. */
const ALLOWED = new Set([
  'P', 'BR', 'DIV', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'DEL', 'INS', 'MARK', 'SUB', 'SUP',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'A', 'IMG',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'COLGROUP', 'COL', 'HR',
]);
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  A: new Set(['href', 'title']),
  IMG: new Set(['src', 'alt', 'title', 'width', 'height']),
  TD: new Set(['colspan', 'rowspan']),
  TH: new Set(['colspan', 'rowspan', 'scope']),
  COL: new Set(['span']),
};
const SAFE_STYLE = /^(text-align|font-weight|font-style|text-decoration|color|background-color)$/;
const SAFE_URL = /^(https?:|mailto:|tel:)/i;
const SAFE_IMAGE = /^(data:image\/(png|jpeg|gif|webp);base64,|\/api\/tickets\/)/i;

function cleanNode(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) return;
  if (node.nodeType !== Node.ELEMENT_NODE) {
    node.parentNode?.removeChild(node);
    return;
  }

  const element = node as HTMLElement;

  if (!ALLOWED.has(element.tagName)) {
    // Unwrap rather than delete, so the words inside a <font> or <section>
    // survive even though the tag does not.
    const parent = element.parentNode;
    if (!parent) return;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    parent.removeChild(element);
    return;
  }

  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name === 'style') {
      const keep = [...element.style]
        .filter((property) => SAFE_STYLE.test(property))
        .map((property) => `${property}:${element.style.getPropertyValue(property)}`)
        .join(';');
      element.setAttribute('style', keep);
      if (!keep) element.removeAttribute('style');
      continue;
    }
    const allowed = ALLOWED_ATTRS[element.tagName];
    if (!allowed?.has(name)) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (element.tagName === 'A' && name === 'href' && !SAFE_URL.test(attribute.value.trim())) {
      element.removeAttribute(attribute.name);
    }
    if (element.tagName === 'IMG' && name === 'src' && !SAFE_IMAGE.test(attribute.value.trim())) {
      element.remove();
      return;
    }
  }

  for (const child of [...element.childNodes]) cleanNode(child);
}

function cleanHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const child of [...template.content.childNodes]) cleanNode(child);
  return template.innerHTML;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Matches the server's per-image cap, so an oversized paste fails immediately. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  minHeight?: number;
  /** Surfaced to the caller so an oversized image can be reported in a toast. */
  onError?: (message: string) => void;
  ariaLabel?: string;
}

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  className,
  minHeight = 140,
  onError,
  ariaLabel,
}: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);
  const labelId = useId();

  // Only write into the DOM when the value differs, otherwise every keystroke
  // would reset the caret to the start of the field.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.innerHTML !== value) editor.innerHTML = value;
    setIsEmpty(editor.textContent?.trim().length === 0 && !editor.querySelector('img'));
  }, [value]);

  const emit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    setIsEmpty(editor.textContent?.trim().length === 0 && !editor.querySelector('img'));
    onChange(editor.innerHTML);
  }, [onChange]);

  const exec = useCallback(
    (command: string, argument?: string) => {
      editorRef.current?.focus();
      // execCommand is formally deprecated but is still the only API every
      // browser implements for this, and it keeps undo history intact.
      document.execCommand(command, false, argument);
      emit();
    },
    [emit],
  );

  const insertImages = useCallback(
    async (files: File[]) => {
      const usable = files.filter((file) => IMAGE_TYPES.has(file.type));
      for (const file of usable) {
        if (file.size > MAX_IMAGE_BYTES) {
          onError?.(`Images must be ${MAX_IMAGE_BYTES / 1024 / 1024}MB or smaller.`);
          continue;
        }
        try {
          // Inserted inline; the server turns each one into a real attachment
          // on save, so nothing here depends on the ticket existing yet.
          const dataUrl = await readFileAsDataUrl(file);
          exec('insertHTML', `<img src="${dataUrl}" alt="${file.name.replace(/"/g, '')}">`);
        } catch {
          onError?.('That image could not be read.');
        }
      }
      return usable.length;
    },
    [exec, onError],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length > 0) {
        event.preventDefault();
        void insertImages(files);
        return;
      }

      const html = event.clipboardData?.getData('text/html');
      if (html) {
        // Let the browser convert the clipboard, then strip what the server
        // would reject anyway so the editor shows what will actually be saved.
        event.preventDefault();
        document.execCommand('insertHTML', false, cleanHtml(html));
        emit();
      }
    },
    [emit, insertImages],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const files = [...(event.dataTransfer?.files ?? [])].filter((file) => IMAGE_TYPES.has(file.type));
      if (files.length === 0) return;
      event.preventDefault();
      void insertImages(files);
    },
    [insertImages],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const shortcuts: Record<string, string> = { b: 'bold', i: 'italic', u: 'underline' };
      const command = shortcuts[event.key.toLowerCase()];
      if (command) {
        event.preventDefault();
        exec(command);
      }
    },
    [exec],
  );

  const addLink = useCallback(() => {
    const url = window.prompt('Link address');
    if (!url) return;
    if (!SAFE_URL.test(url.trim())) {
      onError?.('Links must start with http://, https://, mailto: or tel:.');
      return;
    }
    exec('createLink', url.trim());
  }, [exec, onError]);

  const tools: Array<{ icon: typeof Bold; label: string; run: () => void }> = [
    { icon: Bold, label: 'Bold', run: () => exec('bold') },
    { icon: Italic, label: 'Italic', run: () => exec('italic') },
    { icon: Underline, label: 'Underline', run: () => exec('underline') },
    { icon: Strikethrough, label: 'Strikethrough', run: () => exec('strikeThrough') },
    { icon: List, label: 'Bulleted list', run: () => exec('insertUnorderedList') },
    { icon: ListOrdered, label: 'Numbered list', run: () => exec('insertOrderedList') },
    { icon: Quote, label: 'Quote', run: () => exec('formatBlock', 'blockquote') },
    { icon: Code2, label: 'Code block', run: () => exec('formatBlock', 'pre') },
    { icon: Link2, label: 'Link', run: addLink },
    { icon: Undo2, label: 'Undo', run: () => exec('undo') },
    { icon: Redo2, label: 'Redo', run: () => exec('redo') },
  ];

  return (
    <div
      className={cn(
        'rounded-sm border bg-[var(--surface)] transition-colors',
        focused ? 'border-[var(--focus)] ring-1 ring-[var(--focus)]' : 'border-[var(--border-strong)]',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--border)] px-1 py-1">
        {tools.map((tool) => (
          <button
            key={tool.label}
            type="button"
            title={tool.label}
            aria-label={tool.label}
            // Keeps the selection alive: a focus change would collapse it
            // before the command runs.
            onMouseDown={(event) => event.preventDefault()}
            onClick={tool.run}
            className="rounded-[3px] p-1.5 text-[var(--fg-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--fg)]"
          >
            <tool.icon className="size-3.5" aria-hidden />
          </button>
        ))}
      </div>

      <div className="relative">
        {isEmpty && placeholder && (
          <span
            id={labelId}
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-2 text-sm text-[var(--fg-subtle)]"
          >
            {placeholder}
          </span>
        )}
        <div
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel ?? placeholder}
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          onBlur={() => {
            setFocused(false);
            emit();
          }}
          onFocus={() => setFocused(true)}
          onPaste={onPaste}
          onDrop={onDrop}
          onKeyDown={onKeyDown}
          style={{ minHeight }}
          className="rich-text w-full px-2.5 py-2 text-sm leading-relaxed outline-none"
        />
      </div>
    </div>
  );
}
