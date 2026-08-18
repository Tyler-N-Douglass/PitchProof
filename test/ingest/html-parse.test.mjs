/**
 * HTML parser conformance (D8, §17.5's precondition).
 *
 * The corpus is hostile on purpose: every case below is a shape that appears in
 * real enterprise markup and that a naive regex or a lenient hand-rolled parser
 * gets wrong. Each assertion is against the **tree**, not against "it did not
 * throw", because a parser that silently produces the wrong tree is worse than
 * one that fails — it poisons every specimen downstream (§22.3).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseHtml, parseFragment, tokenize, plainTree, serialize, textContent, normalizedText,
  attr, hasAttr, walk, firstElement, elementsByTag, classList, nodePath, childElements,
  VOID_ELEMENTS, RAW_TEXT_ELEMENTS,
} from '../../src/ingest/html-parse.js';
import { decodeEntities, escapeHtml } from '../../src/ingest/entities.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures', 'ingest');

/** @param {string} src */
function body(src) {
  return plainTree(firstElement(parseHtml(src), 'body'));
}

/** A compact shape: `tag[.class]` with children, for readable expectations. */
function shape(node) {
  if (!node) return null;
  if (node.type === 'text') return node.text;
  if (node.type === 'comment') return `<!--${node.text}-->`;
  const cls = node.attrs && node.attrs.class ? `.${node.attrs.class.split(/\s+/).join('.')}` : '';
  const kids = (node.children || []).map(shape);
  return kids.length ? { [node.tag + cls]: kids } : node.tag + cls;
}

/** @param {string} src */
function bodyShape(src) {
  return shape(body(src));
}

// ---------------------------------------------------------------------------
// Document scaffolding
// ---------------------------------------------------------------------------

test('a bare fragment still gets html, head and body', () => {
  const doc = parseHtml('<p>hello');
  assert.equal(doc.tag, '#document');
  const html = doc.children[0];
  assert.equal(html.tag, 'html');
  assert.deepEqual(html.children.map((c) => c.tag), ['head', 'body']);
  assert.equal(normalizedText(firstElement(doc, 'body')), 'hello');
});

test('doctype is recorded on the document, not as a node', () => {
  const doc = parseHtml('<!DOCTYPE html><p>x');
  assert.equal(doc.doctype, 'html');
  for (const child of doc.children) assert.notEqual(child.type, 'doctype');
  assert.match(serialize(doc), /^<!DOCTYPE html><html>/);
});

test('head-only elements stay in head; the first flow content opens body', () => {
  const doc = parseHtml('<meta charset=utf-8><title>T</title><style>.a{}</style><p>body starts here');
  const head = firstElement(doc, 'head');
  assert.deepEqual(childElements(head).map((c) => c.tag), ['meta', 'title', 'style']);
  assert.equal(normalizedText(firstElement(doc, 'body')), 'body starts here');
});

test('an explicit html/body carries its attributes onto the synthesised element', () => {
  const doc = parseHtml('<html lang="de" data-x="1"><body class="page">x</body></html>');
  assert.equal(attr(firstElement(doc, 'html'), 'lang'), 'de');
  assert.equal(attr(firstElement(doc, 'body'), 'class'), 'page');
});

// ---------------------------------------------------------------------------
// Optional end tags
// ---------------------------------------------------------------------------

test('implicit </p> closes at the next block element', () => {
  assert.deepEqual(bodyShape('<p>one<p>two<p>three'), {
    body: [{ p: ['one'] }, { p: ['two'] }, { p: ['three'] }],
  });
});

test('a </p> is implied through inline formatting but not through a container', () => {
  assert.deepEqual(bodyShape('<p>a<b>bold<div>d</div>'), {
    body: [{ p: ['a', { b: ['bold'] }] }, { div: ['d'] }],
  });
});

test('implicit </li> closes only inside its own list', () => {
  assert.deepEqual(bodyShape('<ul><li>a<li>b<ul><li>c<li>d</ul><li>e</ul>'), {
    body: [{
      ul: [
        { li: ['a'] },
        { li: ['b', { ul: [{ li: ['c'] }, { li: ['d'] }] }] },
        { li: ['e'] },
      ],
    }],
  });
});

test('implicit </td> and </tr> rebuild a whole table', () => {
  assert.deepEqual(bodyShape('<table><tr><td>a<td>b<tr><td>c<td>d</table>'), {
    body: [{
      table: [
        { tr: [{ td: ['a'] }, { td: ['b'] }] },
        { tr: [{ td: ['c'] }, { td: ['d'] }] },
      ],
    }],
  });
});

test('a new row closes an open cell even through an inline element', () => {
  assert.deepEqual(bodyShape('<table><tr><td>a<span>b<tr><td>c</table>'), {
    body: [{
      table: [
        { tr: [{ td: ['a', { span: ['b'] }] }] },
        { tr: [{ td: ['c'] }] },
      ],
    }],
  });
});

test('nested tables nest, and </table> closes the inner one', () => {
  const tree = bodyShape('<table class=outer><tr><td><table class=inner><tr><td>in</table><td>out</table>');
  assert.deepEqual(tree.body[0], {
    'table.outer': [{
      tr: [
        { td: [{ 'table.inner': [{ tr: [{ td: ['in'] }] }] }] },
        { td: ['out'] },
      ],
    }],
  });
});

test('two sibling <table> tags do not nest', () => {
  const tree = body('<table><tr><td>a</table><table><tr><td>b</table>');
  assert.deepEqual(tree.children.map((c) => c.tag), ['table', 'table']);
});

test('implicit </option>, </dt> and </dd>', () => {
  assert.deepEqual(bodyShape('<select><option>a<option>b</select>'), {
    body: [{ select: [{ option: ['a'] }, { option: ['b'] }] }],
  });
  assert.deepEqual(bodyShape('<dl><dt>t<dd>d<dt>t2<dd>d2</dl>'), {
    body: [{ dl: [{ dt: ['t'] }, { dd: ['d'] }, { dt: ['t2'] }, { dd: ['d2'] }] }],
  });
});

test('a heading closes an open heading', () => {
  assert.deepEqual(bodyShape('<h1>a<h2>b<h3>c'), {
    body: [{ h1: ['a'] }, { h2: ['b'] }, { h3: ['c'] }],
  });
});

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

test('quoted, single-quoted, unquoted and valueless attributes', () => {
  const el = firstElement(parseHtml('<div class="a b" id=\'main\' data-n=7 hidden data-empty="">x</div>'), 'div');
  assert.equal(attr(el, 'class'), 'a b');
  assert.equal(attr(el, 'id'), 'main');
  assert.equal(attr(el, 'data-n'), '7');
  assert.equal(attr(el, 'hidden'), '');
  assert.equal(hasAttr(el, 'hidden'), true);
  assert.equal(attr(el, 'data-empty'), '');
  assert.equal(attr(el, 'missing'), null);
  assert.deepEqual(classList(el), ['a', 'b']);
});

test('a > inside a quoted attribute value does not end the tag', () => {
  const el = firstElement(parseHtml('<a title="a > b && c < d" href="/x">t</a>'), 'a');
  assert.equal(attr(el, 'title'), 'a > b && c < d');
  assert.equal(attr(el, 'href'), '/x');
});

test('a comment inside an attribute value is text, not a comment', () => {
  const doc = parseHtml('<a title="<!-- not a comment -->" data-x=\'<div>\'>t</a>');
  const el = firstElement(doc, 'a');
  assert.equal(attr(el, 'title'), '<!-- not a comment -->');
  assert.equal(attr(el, 'data-x'), '<div>');
  let comments = 0;
  walk(doc, (n) => { if (n.type === 'comment') comments += 1; });
  assert.equal(comments, 0);
});

test('duplicate attributes keep the first, per HTML5', () => {
  const el = firstElement(parseHtml('<div id=first id=second>x</div>'), 'div');
  assert.equal(attr(el, 'id'), 'first');
});

test('attribute names are lowercased and entity-decoded values are honoured', () => {
  const el = firstElement(parseHtml('<img SRC="a.png?x=1&amp;y=2" ALT="Caf&eacute;">'), 'img');
  assert.equal(attr(el, 'src'), 'a.png?x=1&y=2');
  assert.equal(attr(el, 'alt'), 'Café');
});

test('an ampersand that is not a reference survives a query string', () => {
  const el = firstElement(parseHtml('<a href="/s?x=1&sect=2&copy=3">t</a>'), 'a');
  assert.equal(attr(el, 'href'), '/s?x=1&sect=2&copy=3');
});

test('malformed <div <span> keeps the junk as an attribute name and stays one element', () => {
  const tree = body('<div <span>text</div>');
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].tag, 'div');
  assert.equal(tree.children[0].children[0].text, 'text');
  assert.ok('<span' in tree.children[0].attrs);
});

test('an unterminated tag at end of input is dropped, not rendered', () => {
  const tree = body('<p>ok</p><div class="never');
  assert.deepEqual(tree.children.map((c) => c.tag), ['p']);
});

// ---------------------------------------------------------------------------
// Raw text
// ---------------------------------------------------------------------------

test('<script> containing </div> and a < comparison stays one script', () => {
  const src = '<body><script>var t = "</div>"; if (a<b && b>c) {}</script><p>after</p></body>';
  const doc = parseHtml(src);
  const scripts = elementsByTag(doc, 'script');
  assert.equal(scripts.length, 1);
  assert.equal(textContent(scripts[0]), 'var t = "</div>"; if (a<b && b>c) {}');
  assert.equal(elementsByTag(doc, 'div').length, 0);
  assert.equal(normalizedText(firstElement(doc, 'p')), 'after');
});

test('script content is never entity-decoded', () => {
  const doc = parseHtml('<script>if (a &amp;&amp; b) x();</script>');
  assert.equal(textContent(firstElement(doc, 'script')), 'if (a &amp;&amp; b) x();');
});

test('textarea and title are escapable raw text: markup is text, entities decode', () => {
  const doc = parseHtml('<title>A &amp; B</title><textarea><b>bold</b> &amp; more</textarea>');
  assert.equal(textContent(firstElement(doc, 'title')), 'A & B');
  assert.equal(textContent(firstElement(doc, 'textarea')), '<b>bold</b> & more');
  assert.equal(elementsByTag(doc, 'b').length, 0);
});

test('an unterminated <script> consumes to end of input rather than eating the parser', () => {
  const doc = parseHtml('<p>before<script>var a = 1;');
  assert.equal(normalizedText(firstElement(doc, 'p')), 'before');
  assert.equal(textContent(firstElement(doc, 'script')), 'var a = 1;');
});

test('textContent excludes script and style content', () => {
  const doc = parseHtml('<div>keep<script>drop()</script><style>.x{}</style>this</div>');
  assert.equal(normalizedText(firstElement(doc, 'div')), 'keepthis');
});

// ---------------------------------------------------------------------------
// Comments, doctypes and bogus markup
// ---------------------------------------------------------------------------

test('a comment containing markup is one comment node', () => {
  const doc = parseHtml('<body><!-- a <div> and </div> --><p>x</p></body>');
  const node = firstElement(doc, 'body').children[0];
  assert.equal(node.type, 'comment');
  assert.equal(node.text, ' a <div> and </div> ');
  assert.equal(elementsByTag(doc, 'div').length, 0);
});

test('conditional comments and processing instructions become comments', () => {
  const doc = parseHtml('<body><!--[if IE]><p>old</p><![endif]--><?php echo "x" ?><p>real</p></body>');
  const kinds = firstElement(doc, 'body').children.map((c) => c.type);
  assert.deepEqual(kinds, ['comment', 'comment', 'element']);
  assert.equal(elementsByTag(doc, 'p').length, 1);
});

test('an unterminated comment swallows the rest, and does not throw', () => {
  const doc = parseHtml('<p>a</p><!-- never closed <p>b</p>');
  assert.equal(elementsByTag(doc, 'p').length, 1);
});

test('a bogus comment <!foo> does not become a doctype', () => {
  const doc = parseHtml('<!foo bar><p>x');
  assert.equal(doc.doctype, null);
  assert.equal(firstElement(doc, 'body').children[0].tag, 'p');
});

test('a stray end tag is ignored rather than unwinding the document', () => {
  const tree = body('</div></p><section><p>kept</p></section>');
  assert.deepEqual(tree.children.map((c) => c.tag), ['section']);
});

test('an end tag for br is treated as a br element', () => {
  const tree = body('a</br>b');
  assert.equal(tree.children[1].tag, 'br');
});

// ---------------------------------------------------------------------------
// Foreign content
// ---------------------------------------------------------------------------

test('svg keeps camelCase tag and attribute names and honours self-closing', () => {
  const doc = parseHtml('<svg viewBox="0 0 10 10" preserveAspectRatio="none"><lineargradient id=g><stop offset="0"/></lineargradient><path d="M0 0"/><clippath id=c/></svg><p>after');
  const svg = firstElement(doc, 'svg');
  assert.equal(attr(svg, 'viewBox'), '0 0 10 10');
  assert.equal(attr(svg, 'preserveAspectRatio'), 'none');
  assert.deepEqual(childElements(svg).map((c) => c.tag), ['linearGradient', 'path', 'clipPath']);
  assert.equal(childElements(svg)[1].children.length, 0, 'a self-closing foreign element takes no children');
  assert.equal(normalizedText(firstElement(doc, 'p')), 'after');
});

test('a self-closing HTML element is not self-closing, matching browsers', () => {
  const tree = body('<div />inside</div><p>after');
  assert.equal(tree.children[0].tag, 'div');
  assert.equal(tree.children[0].children[0].text, 'inside');
});

test('void elements never take children', () => {
  const tree = body('<img src=a.png><br><hr><input value=x>tail');
  assert.deepEqual(tree.children.map((c) => c.tag || c.type), ['img', 'br', 'hr', 'input', 'text']);
  for (const child of tree.children) {
    if (child.tag) assert.equal(child.children, undefined);
  }
  assert.ok(VOID_ELEMENTS.has('img') && VOID_ELEMENTS.has('wbr'));
  assert.ok(RAW_TEXT_ELEMENTS.has('script'));
});

test('CDATA inside foreign content becomes text', () => {
  const doc = parseHtml('<svg><title><![CDATA[Logo & mark]]></title></svg>');
  assert.match(textContent(firstElement(doc, 'svg')), /Logo & mark/);
});

// ---------------------------------------------------------------------------
// Character references
// ---------------------------------------------------------------------------

test('named, numeric and hex references decode', () => {
  assert.equal(decodeEntities('Caf&eacute; &amp; more &#8212; &#x2014; &hellip;'), 'Café & more — — …');
});

test('the HTML5 C1 remap is applied to numeric references', () => {
  assert.equal(decodeEntities('&#151;&#146;&#128;'), '—’€');
});

test('an unknown reference is left alone; a legacy one without a semicolon resolves', () => {
  assert.equal(decodeEntities('&nosuchentity; &copy 2026'), '&nosuchentity; © 2026');
});

test('a longest-match legacy reference resolves the way HTML5 requires', () => {
  assert.equal(decodeEntities('&notit;'), '¬it;');
  assert.equal(decodeEntities('&notin;'), '∉');
});

test('a reference is not decoded inside an attribute when it would break a query string', () => {
  assert.equal(decodeEntities('?a=1&sect=2', { inAttribute: true }), '?a=1&sect=2');
  assert.equal(decodeEntities('?a=1&sect;=2', { inAttribute: true }), '?a=1§=2');
});

test('surrogate and out-of-range references become the replacement character', () => {
  assert.equal(decodeEntities('&#xD800;'), '�');
  assert.equal(decodeEntities('&#x110000;'), '�');
});

test('escapeHtml round-trips through the decoder', () => {
  const raw = 'a & b < c > d "quoted"';
  assert.equal(decodeEntities(escapeHtml(raw)), raw);
});

// ---------------------------------------------------------------------------
// Serialization and utilities
// ---------------------------------------------------------------------------

test('serialize round-trips a parsed document to an equivalent tree', () => {
  const src = readFileSync(join(FIXTURES, 'hostile.html'), 'utf8');
  const once = parseHtml(src);
  const twice = parseHtml(serialize(once));
  assert.deepEqual(plainTree(twice), plainTree(once));
});

test('nodePath is stable and structural', () => {
  const doc = parseHtml('<div><p>a</p><p>b</p></div>');
  const second = elementsByTag(doc, 'p')[1];
  assert.equal(nodePath(second), 'html[0]/body[0]/div[0]/p[1]');
  const again = parseHtml('<div><p>a</p><p>b</p></div>');
  assert.equal(nodePath(elementsByTag(again, 'p')[1]), nodePath(second));
});

test('plainTree drops the parent back-reference so a node can be serialised', () => {
  const doc = parseHtml('<p>x');
  assert.doesNotThrow(() => JSON.stringify(plainTree(doc)));
  assert.ok(firstElement(doc, 'p').parent, 'the live tree keeps its parent link');
});

test('parseFragment does not synthesise html/head/body', () => {
  const fragment = parseFragment('<li>a</li><li>b</li>');
  assert.equal(fragment.tag, '#fragment');
  assert.deepEqual(childElements(fragment).map((c) => c.tag), ['li', 'li']);
});

test('the tokenizer reports every token kind', () => {
  const kinds = new Set(tokenize('<!DOCTYPE html><!--c--><p>t</p>').map((t) => t.type));
  assert.deepEqual([...kinds].sort(), ['comment', 'doctype', 'end', 'start', 'text']);
});

test('parsing is deterministic: the same source gives the same tree twice', () => {
  const src = readFileSync(join(FIXTURES, 'hostile.html'), 'utf8');
  assert.deepEqual(plainTree(parseHtml(src)), plainTree(parseHtml(src)));
});

test('parseHtml never throws on adversarial input', () => {
  const nasty = [
    '', '<', '</', '<>', '<<<<>>>>', '<a href=', '<!', '<!-', '<!--', '<![CDATA[',
    '<p'.repeat(500), '<div>'.repeat(600), '</div>'.repeat(600), '&#', '&#x', '&',
    '<table><tr><td>'.repeat(120), '<svg><svg><svg>', '<script>', '<textarea>',
    `${String.fromCharCode(0)}<p>null byte</p>`,
    '<p>\uD800 lone surrogate</p>',
  ];
  for (const src of nasty) {
    assert.doesNotThrow(() => parseHtml(src), `parseHtml threw on ${JSON.stringify(src.slice(0, 24))}`);
  }
});

// ---------------------------------------------------------------------------
// The hostile fixture as a whole
// ---------------------------------------------------------------------------

test('the hostile fixture parses into the structure a specimen pass expects', () => {
  const doc = parseHtml(readFileSync(join(FIXTURES, 'hostile.html'), 'utf8'));

  assert.equal(elementsByTag(doc, 'h1').length, 1);
  assert.equal(normalizedText(firstElement(doc, 'h1')), 'Pricing that survives procurement');

  const navItems = elementsByTag(firstElement(doc, 'nav'), 'li');
  assert.equal(navItems.length, 6);

  const tables = elementsByTag(doc, 'table');
  const plans = tables.find((t) => (attr(t, 'class') || '').includes('plans'));
  assert.equal(elementsByTag(plans, 'tr').length, 4);
  assert.equal(elementsByTag(plans, 'th').length, 4);
  assert.equal(elementsByTag(plans, 'td').length, 12);
  assert.equal(normalizedText(elementsByTag(plans, 'td')[3]), '£1,200/mo');

  assert.equal(elementsByTag(doc, 'main').length, 1);
  assert.equal(elementsByTag(doc, 'footer').length, 2, 'blockquote footer plus site footer');

  const inner = tables.find((t) => (attr(t, 'class') || '') === 'inner');
  assert.ok(inner);
  assert.equal(elementsByTag(inner, 'td').length, 2);

  const em = elementsByTag(firstElement(doc, 'main'), 'em');
  assert.equal(normalizedText(em[em.length - 1]), 'runs to the end of the section');
});
