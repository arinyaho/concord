'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../hooks/test/temp-dir');
const { BOT_WORDS, escapeText, fence, fencePath, refusal, credentials } = require('../post-text');

const MARKERS = ['<!-- review-until-approve:'];

test('escaped text keeps no working mention or HTML, and every line is a quote line', () => {
  const out = escapeText('ping @alice and <b>x</b>\n<!-- review-until-approve:state x -->\n@team');
  assert.ok(!out.includes('@'));
  assert.ok(!out.includes('<'));
  assert.deepEqual(out.split('\n').map((l) => l.slice(0, 2)), ['> ', '> ', '> ']);
  assert.equal(out.split('\n')[0], '> ping ＠alice and &lt;b>x&lt;/b>');
  assert.equal(refusal(out, { markers: MARKERS }), null);
});

test('a character reference cannot spell a mention, and a lone CR still starts a quote line', () => {
  for (const t of ['&#64;octocat', '&commat;octocat', '&#x40;octocat']) {
    const out = escapeText(t);
    assert.equal(out, `> &amp;${t.slice(1)}`);
    assert.ok(!/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(out.replace(/&amp;|&lt;/g, '')), out);
  }
  assert.equal(escapeText('fine\r/approve\r\nlgtm'), '> fine\n> /approve\n> lgtm');
  assert.equal(refusal('fine\r/approve'), 'command line');
  assert.equal(refusal('fine\rlgtm'), 'bot command');
  // A fence closed by a lone CR is a fence to GitHub, and so to the scan.
  assert.equal(refusal('```\r/approve\r```\r/merge'), 'command line');
  assert.equal(refusal('```\r/approve\r```'), null);
});

test('a span holding a backtick run gets a longer fence, so it closes only at its own end', () => {
  for (const span of ['a ``` b', '````\n<!-- x -->\n@bob', '`x`', 'plain']) {
    const block = fence(span);
    const lines = block.split('\n');
    const f = lines[0];
    assert.match(f, /^`{3,}$/);
    assert.equal(lines.at(-1), f);
    const longest = Math.max(0, ...(span.match(/`+/g) || []).map((r) => r.length));
    assert.ok(f.length > longest, span);
    // No line inside could close it: a closing fence needs at least as many backticks and nothing else.
    for (const l of lines.slice(1, -1)) assert.ok(!(new RegExp(`^ {0,3}\`{${f.length},}\\s*$`)).test(l), l);
    assert.equal(refusal(block, { markers: MARKERS }), null, span);
  }
  assert.equal(fence('a ``` b'), '````\na ``` b\n````');
});

test('a path with a line break is refused; another is fenced', () => {
  assert.throws(() => fencePath('a\nb'));
  assert.throws(() => fencePath('a\rb'));
  assert.equal(fencePath('src/@x/<y>.js'), '```\nsrc/@x/<y>.js\n```');
});

test('outside fences, a foreign HTML comment and a line starting with /, @ or a bot command word are refused', () => {
  const ok = (t) => assert.equal(refusal(t, { markers: MARKERS }), null, t);
  const no = (t, why) => assert.equal(refusal(t, { markers: MARKERS }), why, t);
  ok('<!-- review-until-approve:state abc -->\nFindings: 2');
  no('text <!-- hidden --> more', 'html comment');
  no('<!-- review-until-approve:state x --> <!-- other -->', 'html comment');
  no('/approve', 'command line');
  no('  /merge', 'command line');
  no('> /retest', 'command line');
  no('@bot do it', 'command line');
  for (const word of BOT_WORDS) {
    no(`${word} please`, 'bot command');
    no(`${word.toUpperCase()}`, 'bot command');
    no(`> ${word}, ok`, 'bot command');
  }
  assert.deepEqual(BOT_WORDS, ['bors', 'atlantis', 'r+', 'retest', 'ok-to-test', 'lgtm']);
  ok('the lgtm label and a /path in prose');
  ok('```\n/approve\n@bot\n<!-- x -->\nlgtm\n```');
  // A fence opened inside a quote does not hide lines from the scan.
  no('> ```\n/approve\n> ```', 'command line');
});

test('the GitHub token or the harness credential anywhere, inside a fence included, is refused', () => {
  const secret = 'ghp_0123456789abcdefABCDEF0123456789abcd';
  assert.equal(refusal(`ok ${secret}`, { secrets: [secret] }), 'credential');
  assert.equal(refusal(fence(secret), { secrets: [secret] }), 'credential');
  assert.equal(refusal('ok', { secrets: [secret, '', 'short'] }), null);
});

test('credentials reads the token values of the harness credentials file and the credential variables', () => {
  const home = tempDir('pt-cred-');
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt-long-value', OPENAI_API_KEY: null, tokens: { access_token: 'acc-0123456789', refresh_token: 'ref-0123456789', account_id: 'acct-0123456789' } }));
  const got = credentials('codex', { CODEX_HOME: home, GH_TOKEN: 'gh-token-0123', PATH: '' });
  for (const s of ['acc-0123456789', 'ref-0123456789', 'gh-token-0123']) assert.ok(got.includes(s), s);
  assert.ok(!got.includes('acct-0123456789'));
  assert.ok(!got.includes('chatgpt-long-value'));
  const cfg = tempDir('pt-cred-c-');
  fs.writeFileSync(path.join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-0123', refreshToken: 'sk-ant-ort-0123', expiresAt: 1 } }));
  const c = credentials('claude', { CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_API_KEY: 'sk-ant-api-0123', PATH: '' });
  for (const s of ['sk-ant-oat-0123', 'sk-ant-ort-0123', 'sk-ant-api-0123']) assert.ok(c.includes(s), s);
});
