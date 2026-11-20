'use strict';
// The user's notes: the store the user chooses (a secret gist or a private repository of the account), the keyed hash
// in the state marker, rounds that wait while the notes are only cached, and the verifier's weighing, against the
// fake GitHub of world.js. Numbers in test names are the acceptance criteria of the notes ticket.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { world, stateReview } = require('./world');
const { valid, stateOf } = require('../scripts/review-until-approve');
const { tempDir } = require('../../../hooks/test/temp-dir');

const NOTES = 'Approach X is fine; do not flag naming.';
const STORE = 'rev/rua-private-store';
const proposal = { findings: [{ severity: 'blocker', file: 'a.js', line: 3, quote: 'bad line', reason: 'r', evidence: 'e' }] };
const kept = (x = {}) => ({ class: 'blocker', file: 'a.js', line: 3, span: 'bad line', text: 'This line is bad.', reason: null, ...x });

const data = (config) => path.join(config, 'concord', 'review-until-approve');
// Every printed line fits the vocabulary and carries neither the notes nor where they are kept.
function run(w, args, { env = {}, input = '' } = {}) {
  const r = w.run([...args, '--harness', 'claude'], env, input);
  for (const line of r.out) assert.ok(valid(line), JSON.stringify(line));
  assert.ok(!r.stdout.includes(NOTES), 'stdout carries the notes');
  w.stdout = (w.stdout || '') + r.stdout;
  return r;
}
const notes = (w, text, store, opts = {}) => run(w, ['notes', 'o/r', '5', '-', ...(store ? ['--store', store] : [])], { ...opts, input: text });
const events = (r) => r.out.map((l) => l.event);
const reviewPosts = (w) => w.calls().filter((c) => c.a.includes('POST') && c.a.some((x) => /^repos\/o\/r\/pulls\/5\/reviews$/.test(x)));
const lastState = (w) => stateOf(w.read().reviews.filter((r) => r.author === 'rev').at(-1).body);
const gists = (w) => w.read().gists || [];
const parse = (content) => { const [first, ...rest] = content.split('\n'); return { key: /key: ([0-9a-f]{64})/.exec(first)[1], text: rest.join('\n') }; };
const hmac = ({ key, text }) => crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(text).digest('hex');
const storeCalls = (w) => w.calls().map((c) => ({ ...c, url: c.a.find((x) => x.startsWith('repos/rev/') || x.startsWith('gists')) })).filter((c) => c.url);
const privateRepo = (extra = {}) => ({ repos: { [STORE]: { owner: 'rev', visibility: 'private', collaborators: [], ...extra } } });

test('1: notes saved with no store configured are kept only in the cache, ask for the store, and no round runs until a store holds them', () => {
  const w = world();
  w.agents({ reviewer: [proposal], verifier: [{ findings: [kept()], verdicts: [] }] });
  const r = notes(w, NOTES);
  assert.deepEqual(r.out, [{ event: 'question', ask: 'notes-store' }]);
  assert.equal(storeCalls(w).length, 0, 'nothing goes to a store the user did not choose');
  const cache = JSON.parse(fs.readFileSync(fs.readdirSync(path.join(data(w.config), 'notes')).map((f) => path.join(data(w.config), 'notes', f))[0], 'utf8'));
  assert.equal(cache.text, NOTES);
  assert.equal(cache.stored, false);
  // A round waits: no agent, nothing posted, and the question again.
  const round = run(w, ['round', 'o/r', '5']);
  assert.deepEqual(round.out, [{ event: 'question', ask: 'notes-store', link: 'https://github.com/o/r/pull/5' }]);
  assert.deepEqual(w.agentRuns(), []);
  assert.equal(reviewPosts(w).length, 0);
  // The user's answer is recorded, and the cached notes go to the store.
  const saved = run(w, ['notes', 'o/r', '5', '--store', 'gist']);
  assert.deepEqual(saved.out, [{ event: 'notes', saved: true, empty: false }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data(w.config), 'config.json'), 'utf8')), { notes: { store: 'gist' } });
  // Now the round runs with the notes, given to both agents as the user's.
  const ran = run(w, ['round', 'o/r', '5']);
  assert.deepEqual(events(ran), ['published']);
  const prompts = w.agentRuns().map((a) => a.prompt);
  assert.equal(prompts.length, 2);
  for (const p of prompts) assert.match(p, /The user's notes for this pull request:\n\n```\nApproach X is fine; do not flag naming\.\n```/);
  assert.equal(lastState(w).notes, hmac(parse(gists(w)[0].files['notes.md'].content)));
});

test('2: the gist is secret with the fixed description; an empty cache finds it; of two, the newest is used and the duplicate reported', () => {
  const w = world();
  assert.deepEqual(notes(w, NOTES, 'gist').out, [{ event: 'notes', saved: true, empty: false }]);
  const [g] = gists(w);
  assert.equal(g.public, false);
  assert.equal(g.description, 'concord review notes: o/r#5');
  const stored = parse(g.files['notes.md'].content);
  assert.equal(stored.text, NOTES);
  // Saving the same notes again keeps the key, so the hash does not change, and updates the same gist.
  notes(w, NOTES, 'gist');
  assert.equal(gists(w).length, 1);
  assert.equal(parse(gists(w)[0].files['notes.md'].content).key, stored.key);
  // Another machine: an empty state directory with no store configured, and a state review that shows the hash.
  w.update((v) => { v.reviews.push(stateReview(w, { notes: hmac(stored) })); });
  const other = tempDir('rua-other-');
  const st = run(w, ['state', 'o/r', '5'], { env: { CLAUDE_CONFIG_DIR: other } });
  assert.deepEqual(st.out[0].pending, [], 'the notes found are the ones the state shows');
  assert.ok(!st.out.some((l) => l.event === 'question'));
  // A second, newer gist for the same pull request: it is used, and the older one is reported.
  const newer = { key: 'b'.repeat(64), text: 'Newer notes.' };
  w.update((v) => { v.gists.push({ ...g, id: 'gnewer', created_at: new Date(Date.now() + 3600e3).toISOString(), files: { 'notes.md': { content: `<!-- concord review notes key: ${newer.key} -->\n${newer.text}` } } }); });
  const dup = run(w, ['state', 'o/r', '5'], { env: { CLAUDE_CONFIG_DIR: other } });
  assert.deepEqual(dup.out[0].pending, ['notes'], 'the newest gist holds other notes');
  assert.ok(dup.out.some((l) => l.event === 'notes' && l.duplicates === 1));
  const looked = run(w, ['notes', 'o/r', '5', '--store', 'gist'], { env: { CLAUDE_CONFIG_DIR: other } });
  assert.deepEqual(looked.out, [{ event: 'notes', saved: false, empty: false, duplicates: 1 }]);
  // Without the gist scope, saving is refused and the notes stay cached only.
  const n = world({ noGistScope: true });
  assert.deepEqual(notes(n, NOTES, 'gist').out, [{ event: 'question', ask: 'notes-unusable', problem: 'scope' }]);
  assert.deepEqual(run(n, ['round', 'o/r', '5']).out, [{ event: 'question', ask: 'notes-unusable', problem: 'unsaved', link: 'https://github.com/o/r/pull/5' }]);
  assert.deepEqual(n.agentRuns(), []);
  // A token without the gist scope never reads as "no notes": with the notes saved earlier, the round waits.
  const lost = world();
  notes(lost, NOTES, 'gist');
  lost.update((v) => { v.noGistScope = true; });
  assert.deepEqual(run(lost, ['round', 'o/r', '5']).out, [{ event: 'question', ask: 'notes-unusable', problem: 'scope', link: 'https://github.com/o/r/pull/5' }]);
  assert.deepEqual(lost.agentRuns(), []);
});

test('3: the repository store is refused unless the account owns it, it is private, and nobody else collaborates; checked before every read and write; never created', () => {
  const cases = {
    owner: privateRepo({ owner: 'someone' }),
    visibility: privateRepo({ visibility: 'internal' }),
    collaborator: privateRepo({ collaborators: ['eve'] }),
    pages: privateRepo({ pages: true }),
    missing: { repos: {} },
  };
  for (const [problem, extra] of Object.entries(cases)) {
    const w = world(extra);
    assert.deepEqual(notes(w, NOTES, `repo:${STORE}`).out, [{ event: 'question', ask: 'notes-unusable', problem }], problem);
    assert.ok(!w.calls().some((c) => c.a.includes('PUT')), `${problem}: nothing written`);
  }
  // A 403 (a rate limit, single sign-on) is GitHub's failure, not a refusal that names a check.
  const limited = world({ ...privateRepo(), fail: [{ match: `repos/${STORE}$`, status: '403' }] });
  assert.deepEqual(notes(limited, NOTES, `repo:${STORE}`).out, [{ event: 'error', reason: 'github' }]);
  const pub = world(privateRepo({ visibility: 'public' }));
  assert.deepEqual(notes(pub, NOTES, `repo:${STORE}`).out, [{ event: 'question', ask: 'notes-unusable', problem: 'visibility' }]);

  const w = world(privateRepo());
  w.agents({ reviewer: [proposal], verifier: [{ findings: [kept()], verdicts: [] }] });
  assert.deepEqual(notes(w, NOTES, `repo:${STORE}`).out, [{ event: 'notes', saved: true, empty: false }]);
  const file = w.read().repos[STORE].files['o/r/5.md'];
  assert.equal(parse(file).text, NOTES);
  assert.deepEqual(events(run(w, ['round', 'o/r', '5'])), ['published']);
  assert.equal(lastState(w).notes, hmac(parse(file)));
  // Every read and write of the file comes right after the two checks.
  const calls = storeCalls(w);
  const contents = calls.map((c, i) => [c, i]).filter(([c]) => c.url.includes('/contents/'));
  assert.ok(contents.length >= 3);
  for (const [, i] of contents) {
    assert.equal(calls[i - 2].url, `repos/${STORE}`);
    assert.match(calls[i - 1].url, new RegExp(`^repos/${STORE}/collaborators`));
  }
  // A collaborator added later: the next round reads nothing from the store and runs nothing.
  w.update((v) => { v.repos[STORE].collaborators = ['eve']; });
  const before = w.agentRuns().length;
  w.push({ 'a.js': 'one\ntwo\nworse line\nthree\n' });
  assert.deepEqual(run(w, ['round', 'o/r', '5']).out, [{ event: 'question', ask: 'notes-unusable', problem: 'collaborator', link: 'https://github.com/o/r/pull/5' }]);
  assert.equal(w.agentRuns().length, before);
  assert.ok(!storeCalls(w).slice(calls.length).some((c) => c.url.includes('/contents/')));
  // No repository is ever created.
  for (const x of [w, pub]) assert.ok(!x.calls().some((c) => c.a.some((a) => /^(user|orgs\/[^/]+)\/repos/.test(a))));
});

test('4: the marker holds a keyed hash, empty for no notes; changed notes are pending and the next round is broad', () => {
  const w = world();
  w.agents({ reviewer: [{ findings: [] }], verifier: [{ findings: [], verdicts: [] }] });
  run(w, ['round', 'o/r', '5']);
  assert.equal(lastState(w).notes, '', 'no notes: an empty field');
  notes(w, NOTES, 'gist');
  const stored = parse(gists(w)[0].files['notes.md'].content);
  assert.notEqual(hmac(stored), crypto.createHash('sha256').update(NOTES).digest('hex'));
  const st = run(w, ['state', 'o/r', '5']);
  assert.deepEqual(st.out[0].pending, ['notes']);
  // A push and changed notes: the round reviews the whole pull request, not the commits since the reviewed head.
  w.push({ 'a.js': 'one\ntwo\nbad line\nthree\nfour\n' });
  assert.deepEqual(events(run(w, ['round', 'o/r', '5'])), ['published']);
  const s = lastState(w);
  assert.equal(s.notes, hmac(stored));
  assert.equal(s.base, w.mergeBase);
  assert.ok(!w.agentRuns().at(-1).files.includes('pr.patch'));
  assert.deepEqual(run(w, ['state', 'o/r', '5']).out[0].pending, []);
  // Saved again as empty: the field is empty again, which is pending as a change.
  assert.deepEqual(notes(w, '', 'gist').out, [{ event: 'notes', saved: true, empty: true }]);
  assert.deepEqual(run(w, ['state', 'o/r', '5']).out[0].pending, ['notes']);
  run(w, ['round', 'o/r', '5']);
  assert.equal(lastState(w).notes, '');
});

test('5: across a full round, neither the gist id nor the repository name is in any output, log, notice, request, or posted text', () => {
  for (const store of ['gist', `repo:${STORE}`]) {
    const w = world({ ...privateRepo(), fail: [] });
    w.agents({ reviewer: [proposal], verifier: [{ findings: [kept()], verdicts: [], notFlagged: [kept({ class: 'minor', span: 'two' })] }] });
    notes(w, NOTES, store);
    const where = store === 'gist' ? gists(w)[0].id : STORE;
    run(w, ['round', 'o/r', '5']);
    run(w, ['state', 'o/r', '5']);
    // A store read that fails writes to the log.
    w.update((v) => { v.fail.push({ match: store === 'gist' ? ' gists' : STORE, times: 1, status: '502' }); });
    w.push({ 'a.js': 'one\ntwo\nworse line\nthree\n' });
    run(w, ['round', 'o/r', '5']);
    fs.mkdirSync(data(w.config), { recursive: true });
    fs.writeFileSync(path.join(data(w.config), 'watch.json'), JSON.stringify({ entries: { 'o/r#5': { repo: 'o/r', n: 5, login: 'rev', harness: 'claude', model: null, effort: null } } }));
    w.stdout += w.run(['check', '--harness', 'claude']).stdout;
    const log = fs.readFileSync(path.join(data(w.config), 'log'), 'utf8');
    assert.match(log, /gh notes store: HTTP 502/, store);
    const notices = (() => { try { return fs.readdirSync(path.join(w.config, 'concord', 'notices')).map((f) => fs.readFileSync(path.join(w.config, 'concord', 'notices', f), 'utf8')).join('\n'); } catch { return ''; } })();
    const posted = w.calls().filter((c) => c.a.some((x) => x.startsWith('repos/o/r/'))).map((c) => c.input).join('\n');
    const requests = w.agentRuns().map((a) => JSON.stringify(a)).join('\n');
    const reviews = w.read().reviews.map((r) => r.body).join('\n') + w.read().threads.flatMap((t) => t.comments.nodes.map((c) => c.body)).join('\n');
    assert.ok(posted.length > 0 && reviews.length > 0);
    for (const [name, text] of Object.entries({ stdout: w.stdout, log, notices, posted, requests, reviews })) assert.ok(!text.includes(where), `${store}: ${name} names the store`);
    assert.ok(!reviews.includes(NOTES), `${store}: a review quotes the notes`);
  }
});

test('6: a blocker under a "do not flag" note is published as asked; minors are counted; a set-aside needs a span', () => {
  const w = world();
  notes(w, NOTES, 'gist');
  w.agents({ reviewer: [proposal], verifier: [{
    findings: [],
    verdicts: [],
    notFlagged: [kept(), kept({ class: 'minor', span: 'two', text: 'Unflagged minor.' })],
    setAside: [kept({ class: 'minor', span: 'one', text: 'Set aside by the note.' }), kept({ span: null, text: 'No span settles it.' })],
  }] });
  const r = run(w, ['round', 'o/r', '5']);
  assert.deepEqual(events(r), ['published', 'question']);
  assert.equal(r.out[0].review, 'COMMENT');
  assert.deepEqual(r.out[1], { event: 'question', ask: 'asked', keys: ['1.1', '1.2'], link: 'https://github.com/o/r/pull/5' });
  const s = lastState(w);
  assert.deepEqual(s.findings.map((x) => [x.key, x.class, x.status]), [['1.1', 'blocker', 'asked'], ['1.2', 'blocker', 'asked']]);
  const body = w.read().reviews.at(-1).body;
  assert.match(body, /### For the reviewer to decide\n\n- `1\.1` \(blocker\)/);
  assert.match(body, /### Set aside by the reviewer's notes\n\n1 minor finding\(s\) not flagged, as the reviewer's notes ask\.\n\n- \*\*minor\*\*\n\n> Set aside by the note\./);
  assert.match(body, /```\none\n```/);
  assert.ok(!body.includes('Unflagged minor.'));
  // Agent text that quotes a line of the notes is not posted: the list fails.
  const q = world();
  notes(q, NOTES, 'gist');
  q.agents({ reviewer: [proposal], verifier: [{ findings: [kept({ text: `The reviewer said: ${NOTES.toUpperCase()}` })], verdicts: [] }] });
  assert.deepEqual(run(q, ['round', 'o/r', '5']).out, [{ event: 'failed', reason: 'verifier-list' }]);
  assert.equal(reviewPosts(q).length, 0);
  // A set-aside whose span does not occur at the head fails the list.
  const b = world();
  notes(b, NOTES, 'gist');
  b.agents({ reviewer: [proposal], verifier: [{ findings: [], verdicts: [], setAside: [kept({ span: 'not in the file' })] }] });
  assert.deepEqual(run(b, ['round', 'o/r', '5']).out, [{ event: 'failed', reason: 'verifier-list' }]);
});

test('7: a state whose notes hash the machine cannot obtain runs nothing and asks for the store', () => {
  const setups = {
    'no store, no gist': () => {},
    'gist store, no gist': (w) => notes(w, '', 'gist'),
    'repository store, no file': (w) => run(w, ['notes', 'o/r', '5', '--store', `repo:${STORE}`]),
  };
  for (const [name, setup] of Object.entries(setups)) {
    const w = world(privateRepo());
    w.update((v) => { v.reviews.push(stateReview(w, { notes: 'c'.repeat(64) })); });
    setup(w);
    if (name === 'gist store, no gist') w.update((v) => { v.gists = []; });
    const callsBefore = reviewPosts(w).length;
    const r = run(w, ['round', 'o/r', '5']);
    assert.deepEqual(r.out, [{ event: 'question', ask: 'notes-store', link: 'https://github.com/o/r/pull/5' }], name);
    assert.deepEqual(w.agentRuns(), [], name);
    assert.equal(reviewPosts(w).length, callsBefore, `${name}: nothing approved`);
    // The watcher's check lists the question and starts nothing.
    fs.mkdirSync(data(w.config), { recursive: true });
    fs.writeFileSync(path.join(data(w.config), 'watch.json'), JSON.stringify({ entries: { 'o/r#5': { repo: 'o/r', n: 5, login: 'rev', harness: 'claude', model: null, effort: null } } }));
    w.run(['check', '--harness', 'claude']);
    const lines = fs.readdirSync(path.join(w.config, 'concord', 'notices')).map((f) => fs.readFileSync(path.join(w.config, 'concord', 'notices', f), 'utf8'));
    assert.ok(lines.some((l) => l.includes('o/r#5 question notes-store https://github.com/o/r/pull/5')), `${name}: ${lines}`);
  }
});

test('decide approves nothing while the notes are only cached or not yet weighed by a round', () => {
  for (const name of ['cached only', 'changed']) {
    const w = world();
    w.update((v) => { v.reviews.push(stateReview(w, { findings: [{ key: '1.1', class: 'blocker', status: 'open', file: 'a.js', line: 3, raised: w.head, at: w.head, closed: null, closedRound: null, decided: false }] })); });
    const r0 = notes(w, NOTES, name === 'changed' ? 'gist' : undefined);
    assert.equal(r0.out[0].event, name === 'changed' ? 'notes' : 'question', name);
    const d = run(w, ['decide', 'o/r', '5', '1.1', 'waive', '--reason', 'Not a problem.']);
    assert.deepEqual(events(d), name === 'changed' ? ['decided'] : ['decided', 'question'], name);
    assert.equal(reviewPosts(w).length, 0, `${name}: nothing approved`);
  }
});

test('state reports a failed store read as github', () => {
  const w = world({ fail: [] });
  notes(w, NOTES, 'gist');
  w.update((v) => { v.fail.push({ match: ' gists', times: 1, status: '502' }); });
  assert.deepEqual(run(w, ['state', 'o/r', '5']).out, [{ event: 'error', reason: 'github' }]);
});
