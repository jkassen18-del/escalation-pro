/**
 * The sanitiser is the boundary that decides what rich text gets stored, so it
 * is tested against what an attacker would actually send - not just at what a
 * well-behaved editor produces. Anything reaching here may have been posted
 * straight to the API with no browser involved.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isEffectivelyEmpty, richTextToPlain, sanitizeRichText } from '../server/lib/rich-text.ts';

/** Nothing that survives sanitising may be able to run. */
function assertInert(html: string, note: string) {
  const out = sanitizeRichText(html);
  assert.doesNotMatch(out, /<script/i, `${note}: script tag survived`);
  assert.doesNotMatch(out, /\son\w+\s*=/i, `${note}: event handler survived`);
  assert.doesNotMatch(out, /javascript:/i, `${note}: javascript: url survived`);
  assert.doesNotMatch(out, /<iframe|<object|<embed|<form/i, `${note}: embedding tag survived`);
  return out;
}

test('strips script tags and their contents', () => {
  const out = assertInert('<p>Hello</p><script>alert(document.cookie)</script>', 'script');
  assert.match(out, /Hello/);
  // The body must not survive as visible text either.
  assert.doesNotMatch(out, /alert/);
});

test('strips inline event handlers', () => {
  assertInert('<p onclick="steal()">text</p><img src=x onerror="steal()">', 'handlers');
});

test('strips javascript: and vbscript: urls, however they are written', () => {
  for (const url of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'vbscript:msgbox(1)',
    '&#106;avascript:alert(1)',
  ]) {
    const out = assertInert(`<a href="${url}">click</a>`, `href ${url}`);
    assert.doesNotMatch(out, /alert|msgbox/i, `payload survived for ${url}`);
  }
});

test('keeps the formatting people actually paste', () => {
  const out = sanitizeRichText(
    '<p><strong>Bold</strong> and <em>italic</em></p><ul><li>one</li><li>two</li></ul>' +
      '<blockquote>quoted</blockquote><pre><code>code()</code></pre>' +
      '<table><tr><th scope="col">H</th><td colspan="2">C</td></tr></table>',
  );
  for (const tag of ['strong', 'em', 'ul', 'li', 'blockquote', 'pre', 'code', 'table', 'th', 'td']) {
    assert.match(out, new RegExp(`<${tag}[ >]`), `${tag} was dropped`);
  }
  assert.match(out, /colspan="2"/);
  assert.match(out, /scope="col"/);
});

test('keeps safe inline styles and drops dangerous ones', () => {
  const out = sanitizeRichText(
    '<p style="text-align:center;color:#ff0000;position:fixed;top:0;background-image:url(javascript:alert(1))">x</p>',
  );
  assert.match(out, /text-align:\s*center/);
  assert.match(out, /color:\s*#ff0000/i);
  assert.doesNotMatch(out, /position/i, 'position could overlay the page');
  assert.doesNotMatch(out, /background-image|url\(/i);
});

test('forces external links to be safe to open', () => {
  const out = sanitizeRichText('<a href="https://example.com">x</a>');
  assert.match(out, /rel="noopener noreferrer nofollow"/);
  assert.match(out, /target="_blank"/);
});

test('allows inline images only when they really are base64 images', () => {
  const ok = sanitizeRichText('<img src="data:image/png;base64,iVBORw0KGgo=" alt="shot">');
  assert.match(ok, /<img/, 'a genuine inline png should survive');

  for (const bad of [
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
    'data:application/javascript;base64,YWxlcnQoMSk=',
    'data:image/png,<script>alert(1)</script>',
  ]) {
    const out = sanitizeRichText(`<img src="${bad}">`);
    assert.doesNotMatch(out, /<img/, `img survived with src ${bad}`);
  }
});

test('drops embedding and form tags outright', () => {
  assertInert(
    '<iframe src="https://evil.test"></iframe><object data="x"></object>' +
      '<embed src="x"><form action="https://evil.test"><input name="p"></form>',
    'embeds',
  );
});

test('survives markup designed to break naive parsers', () => {
  assertInert('<scr<script>ipt>alert(1)</scr</script>ipt>', 'nested');
  assertInert('<img src="x" onerror=alert(1)//>', 'unquoted handler');
  assertInert('<<SCRIPT>alert(1);//<</SCRIPT>', 'doubled angle brackets');
  assertInert('<svg/onload=alert(1)>', 'svg onload');
  assertInert('<math><mtext><style><img src=x onerror=alert(1)></style></mtext></math>', 'foreign content');
});

test('recognises markup that renders as nothing', () => {
  assert.equal(isEffectivelyEmpty(''), true);
  assert.equal(isEffectivelyEmpty('<p><br></p>'), true, 'what an emptied editor leaves behind');
  assert.equal(isEffectivelyEmpty('<p>&nbsp;</p>'), true);
  assert.equal(isEffectivelyEmpty('<p>text</p>'), false);
  // An image on its own is content, even with no words.
  assert.equal(isEffectivelyEmpty('<p><img src="data:image/png;base64,iVBORw0KGgo="></p>'), false);
});

test('renders plain text for notifications', () => {
  const plain = richTextToPlain('<h1>Title</h1><p>First para</p><p>Second<br>line</p><ul><li>a</li></ul>');
  assert.equal(plain, 'Title\n\nFirst para\n\nSecond\nline\n\na');
});

test('sanitising is stable when applied twice', () => {
  // Stored values are re-sanitised on edit, so the operation must not drift.
  const once = sanitizeRichText('<p style="text-align:center"><a href="https://x.test">link</a></p>');
  assert.equal(sanitizeRichText(once), once);
});
