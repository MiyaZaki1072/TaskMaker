/**
 * Converts "plain text typed by a normal person" into HTML
 *
 * The goal is that problem writers never need to know Markdown:
 *   • One blank line = start a new paragraph
 *   • A line starting with "- " = a bullet item
 *   • A line starting with "1. " = a numbered item
 *   • ```language ... ``` = a code block
 *   • $...$ and $$...$$ = math (KaTeX)
 *   • [b] [i] [u] [s] [hl] [sup] [sub] [big] [small] [color=red] ... [/…] = inline formatting
 *   • lines starting with | = a table; [h]…[/h] alone on a line = a heading; a line of --- = a divider
 * The studio editor's toolbar types these codes; writers can also type them by hand.
 * Everything else can just be typed as continuous text — line wrapping is handled automatically.
 */
import katex from 'katex';
import hljs from 'highlight.js';

export interface RenderContext {
  /** Collected warnings, e.g. a malformed math formula — never fatal, just surfaced to the UI */
  warnings: string[];
  /** Converts an image path into a URL that can actually be opened */
  resolveAsset?: (rawPath: string) => string;
}

export function createContext(): RenderContext {
  return { warnings: [] };
}

const THAI = /[฀-๿]/;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMath(tex: string, displayMode: boolean, ctx?: RenderContext): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: true,
      strict: false,
      output: 'html',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx?.warnings.push(`Math formula "${tex.trim()}" is invalid (${message})`);
    // Don't let it break the whole page — show the raw formula in red so it's obvious where the error is
    return `<span class="math-error" title="${escapeHtml(message)}">${escapeHtml(
      displayMode ? `$$${tex}$$` : `$${tex}$`,
    )}</span>`;
  }
}

/**
 * Renders one line/paragraph of text: escapes HTML, then renders only the math segments.
 * Supports \$ when a literal dollar sign is actually wanted.
 */
export function renderInline(text: string, ctx?: RenderContext): string {
  let out = '';
  let buffer = '';
  let i = 0;

  const flush = () => {
    if (buffer) {
      out += escapeHtml(buffer);
      buffer = '';
    }
  };

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '\\' && text[i + 1] === '$') {
      buffer += '$';
      i += 2;
      continue;
    }

    if (text.startsWith('[img:', i)) {
      const closeBracket = text.indexOf(']', i + 5);
      if (closeBracket !== -1) {
        flush();
        const inner = text.slice(i + 5, closeBracket);
        const [rawSrc, rawCaption, rawSize] = inner.split('|').map((s) => s.trim());
        const src = rawSrc || '';
        const resolved = ctx?.resolveAsset ? ctx.resolveAsset(src) : src;
        const altText = escapeHtml(rawCaption || src);
        const widthStyle = sizeToWidth(rawSize);
        const styleAttr = widthStyle ? ` style="width:${escapeHtml(widthStyle)}"` : '';
        out += `<img class="inline-img" src="${escapeHtml(resolved)}" alt="${altText}"${styleAttr}>`;
        i = closeBracket + 1;
        continue;
      }
    }

    if (text.startsWith('[br]', i)) {
      flush();
      out += '<br>';
      i += 4;
      continue;
    }

    if (ch === '[') {
      const tag = matchInlineTag(text, i);
      if (tag) {
        const closeAt = findTagClose(text, tag.contentStart, tag.name);
        if (closeAt !== -1) {
          flush();
          out += `${tag.open}${renderInline(text.slice(tag.contentStart, closeAt), ctx)}${tag.close}`;
          i = closeAt + `[/${tag.name}]`.length;
          continue;
        }
      }
    }

    if (ch === '$') {
      const display = text[i + 1] === '$';
      const delim = display ? '$$' : '$';
      const closeAt = findClosing(text, i + delim.length, delim);
      if (closeAt === -1) {
        // No closing delimiter — treat it as a plain dollar sign, don't crash
        buffer += ch;
        i += 1;
        continue;
      }
      flush();
      out += renderMath(text.slice(i + delim.length, closeAt), display, ctx);
      i = closeAt + delim.length;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return out;
}

/**
 * Paired inline codes and the HTML they become. The content between them is rendered again, so
 * codes nest ([b][color=red]…[/color][/b]) and math works inside them. An opening code with no
 * matching close is left as plain text, never an error.
 */
const INLINE_TAGS: Record<string, [open: string, close: string]> = {
  b: ['<strong>', '</strong>'],
  i: ['<em>', '</em>'],
  u: ['<u>', '</u>'],
  s: ['<s>', '</s>'],
  sup: ['<sup>', '</sup>'],
  sub: ['<sub>', '</sub>'],
  hl: ['<mark class="text-hl">', '</mark>'],
  big: ['<span class="text-big">', '</span>'],
  small: ['<span class="text-small">', '</span>'],
};

/**
 * [color=…] takes a name from this list only — it becomes a class, never raw CSS, so a problem file
 * cannot inject styles, and every colour is one chosen to stay legible when printed.
 */
export const TEXT_COLORS = ['red', 'blue', 'green', 'orange', 'gray'] as const;

interface InlineTag {
  name: string;
  open: string;
  close: string;
  contentStart: number;
}

function matchInlineTag(text: string, at: number): InlineTag | null {
  const simple = /^\[(b|i|u|s|sup|sub|hl|big|small)\]/.exec(text.slice(at, at + 8));
  if (simple) {
    const [open, close] = INLINE_TAGS[simple[1]!]!;
    return { name: simple[1]!, open, close, contentStart: at + simple[0].length };
  }
  const color = /^\[color=([a-z]+)\]/.exec(text.slice(at, at + 16));
  if (color && (TEXT_COLORS as readonly string[]).includes(color[1]!)) {
    return { name: 'color', open: `<span class="text-${color[1]}">`, close: '</span>', contentStart: at + color[0].length };
  }
  return null;
}

/**
 * Finds the close for a tag, skipping over nested tags of the same name. Only real openers count, so
 * an unsupported [color=purple] inside a [color=red] does not swallow its [/color].
 */
function findTagClose(text: string, from: number, name: string): number {
  const closer = `[/${name}]`;
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== '[') continue;
    if (text.startsWith(closer, i)) {
      if (depth === 0) return i;
      depth -= 1;
      i += closer.length - 1;
    } else {
      const nested = matchInlineTag(text, i);
      if (nested?.name === name) {
        depth += 1;
        i = nested.contentStart - 1;
      }
    }
  }
  return -1;
}

/** Turns an image's optional third pipe field ("300" or "50%") into a CSS width value, or undefined if absent/blank */
function sizeToWidth(raw?: string): string | undefined {
  if (!raw) return undefined;
  return /^\d+$/.test(raw) ? `${raw}px` : raw;
}

function findClosing(text: string, from: number, delim: string): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text.startsWith(delim, i)) return i;
  }
  return -1;
}

/** Joins lines within the same paragraph: Thai text is joined directly, other languages get a space */
function joinLines(lines: string[]): string {
  return lines.reduce((acc, line) => {
    if (!acc) return line;
    const prev = acc.at(-1) ?? '';
    const next = line[0] ?? '';
    const glue = THAI.test(prev) && THAI.test(next) ? '' : ' ';
    return acc + glue + line;
  }, '');
}

function renderCode(code: string, language?: string): string {
  const lang = language && hljs.getLanguage(language) ? language : undefined;
  const html = lang
    ? hljs.highlight(code, { language: lang }).value
    : escapeHtml(code);
  return `<pre class="code-block"><code>${html}</code></pre>`;
}

type Align = 'left' | 'center' | 'right';

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'code'; code: string[]; language?: string }
  | { kind: 'image'; src: string; caption?: string; size?: string }
  | { kind: 'table'; rows: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'divider' }
  | { kind: 'align-start'; align: Align }
  | { kind: 'align-end' }
  | { kind: 'aligned'; align: Align; blocks: Block[] };

/**
 * Groups the flat block list into "aligned" containers wherever [center]/[left]/[right] ... [/…]
 * marker lines appear, so alignment can wrap any run of blocks (paragraphs, images, lists) without
 * the line-by-line scan above needing to track nesting itself. An unclosed marker wraps to the end
 * of the list rather than losing content; a stray closing marker is just ignored.
 */
function groupAlignment(blocks: Block[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;
    if (block.kind === 'align-start') {
      const inner: Block[] = [];
      i += 1;
      while (i < blocks.length && blocks[i]!.kind !== 'align-end') {
        inner.push(blocks[i]!);
        i += 1;
      }
      if (i < blocks.length) i += 1; // consume the matching align-end
      out.push({ kind: 'aligned', align: block.align, blocks: inner });
      continue;
    }
    if (block.kind === 'align-end') {
      i += 1; // stray close with no matching open — ignore it
      continue;
    }
    out.push(block);
    i += 1;
  }
  return out;
}

/**
 * Converts multi-line text (story, explanation) into HTML with paragraphs/bullets laid out properly.
 */
export function renderRich(text: string, ctx?: RenderContext): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let inCode = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const fence = line.trim().match(/^```(\w+)?$/);

    if (fence) {
      if (inCode) {
        inCode = false;
      } else {
        inCode = true;
        blocks.push({ kind: 'code', code: [], language: fence[1] });
      }
      continue;
    }

    if (inCode) {
      const current = blocks.at(-1);
      if (current?.kind === 'code') current.code.push(rawLine);
      continue;
    }

    if (!line.trim()) {
      // Blank line = end of paragraph
      blocks.push({ kind: 'p', lines: [] });
      continue;
    }

    // Standalone [center]/[left]/[right] and [/center]/[/left]/[/right] lines wrap the blocks
    // between them (see groupAlignment) — checked before the other block markers below.
    const alignOpen = line.trim().match(/^\[(left|center|right)\]$/i);
    if (alignOpen) {
      blocks.push({ kind: 'align-start', align: alignOpen[1]!.toLowerCase() as Align });
      continue;
    }
    const alignClose = line.trim().match(/^\[\/(left|center|right)\]$/i);
    if (alignClose) {
      blocks.push({ kind: 'align-end' });
      continue;
    }

    // A line that is only "---" is a divider; [h]…[/h] alone on a line is a heading
    if (line.trim() === '---') {
      blocks.push({ kind: 'divider' });
      continue;
    }
    const heading = line.trim().match(/^\[h\](.*)\[\/h\]$/i);
    if (heading) {
      blocks.push({ kind: 'heading', text: heading[1]!.trim() });
      continue;
    }

    // Consecutive lines starting with | form one table (see renderTable)
    if (line.trim().startsWith('|')) {
      const current = blocks.at(-1);
      if (current?.kind === 'table') current.rows.push(line.trim());
      else blocks.push({ kind: 'table', rows: [line.trim()] });
      continue;
    }

    // Detect a block-level image: [img: assets/xxx], [img: assets/xxx | caption], [img: assets/xxx | caption | size],
    // ![caption](assets/xxx), or img: assets/xxx
    const imgMatch = line.match(/^\s*(?:\[img:\s*([^\]|]+?)(?:\s*\|\s*([^\]]+))?\]|!\[([^\]]*)\]\(([^)]+)\)|img:\s*([^\s]+))\s*$/i);
    if (imgMatch) {
      const src = (imgMatch[1] || imgMatch[4] || imgMatch[5] || '').trim();
      const rest = imgMatch[2] || imgMatch[3] || '';
      const [captionPart, sizePart] = rest.split('|').map((s) => s.trim());
      blocks.push({ kind: 'image', src, caption: captionPart || undefined, size: sizePart || undefined });
      continue;
    }

    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const last = blocks.at(-1);

    if (bullet) {
      if (last?.kind === 'ul') last.items.push(bullet[1]!);
      else blocks.push({ kind: 'ul', items: [bullet[1]!] });
      continue;
    }
    if (ordered) {
      if (last?.kind === 'ol') last.items.push(ordered[1]!);
      else blocks.push({ kind: 'ol', items: [ordered[1]!] });
      continue;
    }

    if (last?.kind === 'p' && last.lines.length > 0) last.lines.push(line.trim());
    else if (last?.kind === 'p' && last.lines.length === 0) last.lines.push(line.trim());
    else blocks.push({ kind: 'p', lines: [line.trim()] });
  }

  return renderBlocksToHtml(groupAlignment(blocks), ctx).join('\n');
}

/**
 * Splits one "| a | b |" row into cells. A | does not split a cell when it is inside $math$ (so
 * $|a-b|$ works), inside [img: path | caption], or escaped as \|.
 */
function splitTableRow(row: string): string[] {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);

  const cells: string[] = [];
  let cell = '';
  let math: '' | '$' | '$$' = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (ch === '\\' && text[i + 1] === '$') {
      cell += '\\$';
      i += 1;
    } else if (ch === '$') {
      const delim = text[i + 1] === '$' ? '$$' : '$';
      if (!math) math = delim;
      else if (math === delim) math = '';
      cell += delim;
      i += delim.length - 1;
    } else if (!math && text.startsWith('[img:', i) && text.indexOf(']', i) !== -1) {
      const close = text.indexOf(']', i);
      cell += text.slice(i, close + 1);
      i = close;
    } else if (ch === '|' && !math) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

const isSeparatorRow = (cells: string[]) => cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));

/**
 * A table from "| a | b |" rows. A separator row (| --- | :---: |) straight after the first row
 * makes that row the header and sets each column's alignment. Rows with fewer cells are padded so
 * the grid stays rectangular; cells are rendered like any other inline text (bold, math, images).
 */
function renderTable(rows: string[], ctx?: RenderContext): string {
  const parsed = rows.map(splitTableRow);
  const hasHeader = parsed.length > 1 && isSeparatorRow(parsed[1]!) && !isSeparatorRow(parsed[0]!);
  const aligns = hasHeader
    ? parsed[1]!.map((cell) => (cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : ''))
    : [];
  const content = parsed.filter((cells) => !isSeparatorRow(cells));
  const width = Math.max(0, ...content.map((cells) => cells.length));

  const renderRow = (cells: string[], tag: 'th' | 'td') =>
    '<tr>' +
    Array.from({ length: width }, (_, col) => {
      const align = aligns[col] ? ` class="cell-${aligns[col]}"` : '';
      return `<${tag}${align}>${renderInline(cells[col] ?? '', ctx)}</${tag}>`;
    }).join('') +
    '</tr>';

  const [first, ...rest] = content;
  const head = hasHeader && first ? `<thead>${renderRow(first, 'th')}</thead>` : '';
  const bodyRows = hasHeader ? rest : content;
  return `<table class="rich-table">${head}<tbody>${bodyRows.map((cells) => renderRow(cells, 'td')).join('')}</tbody></table>`;
}

function renderBlocksToHtml(blocks: Block[], ctx?: RenderContext): string[] {
  const html: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'p') {
      if (block.lines.length === 0) continue;
      html.push(`<p>${renderInline(joinLines(block.lines), ctx)}</p>`);
    } else if (block.kind === 'code') {
      html.push(renderCode(block.code.join('\n').replace(/\s+$/, ''), block.language));
    } else if (block.kind === 'image') {
      const resolved = ctx?.resolveAsset ? ctx.resolveAsset(block.src) : block.src;
      const captionHtml = block.caption ? `<figcaption>${renderInline(block.caption, ctx)}</figcaption>` : '';
      const width = sizeToWidth(block.size);
      const styleAttr = width ? ` style="width:${escapeHtml(width)}"` : '';
      html.push(
        `<figure class="story-figure"${styleAttr}><img src="${escapeHtml(resolved)}" alt="${escapeHtml(
          block.caption || block.src,
        )}"${styleAttr}>${captionHtml}</figure>`,
      );
    } else if (block.kind === 'table') {
      html.push(renderTable(block.rows, ctx));
    } else if (block.kind === 'heading') {
      html.push(`<h3 class="rich-heading">${renderInline(block.text, ctx)}</h3>`);
    } else if (block.kind === 'divider') {
      html.push('<hr class="rich-divider">');
    } else if (block.kind === 'aligned') {
      html.push(`<div class="align-${block.align}">${renderBlocksToHtml(block.blocks, ctx).join('\n')}</div>`);
    } else if (block.kind === 'align-start' || block.kind === 'align-end') {
      // groupAlignment() consumes these before we get here; nothing to render if one ever slips through
      continue;
    } else {
      const tag = block.kind;
      const items = block.items.map((item) => `<li>${renderInline(item, ctx)}</li>`).join('');
      html.push(`<${tag} class="rich-list">${items}</${tag}>`);
    }
  }
  return html;
}
