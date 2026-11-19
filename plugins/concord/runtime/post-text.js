'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// Text a script posts to GitHub from agent output or a user's reason. Prose is escaped and quoted; paths and quoted
// spans go only in fences; the composed text is scanned before it is posted.

// Bot command words, matched case-insensitively as the first word of a line.
const BOT_WORDS = ['bors', 'atlantis', 'r+', 'retest', 'ok-to-test', 'lgtm'];

// GitHub ends a line at CRLF, LF, or a lone CR.
const LINES = /\r\n|\r|\n/;

// Prose: `&` cannot spell a character reference (`&#64;` renders as a mention), `<` cannot open HTML, `@` cannot
// mention, and every line is a quote line.
function escapeText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/@/g, '＠').split(LINES).map((l) => `> ${l}`).join('\n');
}

// A fenced block that GitHub shows literally: its fence is longer than any backtick run inside.
function fence(text) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map((r) => r.length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}\n${text}\n${f}`;
}

function fencePath(p) {
  if (/[\r\n]/.test(p)) throw new Error('a path with a line break is not posted');
  return fence(p);
}

// The lines outside fenced blocks: a fence opens with a line of three or more backticks and closes with a line of at
// least as many.
function outsideFences(text) {
  const out = [];
  let open = 0;
  for (const line of text.split(LINES)) {
    const run = /^ {0,3}(`{3,})(.*)$/.exec(line);
    if (open) {
      if (run && run[1].length >= open && !run[2].trim()) open = 0;
    } else if (run && !run[2].includes('`')) open = run[1].length;
    else out.push(line);
  }
  return out;
}

// The reason the composed text must not be posted, or null. A line is checked after its leading quote markers and
// spaces, so escaped prose is held to the same rule as the script's own lines. `markers` are the prefixes of the
// script's own HTML comments (`<!-- review-until-approve:`); `secrets` are the GitHub token and the harness credential.
function refusal(text, { markers = [], secrets = [] } = {}) {
  if (secrets.some((s) => typeof s === 'string' && s.length >= 8 && text.includes(s))) return 'credential';
  for (const line of outsideFences(text)) {
    for (const m of line.matchAll(/<!--/g)) {
      if (!markers.some((p) => line.startsWith(p, m.index))) return 'html comment';
    }
    const bare = line.replace(/^[\s>]*/, '');
    if (bare.startsWith('/') || bare.startsWith('@')) return 'command line';
    const word = bare.split(/\s/)[0].toLowerCase().replace(/[.,:;!?]+$/, '');
    if (BOT_WORDS.includes(word)) return 'bot command';
  }
  return null;
}

// String values under a token, key or secret name, at any depth.
function secretValues(v, key = '') {
  if (typeof v === 'string') return /token|key|secret/i.test(key) ? [v] : [];
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, x]) => secretValues(x, Array.isArray(v) ? key : k));
}

// The GitHub token and the harness credential (its environment key and the secrets of its credentials file), for
// refusal(). Nothing here is printed.
function credentials(harness, env = process.env) {
  const out = [env.GH_TOKEN, env.GITHUB_TOKEN, harness === 'claude' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY];
  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env });
  if (gh.status === 0) out.push(gh.stdout.trim());
  const file = harness === 'claude'
    ? path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json')
    : path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  try { out.push(...secretValues(JSON.parse(fs.readFileSync(file, 'utf8')))); } catch { /* no credentials file */ }
  return out.filter((s) => typeof s === 'string' && s.length >= 8);
}

module.exports = { BOT_WORDS, escapeText, fence, fencePath, refusal, credentials };
