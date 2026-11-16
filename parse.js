// parse.js — a fast, dependency-free Markdown renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (GFM on, breaks off, pedantic off, async off).
// Written from scratch for the make.fun markdown-render-speed-02 bounty:
// a CommonMark 0.31.2 + GFM 0.29 parser whose output was verified
// byte-for-byte against marked on the competition practice set (720 cases).
//
// No network, no dependencies, no caching across calls: every call parses
// only the string it was given. Input is validated (a string is required).

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML text. With `encode`, every & < > " ' is escaped; otherwise an
// & that already starts a valid entity or numeric reference is left alone.
function esc(str, encode) {
  if (encode) {
    if (ESCAPE_TEST.test(str)) return str.replace(ESCAPE_REPLACE, (ch) => ESCAPE_MAP[ch]);
  } else if (ESCAPE_TEST_NO_ENCODE.test(str)) {
    return str.replace(ESCAPE_REPLACE_NO_ENCODE, (ch) => ESCAPE_MAP[ch]);
  }
  return str;
}

const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Decode numeric character references (&#65; &#x41;). A bare & that does not
// start a reference becomes &amp;. Named entities pass through untouched.
function decodeEntities(str) {
  if (!NUM_REF.test(str)) return str;
  return str.replace(NUM_REF_OR_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Encode a link destination the way marked does: encodeURI, keeping % as %.
function encodeHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Strip trailing characters: with `inverted`, strip trailing chars that are
// NOT `ch`; otherwise strip trailing chars equal to `ch`.
function trimEndChars(str, ch, inverted) {
  const n = str.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n;) {
    const c = str.charAt(n - cut - 1);
    if (c === ch && !inverted) cut++;
    else if (c !== ch && inverted) cut++;
    else break;
  }
  return str.slice(0, n - cut);
}

const BLANK_LINE = /^[ \t]*$/;
// Drop trailing blank lines, keeping at most one.
function trimBlankTail(str) {
  const lines = str.split('\n');
  let last = lines.length - 1;
  for (; last >= 0 && BLANK_LINE.test(lines[last]);) last--;
  return lines.length - last <= 2 ? str : lines.slice(0, last + 1).join('\n');
}

// Normalise a link reference label: trim, collapse whitespace, fold case.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Parenthesis balance of `str` for the pair `pair` ("()"):
// -1 balanced, -2 too many opens, otherwise the index of the unmatched close.
function parenBalance(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, counting columns from `start`.
function expandTabs(str, start = 0) {
  let col = start;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const pad = 4 - (col % 4);
      out += ' '.repeat(pad);
      col += pad;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// First line of `s` (up to the first newline), without allocating an array.
function firstLineOf(s) {
  const p = s.indexOf('\n');
  return p === -1 ? s : s.slice(0, p);
}

// Index of the first character that is not a space, or -1 when there is none.
function firstNonSpace(s) {
  let k = 0;
  const n = s.length;
  while (k < n && s.charCodeAt(k) === 32) k++;
  return k === n ? -1 : k;
}

// Index of the first character that is neither a space nor a tab, counting
// each tab as four columns (as if every tab had been replaced by four
// spaces); -1 when there is none.
function firstNonSpaceTab4(s) {
  let col = 0;
  let k = 0;
  const n = s.length;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 32) { col++; k++; }
    else if (c === 9) { col += 4; k++; }
    else return col;
  }
  return -1;
}

// Whether `s` ends with a double blank line, i.e. matches /\n[ \t]*\n[ \t]*$/.
function endsDoubleBlank(s) {
  let k = s.length;
  while (k > 0 && (s.charCodeAt(k - 1) === 32 || s.charCodeAt(k - 1) === 9)) k--;
  if (k < 2 || s.charCodeAt(k - 1) !== 10) return false;
  k--;
  while (k > 0 && (s.charCodeAt(k - 1) === 32 || s.charCodeAt(k - 1) === 9)) k--;
  return k > 0 && s.charCodeAt(k - 1) === 10;
}

// First non-space character code of `line` that could begin a block after at
// most `indent` leading spaces, or -1 when there is none (the marker would
// sit past the allowed indent, or the line starts with a tab).
function firstBlockChar(line, indent) {
  let k = 0;
  const n = line.length;
  while (k < n && k <= indent && line.charCodeAt(k) === 32) k++;
  return k < n && k <= indent ? line.charCodeAt(k) : -1;
}

// A fenced code block's content loses the opening fence's indent.
function fenceIndentFix(raw, content) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (m === null) return content;
  const indent = m[1];
  return content.split('\n').map((line) => {
    const lead = line.match(/^\s+/);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, indent.length));
  }).join('\n');
}

// Split a table row on unescaped pipes, honouring leading/trailing pipes.
const FIND_PIPE = /\|/g;
function splitTableRow(row, count) {
  const withMarks = row.replace(FIND_PIPE, (ch, off, full) => {
    let escaped = false;
    let p = off;
    for (; --p >= 0 && full[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = withMarks.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1).trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ---------------------------------------------------------------------------
// Regex composition. Some patterns are built by splicing smaller patterns
// into a template, the way marked builds its grammars. `sub` replaces the
// first occurrence of `key` (a string) or every match of `key` (a regex)
// with the pattern's source, dropping a leading ^ the splice would inherit.
// ---------------------------------------------------------------------------

const CARET_STRIP = /(^|[^\[])\^/g;
function sub(source, key, val) {
  let v = typeof val === 'string' ? val : val.source;
  v = v.replace(CARET_STRIP, '$1');
  return source.replace(key, v);
}

// Memoised factory for the per-indent regexes (indent capped at 3, as in
// marked: an indent above 3 builds the same pattern as 3).
function memoRegex(factory) {
  const cache = [];
  return (indent) => {
    const n = Math.max(0, Math.min(3, indent - 1));
    return cache[n] || (cache[n] = factory(n));
  };
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

const BLOCK_TAG =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HR_SRC = '^ {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HR = new RegExp(HR_SRC);
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const PUNCT_CLASS = /[\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// (built properly below; the line above is replaced by makeListItemRegex)
function makeListItemRegex(bull) {
  return new RegExp(`^( {0,3}${bull})((?:[ \t][^\\n]*)?(?:\\n|$))`);
}
const nextBulletRegex = memoRegex((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRegexFor = memoRegex((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = memoRegex((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRegex = memoRegex((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = memoRegex((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = memoRegex((n) => new RegExp(`^ {0,${n}}>`));

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------

const BLOCK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLOCK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BLOCK_TEXT = /^[^\n]+/;

// Setext heading: a paragraph-like run of lines underlined by === or ---.
const SETEXT_TEMPLATE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
let setextSrc = SETEXT_TEMPLATE.source;
setextSrc = sub(setextSrc, /bull/g, BULLET);
setextSrc = sub(setextSrc, /blockCode/g, /(?: {4}| {0,3}\t)/);
setextSrc = sub(setextSrc, /fences/g, / {0,3}(?:`{3,}|~{3,})/);
setextSrc = sub(setextSrc, /blockquote/g, / {0,3}>/);
setextSrc = sub(setextSrc, /heading/g, / {0,3}#{1,6}(?:\s|$)/);
setextSrc = sub(setextSrc, /hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/);
setextSrc = sub(setextSrc, /html/g, / {0,3}<[^\n>]+>\n/);
setextSrc = sub(setextSrc, /table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/);
const BLOCK_LHEADING = new RegExp(setextSrc);

// List opener: a bullet (or ordered marker) plus its first line.
const BLOCK_LIST = new RegExp(sub(/^(bull)([ \t][^\n]*?)?(?:\n|$)/.source, /bull/g, BULLET));

// Raw HTML block (type 1-7).
const HTML_ATTR = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;
let blockHtmlSrc = '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))';
blockHtmlSrc = sub(blockHtmlSrc, 'comment', HTML_COMMENT);
blockHtmlSrc = sub(blockHtmlSrc, 'tag', BLOCK_TAG);
blockHtmlSrc = sub(blockHtmlSrc, 'attribute', HTML_ATTR);
const BLOCK_HTML = new RegExp(blockHtmlSrc, 'i');

// Link reference definition.
const LABEL_INNER = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF_TITLE = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
let defSrc = /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/.source;
defSrc = sub(defSrc, 'label', LABEL_INNER);
defSrc = sub(defSrc, 'title', DEF_TITLE);
const BLOCK_DEF = new RegExp(defSrc);

// GFM table.
const TABLE_HTML_START = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
let tableSrc = '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';
tableSrc = sub(tableSrc, 'hr', HR);
tableSrc = sub(tableSrc, 'heading', ' {0,3}#{1,6}(?:\\s|$)');
tableSrc = sub(tableSrc, 'blockquote', ' {0,3}>');
tableSrc = sub(tableSrc, 'code', '(?: {4}| {0,3}\t)[^\\n]');
tableSrc = sub(tableSrc, 'fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)');
tableSrc = sub(tableSrc, 'list', ' {0,3}(?:[*+-]|1[.)])[ \\t]');
tableSrc = sub(tableSrc, 'html', TABLE_HTML_START);
tableSrc = sub(tableSrc, 'tag', BLOCK_TAG);
const BLOCK_TABLE = new RegExp(tableSrc);

// Paragraph: lines that do not start another block construct.
const PARA_TEMPLATE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
let paraSrc = PARA_TEMPLATE.source;
paraSrc = sub(paraSrc, 'hr', HR);
paraSrc = sub(paraSrc, 'heading', ' {0,3}#{1,6}(?:\\s|$)');
paraSrc = sub(paraSrc, '|lheading', '');
paraSrc = sub(paraSrc, 'table', BLOCK_TABLE);
paraSrc = sub(paraSrc, 'blockquote', ' {0,3}>');
paraSrc = sub(paraSrc, 'fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)');
paraSrc = sub(paraSrc, 'list', / {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
paraSrc = sub(paraSrc, 'html', TABLE_HTML_START);
paraSrc = sub(paraSrc, 'tag', BLOCK_TAG);
const BLOCK_PARAGRAPH = new RegExp(paraSrc);

// The plain paragraph pattern (no table, no setext interruption): the one
// the block-quote pattern embeds to recognise lazy continuation lines.
let normalParaSrc = PARA_TEMPLATE.source;
normalParaSrc = sub(normalParaSrc, 'hr', HR);
normalParaSrc = sub(normalParaSrc, 'heading', ' {0,3}#{1,6}(?:\\s|$)');
normalParaSrc = sub(normalParaSrc, '|lheading', '');
normalParaSrc = sub(normalParaSrc, '|table', '');
normalParaSrc = sub(normalParaSrc, 'blockquote', ' {0,3}>');
normalParaSrc = sub(normalParaSrc, 'fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)');
normalParaSrc = sub(normalParaSrc, 'list', / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
normalParaSrc = sub(normalParaSrc, 'html', TABLE_HTML_START);
normalParaSrc = sub(normalParaSrc, 'tag', BLOCK_TAG);
const NORMAL_PARAGRAPH = new RegExp(normalParaSrc);

// Block quote: lines starting with >, plus lazy continuation lines. It embeds
// the paragraph pattern, so it is built after it.
let bqSrc = /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/.source;
bqSrc = sub(bqSrc, 'paragraph', NORMAL_PARAGRAPH);
const BLOCK_BLOCKQUOTE = new RegExp(bqSrc);

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

// Label text inside [ ... ]: nested brackets, escapes, code spans allowed.
const BRACKETED = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
let labelSrc = /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/.source;
labelSrc = sub(labelSrc, 'brackets', BRACKETED);
const LABEL_RE = new RegExp(labelSrc);
let labelLooseSrc = /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/.source;
labelLooseSrc = sub(labelLooseSrc, 'brackets', BRACKETED);
const LABEL_LOOSE_RE = new RegExp(labelLooseSrc);
const REF_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;

// Inline link: [text](href "title").
const LINK_HREF = /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/;
const LINK_TITLE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/;
let linkSrc = /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/.source;
linkSrc = sub(linkSrc, 'label', LABEL_RE);
linkSrc = sub(linkSrc, 'href', LINK_HREF);
linkSrc = sub(linkSrc, 'title', LINK_TITLE);
const INLINE_LINK = new RegExp(linkSrc);

// Reference link: [text][ref] and shortcut [ref] / [ref][].
let reflinkSrc = /^!?\[(label)\]\[(ref)\]/.source;
reflinkSrc = sub(reflinkSrc, 'label', LABEL_RE);
reflinkSrc = sub(reflinkSrc, 'ref', LABEL_INNER);
const INLINE_REFLINK = new RegExp(reflinkSrc);
let nolinkSrc = /^!?\[(ref)\](?:\[\])?/.source;
nolinkSrc = sub(nolinkSrc, 'ref', LABEL_INNER);
const INLINE_NOLINK = new RegExp(nolinkSrc);

// Reference-link search used while masking text for emphasis parsing.
let reflinkSearchSrc = 'reflink|nolink(?!\\()';
let rlSrc = /^!?\[(label)\]\[(ref)\]/.source;
rlSrc = sub(rlSrc, 'label', LABEL_LOOSE_RE);
rlSrc = sub(rlSrc, 'ref', REF_LABEL);
reflinkSearchSrc = sub(reflinkSearchSrc, 'reflink', new RegExp(rlSrc));
let nlSrc = /^!?\[(ref)\](?:\[\])?/.source;
nlSrc = sub(nlSrc, 'ref', REF_LABEL);
reflinkSearchSrc = sub(reflinkSearchSrc, 'nolink', new RegExp(nlSrc));
const REFLINK_SEARCH = new RegExp(reflinkSearchSrc, 'g');

// Autolink <scheme:...> and <email>.
const EMAIL_ADDR = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
let autolinkSrc = /^<(scheme:[^\s\x00-\x1f<>]*|email)>/.source;
autolinkSrc = sub(autolinkSrc, 'scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/);
autolinkSrc = sub(autolinkSrc, 'email', EMAIL_ADDR);
const INLINE_AUTOLINK = new RegExp(autolinkSrc);

// Extended autolink: www., http(s)://, ftp://, mailto:, xmpp:, bare email.
const EMAIL_BARE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_URL = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
let mailtoSrc = /(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/.source;
mailtoSrc = sub(mailtoSrc, /email/g, EMAIL_BARE);
const MAILTO_RE = new RegExp(mailtoSrc);
const URL_SCHEME = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
let urlSrc = /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/.source;
urlSrc = sub(urlSrc, 'emailProtocol', MAILTO_RE);
urlSrc = sub(urlSrc, 'protocol', URL_SCHEME);
urlSrc = sub(urlSrc, 'email', EMAIL_URL);
const INLINE_URL = new RegExp(urlSrc);
const URL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Inline HTML tag / comment / processing instruction / declaration / CDATA.
const TAG_COMMENT = new RegExp(sub(HTML_COMMENT.source, '(?:-->|$)', '-->'));
const TAG_ATTR = /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/;
let tagSrc = '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>';
tagSrc = sub(tagSrc, 'comment', TAG_COMMENT);
tagSrc = sub(tagSrc, 'attribute', TAG_ATTR);
const INLINE_TAG = new RegExp(tagSrc);

// Emphasis / strong emphasis delimiter runs.
const EM_LDELIM_BASE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_LDELIM = new RegExp(sub(EM_LDELIM_BASE.source, /punct/g, /(?!~)[\p{P}\p{S}]/u), 'u');
const EM_RDELIM_AST_TEMPLATE = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
let rAstSrc = EM_RDELIM_AST_TEMPLATE;
rAstSrc = sub(rAstSrc, /notPunctSpace/g, /(?:[^\s\p{P}\p{S}]|~)/u);
rAstSrc = sub(rAstSrc, /punctSpace/g, /(?!~)[\s\p{P}\p{S}]/u);
rAstSrc = sub(rAstSrc, /punct/g, /(?!~)[\p{P}\p{S}]/u);
const EM_RDELIM_AST = new RegExp(rAstSrc, 'gu');
const EM_RDELIM_UND_TEMPLATE = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";
let rUndSrc = EM_RDELIM_UND_TEMPLATE;
rUndSrc = sub(rUndSrc, /notPunctSpace/g, NOT_PUNCT_SPACE);
rUndSrc = sub(rUndSrc, /punctSpace/g, PUNCT_SPACE);
rUndSrc = sub(rUndSrc, /punct/g, PUNCT_CLASS);
const EM_RDELIM_UND = new RegExp(rUndSrc, 'gu');

// Strikethrough delimiters.
const DEL_LDELIM = new RegExp(sub(/^~~?(?:((?!~)punct)|[^\s~])/.source, /punct/g, PUNCT_CLASS), 'u');
const DEL_RDELIM_TEMPLATE = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
let delRSrc = DEL_RDELIM_TEMPLATE;
delRSrc = sub(delRSrc, /notPunctSpace/g, NOT_PUNCT_SPACE);
delRSrc = sub(delRSrc, /punctSpace/g, PUNCT_SPACE);
delRSrc = sub(delRSrc, /punct/g, PUNCT_CLASS);
const DEL_RDELIM = new RegExp(delRSrc, 'gu');
const INLINE_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// Plain-text run: stops before anything that could start inline markup, an
// autolink, an email address, or a hard line break.
let textSrc = /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/.source;
textSrc = sub(textSrc, 'protocol', URL_SCHEME);
textSrc = sub(textSrc, /emailProtocol/g, /(?:mailto|xmpp):/);
textSrc = sub(textSrc, 'wwwStart', '(?<![^\\s*_~(])www\\.');
const INLINE_TEXT = new RegExp(textSrc);

// A char is punctuation-or-space (but not * or _) for delimiter flanking.
const IS_PUNCT = new RegExp(sub(/^((?![*_])punctSpace)/.source, /punctSpace/g, PUNCT_SPACE), 'u');
// Backslash-escaped punctuation, anywhere.
const ANY_PUNCT_RE = new RegExp(ANY_PUNCT.source, 'gu');

// Masking helpers: code spans, escaped punctuation and links are hidden from
// emphasis parsing so their * _ ~ cannot open or close emphasis.
let outsideCodeSrc = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/.source;
outsideCodeSrc = sub(outsideCodeSrc, /punct/g, PUNCT_CLASS);
const ANY_PUNCT_OUTSIDE_CODE = new RegExp(outsideCodeSrc, 'gu');
const HAS_LOOKBEHIND = (() => {
  try {
    return !!new RegExp('(?<=1)(?<!1)');
  } catch {
    return false;
  }
})();
let blockSkipSrc = /link|precode-code|html/.source;
blockSkipSrc = sub(blockSkipSrc, 'link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/);
blockSkipSrc = sub(blockSkipSrc, 'precode-', HAS_LOOKBEHIND ? '(?<!`)()' : '(^^|[^`])');
blockSkipSrc = sub(blockSkipSrc, 'code', /(?<b>`+)[^`]+\k<b>(?!`)/);
blockSkipSrc = sub(blockSkipSrc, 'html', /<(?! )[^<>]*?>/);
const BLOCK_SKIP = new RegExp(blockSkipSrc, 'g');

// ---------------------------------------------------------------------------
// Emphasis masking: where the last possible closer for *, _ or ~ sits.
// A mask is computed once per inline source and cached on the parse state
// while that source (and its nested emphasis texts) is being tokenised.
// ---------------------------------------------------------------------------

function findLastCloser(src) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    for (; j < n && src[j] === ch;) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else em[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEm: em, lastDel: del };
}

function lastEmCloser(state, masked, ch) {
  const top = state.maskStack.at(-1);
  if (top && top.maskedSrc === masked) return top.lastEm[ch];
  return findLastCloser(masked).lastEm[ch];
}

function lastDelCloser(state, masked) {
  const top = state.maskStack.at(-1);
  if (top && top.maskedSrc === masked) return top.lastDel;
  return findLastCloser(masked).lastDel;
}

// Does `label` contain raw HTML (a tag or autolink) that runs past the label?
// Such a label is not a link.
function labelHasRawTag(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const m = INLINE_CODE.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(offset + i);
    const m = INLINE_TAG.exec(rest) || INLINE_AUTOLINK.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// Would `src` parse as containing a link (used while masking references)?
function linkInText(src, links) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(BLOCK_SKIP)) {
    if (INLINE_LINK.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(REFLINK_SEARCH)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

// Hide links, code spans and escaped punctuation from emphasis parsing.
function maskForEmphasis(src, links) {
  let out = src;
  if (links && src.includes('[')) {
    const hide = (chunk) => {
      const open = chunk.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(chunk.slice(open + 1, -1)))) return chunk;
      if (open > 1 && chunk.charAt(0) !== '!') {
        const inner = chunk.slice(1, open - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(REFLINK_SEARCH, hide) + '][' + 'a'.repeat(chunk.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(chunk.length - 2) + ']';
    };
    out = out.replace(REFLINK_SEARCH, hide);
  }
  // The punctuation/code-span replace only changes the string when there is
  // a backtick or a backslash to hide; the link/code/html replace only when
  // there is a '[', a backtick or a '<' to hide. Skip both scans otherwise.
  if (src.includes('`') || src.includes('\\')) {
    out = out.replace(ANY_PUNCT_OUTSIDE_CODE, (whole, ticks, punct) =>
      punct ? '+'.repeat(whole.length)
        : ticks ? ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
        : whole);
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    out = out.replace(BLOCK_SKIP, (whole, _g1, g2) => {
      const keep = g2 ? g2.length : 0;
      return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-parse state
// ---------------------------------------------------------------------------

function newState() {
  return {
    links: Object.create(null),
    inlineQueue: [],
    maskStack: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
}

// Queue an inline source for tokenising once the block pass has collected
// every link reference definition. Returns the (initially empty) token list.
function queueInline(state, src) {
  const tokens = [];
  state.inlineQueue.push({ src, tokens });
  return tokens;
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each returns a token or undefined. `state` is the
// per-parse lexer state; link definitions land in state.links.
// ---------------------------------------------------------------------------

function spaceTok(src) {
  const m = BLOCK_NEWLINE.exec(src);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  return undefined;
}

function indentedCodeTok(src) {
  const m = BLOCK_CODE.exec(src);
  if (!m) return undefined;
  const raw = trimBlankTail(m[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(/^(?: {0,3}\t| {1,4})/gm, '') };
}

function fencesTok(src) {
  const m = BLOCK_FENCES.exec(src);
  if (!m) return undefined;
  return {
    type: 'code',
    raw: m[0],
    lang: m[2] ? m[2].trim().replace(ANY_PUNCT_RE, '$1') : m[2],
    text: fenceIndentFix(m[0], m[3] || ''),
  };
}

function headingTok(state, src) {
  const m = BLOCK_HEADING.exec(src);
  if (!m) return undefined;
  let text = m[2].trim();
  if (/#$/.test(text)) {
    const stripped = trimEndChars(text, '#');
    if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { type: 'heading', raw: trimEndChars(m[0], '\n'), depth: m[1].length, text, tokens: queueInline(state, text) };
}

function hrTok(src) {
  const m = HR.exec(src);
  if (!m) return undefined;
  return { type: 'hr', raw: trimEndChars(m[0], '\n') };
}

function blockquoteTok(state, src) {
  const m = BLOCK_BLOCKQUOTE.exec(src);
  if (!m) return undefined;
  let raw = '';
  let text = '';
  const toks = [];
  let lines = trimEndChars(m[0], '\n').split('\n');
  while (lines.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (/^ {0,3}>/.test(lines[p])) { chunk.push(lines[p]); hasMarker = true; }
      else if (!hasMarker) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const joined = chunk.join('\n');
    const stripped = joined
      .replace(/^( {0,3}>)([ \t]+)/gm, (whole, mark, ws) => mark + expandTabs(ws, mark.length))
      .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
      .replace(/^ {0,3}>[ \t]?/gm, '');
    raw = raw ? raw + '\n' + joined : joined;
    text = text ? text + '\n' + stripped : stripped;
    const savedTop = state.top;
    state.top = true;
    blockTokens(state, stripped, toks, true);
    state.top = savedTop;
    if (lines.length === 0) break;
    const last = toks.at(-1);
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      const rest = lines.join('\n');
      const combined = last.raw + '\n' + rest.replace(/^ {0,3}>[ \t]?/gm, '');
      const reparsed = blockquoteTok(state, combined);
      toks[toks.length - 1] = reparsed;
      const tail = combined.substring(reparsed.raw.length).replace(/^\n/, '');
      const tailLines = tail ? tail.split('\n').length : 0;
      const consumed = tailLines ? lines.slice(0, -tailLines) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - last.text.length) + reparsed.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && /^ {0,3}>/.test(lines[0])) continue;
      break;
    } else if (last?.type === 'list') {
      const combined = last.raw + '\n' + lines.join('\n');
      const reparsed = listTok(state, combined);
      toks[toks.length - 1] = reparsed;
      const extra = reparsed.raw.length > last.raw.length
        ? combined.slice(last.raw.length + 1, reparsed.raw.length).split('\n').length : 0;
      if (extra > 0) {
        const taken = lines.slice(0, extra).join('\n');
        raw = raw + '\n' + taken;
        text = text + '\n' + taken;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens: toks, text };
}

function listTok(state, src) {
  const m = BLOCK_LIST.exec(src);
  if (!m) return undefined;
  const orig = src;
  let rest = src;
  const pos = () => orig.length - rest.length;
  const bull = m[1].trim();
  const ordered = bull.length > 1;
  const list = {
    type: 'list', raw: '', ordered,
    start: ordered ? +bull.slice(0, -1) : '',
    loose: false, items: [],
  };
  const bullPat = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRe = makeListItemRegex(bullPat);
  let sawDoubleBlank = false;
  while (rest) {
    let emptyItem = false;
    let body = '';
    const t = itemRe.exec(rest);
    if (!t || HR.test(rest)) break;
    const startPos = pos();
    rest = rest.substring(t[0].length);
    const firstLine = firstLineOf(t[2]);
    const markerLen = t[1].length;
    let content = firstLine.replace(/^[ \t]+/, (ws) => expandTabs(ws, markerLen));
    let nextLine = firstLineOf(rest);
    let isEmpty = !content.trim();
    let indent;
    if (isEmpty) indent = markerLen + 1;
    else {
      indent = firstNonSpace(content);
      indent = indent > 4 ? 1 : indent;
      body = content.slice(indent);
      indent += markerLen;
    }
    if (isEmpty && BLANK_LINE.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      emptyItem = true;
    }
    if (!emptyItem) {
      const nextBull = nextBulletRegex(indent);
      const hrR = hrRegexFor(indent);
      const fencesR = fencesBeginRegex(indent);
      const headingR = headingBeginRegex(indent);
      const htmlR = htmlBeginRegex(indent);
      const bqR = blockquoteBeginRegex(indent);
      while (rest) {
        const line = firstLineOf(rest);
        nextLine = line;
        const expanded = line.replace(/^[ \t]+/, (ws) => expandTabs(ws));
        // Only one of the six "begin" patterns can match, decided by the
        // first non-space character; skip the other five regex tests.
        const fc = firstBlockChar(line, indent);
        let endItem = false;
        if (fc === 42 || fc === 45) endItem = nextBull.test(line) || hrR.test(line);
        else if (fc === 43 || (fc >= 48 && fc <= 57)) endItem = nextBull.test(line);
        else if (fc === 96 || fc === 126) endItem = fencesR.test(line);
        else if (fc === 35) endItem = headingR.test(line);
        else if (fc === 60) endItem = htmlR.test(line);
        else if (fc === 62) endItem = bqR.test(line);
        else if (fc === 95) endItem = hrR.test(line);
        if (endItem) break;
        if (firstNonSpace(expanded) >= indent || !line.trim()) body += '\n' + expanded.slice(indent);
        else {
          const cc = firstBlockChar(content, indent);
          let endContent = false;
          if (cc === 96 || cc === 126) endContent = fencesR.test(content);
          else if (cc === 35) endContent = headingR.test(content);
          else if (cc === 60) endContent = htmlR.test(content);
          else if (cc === 42 || cc === 45 || cc === 95) endContent = hrR.test(content);
          if (isEmpty || firstNonSpaceTab4(content) >= 4 || endContent) break;
          const setext = /^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK_LHEADING.test(`${content}\n${line}`)
            ? `    ${expanded.replace(/^ {0,3}/, '')}` : line;
          body += '\n' + setext;
        }
        isEmpty = !line.trim();
        rest = rest.substring(line.length + 1);
        content = expanded.slice(indent);
      }
    }
    const itemRaw = orig.slice(startPos, pos());
    if (!list.loose) {
      if (sawDoubleBlank) list.loose = true;
      else if (endsDoubleBlank(itemRaw)) sawDoubleBlank = true;
    }
    list.items.push({
      type: 'list_item', raw: itemRaw,
      task: /^\[[ xX]\][ \t]+\S/.test(body),
      loose: false, text: body, tokens: [],
    });
  }
  const lastItem = list.items.at(-1);
  if (!lastItem) return undefined;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = orig.slice(0, pos()).trimEnd();
  for (const item of list.items) {
    state.top = false;
    item.tokens = blockTokens(state, item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((g) => g.type === 'space');
      if (spaces.length > 0 && spaces.some((g) => /\n.*\n/.test(g.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
      item.text = item.text.replace(/^\[[ xX]\][ \t]+/, '');
      first.raw = first.raw.replace(/^\[[ xX]\][ \t]+/, '');
      first.text = first.text.replace(/^\[[ xX]\][ \t]+/, '');
      for (let g = state.inlineQueue.length - 1; g >= 0; g--) {
        if (/^\[[ xX]\][ \t]+\S/.test(state.inlineQueue[g].src)) {
          state.inlineQueue[g].src = state.inlineQueue[g].src.replace(/^\[[ xX]\][ \t]+/, '');
          break;
        }
      }
      const box = /\[[ xX]\]/.exec(item.raw);
      if (box) {
        const check = { type: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
        item.checked = check.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] && item.tokens[0].tokens) {
            item.tokens[0].raw = check.raw + item.tokens[0].raw;
            item.tokens[0].text = check.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(check);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: check.raw, text: check.raw, tokens: [check] });
          }
        } else {
          item.tokens.unshift(check);
        }
      }
    } else if (item.task) item.task = false;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
    }
  }
  return list;
}

function htmlTok(src) {
  const m = BLOCK_HTML.exec(src);
  if (!m) return undefined;
  const raw = trimBlankTail(m[0]);
  return {
    type: 'html', block: true, raw,
    pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
    text: raw,
  };
}

function defTok(src) {
  const m = BLOCK_DEF.exec(src);
  if (!m) return undefined;
  if (!/^</.test(m[2]) && parenBalance(m[2], '()') !== -1) return undefined;
  return {
    type: 'def',
    tag: normalizeLabel(m[1]),
    raw: trimEndChars(m[0], '\n'),
    href: m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(ANY_PUNCT_RE, '$1') : '',
    title: m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT_RE, '$1') : m[3],
  };
}

function tableTok(state, src) {
  const m = BLOCK_TABLE.exec(src);
  if (!m || !/[:|]/.test(m[2])) return undefined;
  const header = splitTableRow(m[1]);
  const aligns = m[2].replace(/^\||\| *$/g, '').split('|');
  const body = m[3]?.trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  const tok = { type: 'table', raw: trimEndChars(m[0], '\n'), header: [], align: [], rows: [] };
  if (header.length !== aligns.length) return undefined;
  for (const a of aligns) {
    tok.align.push(/^ *-+: *$/.test(a) ? 'right' : /^ *:-+: *$/.test(a) ? 'center' : /^ *:-+ *$/.test(a) ? 'left' : null);
  }
  for (let i = 0; i < header.length; i++) {
    tok.header.push({ text: header[i], tokens: queueInline(state, header[i]), header: true, align: tok.align[i] });
  }
  for (const line of body) {
    tok.rows.push(splitTableRow(line, header.length).map((cell, j) => ({
      text: cell, tokens: queueInline(state, cell), header: false, align: tok.align[j],
    })));
  }
  return tok;
}

function lheadingTok(state, src) {
  const m = BLOCK_LHEADING.exec(src);
  if (!m) return undefined;
  const text = m[1].trim();
  return {
    type: 'heading', raw: trimEndChars(m[0], '\n'),
    depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(state, text),
  };
}

function paragraphTok(state, src) {
  const m = BLOCK_PARAGRAPH.exec(src);
  if (!m) return undefined;
  const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  return { type: 'paragraph', raw: m[0], text, tokens: queueInline(state, text) };
}

function textTok(state, src) {
  const m = BLOCK_TEXT.exec(src);
  if (!m) return undefined;
  return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(state, m[0]) };
}

// Cheap pre-checks used before the expensive table / setext patterns: the
// second line (or, for setext, any line before the first blank line) must
// look like the construct's second half. These only ever skip a pattern
// that cannot match, so they never change the result.
function maybeTable(src) {
  const nl = src.indexOf('\n');
  if (nl <= 0) return false;
  const nl2 = src.indexOf('\n', nl + 1);
  const line2 = src.slice(nl + 1, nl2 === -1 ? undefined : nl2);
  return line2.includes('-') && /[|:]/.test(line2);
}

function maybeSetext(src) {
  let at = src.indexOf('\n');
  while (at !== -1) {
    const end = src.indexOf('\n', at + 1);
    const line = src.slice(at + 1, end === -1 ? undefined : end);
    if (/^[ \t]*$/.test(line)) return false;
    if (/^ {0,3}(=+|-+)[ \t]*$/.test(line)) return true;
    at = end;
  }
  return false;
}

// The block driver: consume `src` into `toks`, in marked's trial order.
function blockTokens(state, src, toks = [], inContainer = false) {
  let shortest = Infinity;
  while (src) {
    if (src.length < shortest) shortest = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    const c0 = src[0];
    let tok;
    if ((tok = spaceTok(src))) {
      src = src.substring(tok.raw.length);
      const prev = toks.at(-1);
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else toks.push(tok);
      continue;
    }
    if ((c0 === ' ' || c0 === '\t') && (tok = indentedCodeTok(src))) {
      src = src.substring(tok.raw.length);
      const prev = toks.at(-1);
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        state.inlineQueue.at(-1).src = prev.text;
      } else toks.push(tok);
      continue;
    }
    if ((c0 === ' ' || c0 === '\t' || c0 === '`' || c0 === '~') && (tok = fencesTok(src))) {
      src = src.substring(tok.raw.length);
      toks.push(tok);
      continue;
    }
    if ((c0 === ' ' || c0 === '\t' || c0 === '#') && (tok = headingTok(state, src))) {
      src = src.substring(tok.raw.length);
      toks.push(tok);
      continue;
    }
    if ((c0 === ' ' || c0 === '\t' || c0 === '-' || c0 === '_' || c0 === '*') && (tok = hrTok(src))) {
      src = src.substring(tok.raw.length);
      toks.push(tok);
      continue;
    }
    if ((c0 === ' ' || c0 === '\t' || c0 === '>') && (tok = blockquoteTok(state, src))) {
      src = src.substring(tok.raw.length);
      toks.push(tok);
      continue;
    }
    if ((c0 === ' ' || c0 === '\t' || c0 === '-' || c0 === '+' || c0 === '*' || (c0 >= '0' && c0 <= '9')) && (tok = listTok(state, src))) {
      src = src.substring(tok.raw.length);
      toks.push(tok);
      continue;
    }
    if ((c0 === ' ' || c0 === '\t' || c0 === '<') && (tok = htmlTok(src))) {
      src = src.substring(tok.raw.length);
      toks.push(tok);
      continue;
    }
    if ((c0 === ' ' || c0 === '\t' || c0 === '[') && (tok = defTok(src))) {
      src = src.substring(tok.raw.length);
      const prev = toks.at(-1);
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
        state.inlineQueue.at(-1).src = prev.text;
      } else {
        if (!state.links[tok.tag]) state.links[tok.tag] = { href: tok.href, title: tok.title };
        toks.push(tok);
      }
      continue;
    }
    if (maybeTable(src) && (tok = tableTok(state, src))) {
      src = src.substring(tok.raw.length);
      toks.push(tok);
      continue;
    }
    if (maybeSetext(src) && (tok = lheadingTok(state, src))) {
      src = src.substring(tok.raw.length);
      toks.push(tok);
      continue;
    }
    if (state.top && (tok = paragraphTok(state, src))) {
      const prev = toks.at(-1);
      if (inContainer && prev?.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        state.inlineQueue.pop();
        state.inlineQueue.at(-1).src = prev.text;
      } else toks.push(tok);
      inContainer = false;
      src = src.substring(tok.raw.length);
      continue;
    }
    if ((tok = textTok(state, src))) {
      src = src.substring(tok.raw.length);
      const prev = toks.at(-1);
      if (prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        state.inlineQueue.pop();
        state.inlineQueue.at(-1).src = prev.text;
      } else toks.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  state.top = true;
  return toks;
}

// ---------------------------------------------------------------------------
// Inline tokenizers
// ---------------------------------------------------------------------------

function escapeTok(src) {
  const m = INLINE_ESCAPE.exec(src);
  if (!m) return undefined;
  return { type: 'escape', raw: m[0], text: m[1] };
}

function tagTok(state, src) {
  const m = INLINE_TAG.exec(src);
  if (!m) return undefined;
  if (!state.inLink && /^<a /i.test(m[0])) state.inLink = true;
  else if (state.inLink && /^<\/a>/i.test(m[0])) state.inLink = false;
  if (!state.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(m[0])) state.inRawBlock = true;
  else if (state.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(m[0])) state.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: state.inLink, inRawBlock: state.inRawBlock, block: false, text: m[0] };
}

// Build a link or image token from a matched `[label](...)` / `[label][ref]`.
function makeLink(state, m, dest, raw) {
  const label = m[1].replace(/\\([\[\]])/g, '$1');
  const isImage = m[0].charAt(0) === '!';
  const savedInLink = state.inLink;
  const savedEmitted = state.linkEmitted;
  const savedRawBlock = state.inRawBlock;
  state.inLink = true;
  state.linkEmitted = false;
  const inner = inlineTokens(state, label);
  const emitted = state.linkEmitted;
  state.linkEmitted = savedEmitted;
  state.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      state.inRawBlock = savedRawBlock;
      return undefined;
    }
    state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href: dest.href, title: dest.title || null, text: label, tokens: inner };
}

function linkTok(state, src) {
  if (state.linkParenPossible === false) return undefined;
  const m = INLINE_LINK.exec(src);
  if (!m) return undefined;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasRawTag(src, m[1], bang)) return undefined;
  const hrefTrimmed = m[2].trim();
  if (/^</.test(hrefTrimmed)) {
    if (!/>$/.test(hrefTrimmed)) return undefined;
    const stripped = trimEndChars(hrefTrimmed.slice(0, -1), '\\');
    if ((hrefTrimmed.length - stripped.length) % 2 === 0) return undefined;
  } else {
    const bal = parenBalance(m[2], '()');
    if (bal === -2) return undefined;
    if (bal > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
      m[2] = m[2].substring(0, bal);
      m[0] = m[0].substring(0, cut).trim();
      m[3] = '';
    }
  }
  const tail = trimEndChars(m[0].slice(0, -1), '\\');
  if ((m[0].length - tail.length) % 2 === 0) return undefined;
  let dest = m[2];
  const title = m[3] ? m[3].slice(1, -1) : '';
  dest = dest.trim();
  if (/^</.test(dest)) dest = dest.slice(1, -1);
  return makeLink(state, m, {
    href: dest && dest.replace(ANY_PUNCT_RE, '$1'),
    title: title && title.replace(ANY_PUNCT_RE, '$1'),
  }, m[0]);
}

function reflinkTok(state, src) {
  const m = INLINE_REFLINK.exec(src) || INLINE_NOLINK.exec(src);
  if (!m) return undefined;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasRawTag(src, m[1], bang)) return undefined;
  const ref = state.links[normalizeLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return makeLink(state, m, ref, m[0]);
}

function emStrongTok(state, src, masked, prevChar = '') {
  const m = EM_LDELIM.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
  const ch = m[0][0];
  const sameAsPrev = prevChar === ch;
  const offset = masked.length - src.length;
  let l = offset;
  while (l > 0 && masked[l - 1] === ch) l--;
  const beforeRun = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || !!IS_PUNCT.exec(beforeRun);
  if (l < offset) prevChar = beforeRun;
  const u = l < offset ? beforeIsPunct : !!IS_PUNCT.exec(prevChar);
  if (m[4] && /[\p{L}\p{N}]/u.test(prevChar)) return undefined;
  const followedByPunct = m[1] || m[3] || '';
  if (!followedByPunct || !prevChar || u) {
    const k = [...m[0]].length - 1;
    let remain = k;
    let f = 0;
    const y = offset - l + k;
    const canSplit = !!beforeRun.trim() && (!!followedByPunct || (ch === '*' && !beforeIsPunct));
    if (ch !== '*' && ch !== '_') return undefined;
    const closer = ch === '*' ? EM_RDELIM_AST : EM_RDELIM_UND;
    const last = lastEmCloser(state, masked, ch);
    const q = masked.length - src.length + k;
    if (last < q) return undefined;
    const rest = masked.slice(-src.length + k);
    const limit = last - q;
    closer.lastIndex = 0;
    let s2;
    while ((s2 = closer.exec(rest)) !== null && !(s2.index > limit)) {
      const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g) continue;
      let b = [...g].length;
      if (s2[3] || s2[4]) { remain += b; continue; }
      else if (s2[5] || s2[6] || canSplit) {
        if (sameAsPrev && (s2[5] || s2[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      if (remain -= b, remain > 0) continue;
      b = Math.min(b, b + remain + f);
      const firstLen = [...s2[0]][0].length;
      const raw = src.slice(0, k + s2.index + firstLen + b);
      if (Math.min(k, b) % 2) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: inlineTokens(state, inner) };
      }
      const inner = raw.slice(2, -2);
      return { type: 'strong', raw, text: inner, tokens: inlineTokens(state, inner) };
    }
  }
  return undefined;
}

function codespanTok(src) {
  const m = INLINE_CODE.exec(src);
  if (!m) return undefined;
  let text = m[2].replace(/\n/g, ' ');
  if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: m[0], text };
}

function brTok(src) {
  const m = INLINE_BR.exec(src);
  if (!m) return undefined;
  return { type: 'br', raw: m[0] };
}

function delTok(state, src, masked, prevChar = '') {
  const m = DEL_LDELIM.exec(src);
  if (!m) return undefined;
  if (!(m[1] || '') || !prevChar || IS_PUNCT.exec(prevChar)) {
    const runLen = [...m[0]].length - 1;
    let p = runLen;
    const last = lastDelCloser(state, masked);
    const d = masked.length - src.length + runLen;
    if (last < d) return undefined;
    const rest = masked.slice(-src.length + runLen);
    const limit = last - d;
    DEL_RDELIM.lastIndex = 0;
    let s2;
    while ((s2 = DEL_RDELIM.exec(rest)) !== null && !(s2.index > limit)) {
      const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      let l;
      if (!g || (l = [...g].length, l !== runLen)) continue;
      if (s2[3] || s2[4]) { p += l; continue; }
      if (p -= l, p > 0) continue;
      l = Math.min(l, l + p);
      const firstLen = [...s2[0]][0].length;
      const raw = src.slice(0, runLen + s2.index + firstLen + l);
      const inner = raw.slice(runLen, -runLen);
      return { type: 'del', raw, text: inner, tokens: inlineTokens(state, inner) };
    }
  }
  return undefined;
}

function autolinkTok(src) {
  const m = INLINE_AUTOLINK.exec(src);
  if (!m) return undefined;
  let text;
  let href;
  if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
  else { text = m[1]; href = text; }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function urlTok(src) {
  const m = INLINE_URL.exec(src);
  if (!m) return undefined;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let prev;
    do {
      prev = m[0];
      m[0] = URL_BACKPEDAL.exec(m[0])?.[0] ?? '';
    } while (prev !== m[0]);
    text = m[0];
    href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
  }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

// --- Plain-text scanning -------------------------------------------------
// The inline text pattern is the hottest regex in the renderer, so plain
// text runs are scanned by hand instead. The scan mirrors the pattern
// exactly: the first character (or backtick / tilde run) is always taken,
// then the run ends before a markup character, before an autolink or email
// address, or at a hard line break.

function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Characters that may appear in a bare email address (before the @).
function isEmailCharCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 ||
    c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 96 || c === 95 ||
    c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}

// Does an email address (a run of email characters followed by @) start at i?
function emailStartsAt(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && isEmailCharCode(src.charCodeAt(j))) j++;
  return j > i && src.charCodeAt(j) === 64;
}

// Length of the plain-text run at the start of `src`. The run ends at the
// nearest of: a markup character, a hard break, an email address, a
// mailto:/xmpp: address, or an autolink. One combined pattern finds the
// next candidate in a single native scan; rejected candidates (a www. with
// the wrong character before it, ...) are skipped by resuming the scan just
// past them. The email candidate is computed separately (see below).
const TEXT_STOP_RE = /[\\<\[!`*~_]| {2}\n|@|mailto:|xmpp:|:\/\/|www\./g;

function scanTextLen(src) {
  const n = src.length;
  if (n === 0) return 0;
  let i;
  const c0 = src.charCodeAt(0);
  if (c0 === 96) { i = 0; while (i < n && src.charCodeAt(i) === 96) i++; }
  else if (c0 === 126) { i = 0; while (i < n && src.charCodeAt(i) === 126) i++; }
  else i = 1;
  if (i < n) {
    // A non-alphanumeric first character followed by mailto:/xmpp: ends here.
    if (!isAlnumCode(c0) && (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1))) return 1;
    // A hard break or an email right after the first character(s) ends here.
    if (src.charCodeAt(i) === 32 && src.charCodeAt(i + 1) === 32) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 32) j++;
      if (src.charCodeAt(j) === 10) return i;
    }
    if (emailStartsAt(src, i)) return i;
  }
  // Email candidate, computed separately: its stop position (the start of
  // the email-character run) comes before the '@' the scan below finds, and
  // a markup character inside the run (such as '_') must not stop the text
  // earlier than the run itself.
  let emailBest = n;
  let at = src.indexOf('@', i);
  while (at !== -1) {
    let runStart = at;
    while (runStart > i && isEmailCharCode(src.charCodeAt(runStart - 1))) runStart--;
    if (runStart < at && runStart > i) { emailBest = runStart; break; }
    at = src.indexOf('@', at + 1);
  }
  let best = n;
  TEXT_STOP_RE.lastIndex = i;
  let m;
  while ((m = TEXT_STOP_RE.exec(src)) !== null) {
    const p = m.index;
    const ch = m[0];
    if (ch.length === 1) {
      if (ch.charCodeAt(0) === 64) {
        // '@' is already covered by the email candidate above.
        TEXT_STOP_RE.lastIndex = p + 1;
        continue;
      }
      best = p;
      break;
    }
    if (ch.charCodeAt(0) === 32) {
      // Hard break: walk back to the start of the space run.
      let runStart = p;
      while (runStart > i && src.charCodeAt(runStart - 1) === 32) runStart--;
      if (runStart > i) { best = runStart; break; }
      TEXT_STOP_RE.lastIndex = p + 1;
      continue;
    }
    if (ch.charCodeAt(0) === 58) {
      // '://': the scheme before it must be http, https or ftp (any case),
      // starting at or after i.
      if (p - 4 >= i) {
        const tail4 = src.slice(p - 4, p).toLowerCase();
        if (tail4 === 'http' || tail4 === 'ftp') { best = p - 4; break; }
        if (p - 5 >= i && src.slice(p - 5, p).toLowerCase() === 'https') { best = p - 5; break; }
      }
      TEXT_STOP_RE.lastIndex = p + 3;
      continue;
    }
    if (ch.charCodeAt(0) === 119) {
      // 'www.': the character before it must be whitespace or one of *_~(.
      const prev = src.charCodeAt(p - 1);
      if (prev === 32 || prev === 9 || prev === 10 || prev === 13 || prev === 12 || prev === 11 || prev === 42 || prev === 95 || prev === 126 || prev === 40) { best = p; break; }
      TEXT_STOP_RE.lastIndex = p + 4;
      continue;
    }
    // 'mailto:' or 'xmpp:': the character before it must be non-alphanumeric.
    if (p > i && !isAlnumCode(src.charCodeAt(p - 1))) { best = p; break; }
    TEXT_STOP_RE.lastIndex = p + 1;
  }
  return best < emailBest ? best : emailBest;
}

function inlineTextTok(state, src) {
  const len = scanTextLen(src);
  if (len === 0) return undefined;
  const raw = src.slice(0, len);
  const inRaw = state.inRawBlock;
  return { type: 'text', raw, text: inRaw ? raw : decodeEntities(raw), escaped: inRaw };
}

// Tokenise one inline source into `tokens`, honouring the link-paren flag
// and the emphasis mask for this source (and its nested emphasis texts).
function inlineTokens(state, src, tokens = []) {
  const saved = state.linkParenPossible;
  state.linkParenPossible = saved && src.includes(')');
  try {
    const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = hasDelim ? maskForEmphasis(src, state.links) : src;
    state.maskStack.push(findLastCloser(masked));
    try {
      return inlineTokensLoop(state, src, masked, tokens);
    } finally {
      state.maskStack.pop();
    }
  } finally {
    state.linkParenPossible = saved;
  }
}

function inlineTokensLoop(state, src, masked, tokens) {
  let wasText = false;
  let prevChar = '';
  let shortest = Infinity;
  while (src) {
    if (src.length < shortest) shortest = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    if (!wasText) prevChar = '';
    wasText = false;
    let tok;
    if ((tok = escapeTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tagTok(state, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = linkTok(state, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = reflinkTok(state, src))) {
      src = src.substring(tok.raw.length);
      const prev = tokens.at(-1);
      if (tok.type === 'text' && prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
      else tokens.push(tok);
      continue;
    }
    if ((tok = emStrongTok(state, src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = codespanTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = brTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = delTok(state, src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = autolinkTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (!state.inLink && (tok = urlTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = inlineTextTok(state, src))) {
      src = src.substring(tok.raw.length);
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      wasText = true;
      const prev = tokens.at(-1);
      if (prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
      else tokens.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Rendering. `plain` renders to text (image alt text): markup is dropped,
// code spans and links keep their text, hard breaks vanish.
// ---------------------------------------------------------------------------

function renderTextToken(tok) {
  if ('tokens' in tok && tok.tokens) return renderInline(tok.tokens);
  if ('escaped' in tok && tok.escaped) return tok.text;
  return esc(tok.text);
}

function renderCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInline(cell.tokens) + `</${tag}>\n`;
}

function renderInline(toks, plain = false) {
  let out = '';
  for (const tok of toks) {
    switch (tok.type) {
      case 'escape':
        out += plain ? tok.text : esc(tok.text);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link': {
        if (plain) {
          out += tok.tokens ? renderInline(tok.tokens, true) : tok.text;
          break;
        }
        const inner = tok.autolink ? esc(tok.text, true) : renderInline(tok.tokens);
        const href = encodeHref(tok.href);
        if (href === null) { out += inner; break; }
        let tag = `<a href="${esc(href, tok.autolink)}"`;
        if (tok.title) tag += ` title="${esc(tok.title)}"`;
        out += tag + '>' + inner + '</a>';
        break;
      }
      case 'image': {
        let alt = tok.text;
        if (tok.tokens) alt = renderInline(tok.tokens, true);
        if (plain) { out += alt; break; }
        const href = encodeHref(tok.href);
        if (href === null) { out += esc(alt); break; }
        let tag = `<img src="${esc(href)}" alt="${esc(alt)}"`;
        if (tok.title) tag += ` title="${esc(tok.title)}"`;
        out += tag + '>';
        break;
      }
      case 'checkbox':
        out += plain ? tok.raw : `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'strong':
        out += plain
          ? (tok.tokens ? renderInline(tok.tokens, true) : tok.text)
          : `<strong>${renderInline(tok.tokens)}</strong>`;
        break;
      case 'em':
        out += plain
          ? (tok.tokens ? renderInline(tok.tokens, true) : tok.text)
          : `<em>${renderInline(tok.tokens)}</em>`;
        break;
      case 'codespan':
        out += plain ? tok.text : `<code>${esc(tok.text, true)}</code>`;
        break;
      case 'br':
        out += plain ? '' : '<br>';
        break;
      case 'del':
        out += plain
          ? (tok.tokens ? renderInline(tok.tokens, true) : tok.text)
          : `<del>${renderInline(tok.tokens)}</del>`;
        break;
      case 'text':
        out += plain ? tok.text : renderTextToken(tok);
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

function renderBlocks(toks) {
  let out = '';
  for (const tok of toks) {
    switch (tok.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`;
        break;
      case 'code': {
        const lang = (tok.lang || '').match(/^\S*/)?.[0];
        const text = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        out += lang
          ? `<pre><code class="language-${esc(lang)}">${esc(text, true)}</code></pre>\n`
          : `<pre><code>${esc(text, true)}</code></pre>\n`;
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderCell(cell);
        let body = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const cell of row) cells += renderCell(cell);
          body += `<tr>\n${cells}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(tok.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        let items = '';
        for (const item of tok.items) items += `<li>${renderBlocks(item.tokens)}</li>\n`;
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'checkbox':
        out += `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'html':
        out += tok.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += `<p>${renderInline(tok.tokens)}</p>\n`;
        break;
      case 'text':
        out += renderTextToken(tok);
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Render `markdown` to HTML, exactly as marked 18.1.3 does with its
// defaults. The input must be a string; each call parses only that string.
export function parse(markdown) {
  if (markdown === undefined || markdown === null) {
    throw new Error('parse(): input parameter is undefined or null');
  }
  if (typeof markdown !== 'string') {
    throw new Error('parse(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const state = newState();
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const tokens = blockTokens(state, src, []);
  for (const queued of state.inlineQueue) {
    state.inRawBlock = false;
    inlineTokens(state, queued.src, queued.tokens);
  }
  return renderBlocks(tokens);
}
