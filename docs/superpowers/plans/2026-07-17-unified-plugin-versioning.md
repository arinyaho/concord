# Unified Plugin Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `VERSION` the only Concord release-version source and synchronize the Claude and Codex plugin manifests from it.

**Architecture:** `VERSION` is the canonical SemVer string. `scripts/release-version.mjs` validates a passed SemVer value and writes `VERSION` plus both required plugin manifest fields. A Node test checks live-repository parity and exercises the script against a temporary fixture via `CONCORD_VERSION_ROOT`.

**Tech Stack:** Node.js built-ins (`node:test`, `node:assert`, `node:fs`, `node:child_process`) and JSON manifests.

---

## File structure

- Create: `VERSION` — sole manually maintained version.
- Create: `scripts/release-version.mjs` — validates and applies one version to all artifacts.
- Create: `plugins/concord/hooks/test/plugin-version.test.js` — parity and isolated-script coverage.
- Modify: `plugins/concord/.claude-plugin/plugin.json` — derived Claude version.
- Modify: `plugins/concord-codex/.codex-plugin/plugin.json` — derived Codex version.

### Task 1: Define the version contract with tests

**Files:**
- Create: `plugins/concord/hooks/test/plugin-version.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const REPO = path.join(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(REPO, 'scripts/release-version.mjs');

function version(file) { return fs.readFileSync(file, 'utf8').trim(); }
function manifest(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

test('VERSION and both plugin manifests use the same release version', () => {
  const shared = version(path.join(REPO, 'VERSION'));
  assert.equal(manifest(path.join(REPO, 'plugins/concord/.claude-plugin/plugin.json')).version, shared);
  assert.equal(manifest(path.join(REPO, 'plugins/concord-codex/.codex-plugin/plugin.json')).version, shared);
});

test('release script updates an isolated canonical version and both manifests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-version-'));
  const claude = path.join(root, 'plugins/concord/.claude-plugin');
  const codex = path.join(root, 'plugins/concord-codex/.codex-plugin');
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), '0.1.0-alpha.1\\n');
  for (const [dir, name] of [[claude, 'concord'], [codex, 'concord-codex']]) {
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name, version: '0.1.0-alpha.1', preserve: true }, null, 2) + '\\n');
  }
  try {
    execFileSync(process.execPath, [SCRIPT, '0.9.0-alpha.2'], { env: { ...process.env, CONCORD_VERSION_ROOT: root } });
    assert.equal(version(path.join(root, 'VERSION')), '0.9.0-alpha.2');
    for (const file of [path.join(claude, 'plugin.json'), path.join(codex, 'plugin.json')]) {
      assert.equal(manifest(file).version, '0.9.0-alpha.2');
      assert.equal(manifest(file).preserve, true);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Verify RED**

Run `node --test plugins/concord/hooks/test/plugin-version.test.js`.

Expected: FAIL because neither `VERSION` nor `scripts/release-version.mjs` exists; the Codex manifest is also still `0.1.0-alpha.1`.

- [ ] **Step 3: Commit the failing test**

Run `git add plugins/concord/hooks/test/plugin-version.test.js` and `git commit -m "test: define unified plugin version contract"`.

### Task 2: Implement the canonical release writer

**Files:**
- Create: `VERSION`
- Create: `scripts/release-version.mjs`
- Modify: `plugins/concord/.claude-plugin/plugin.json`
- Modify: `plugins/concord-codex/.codex-plugin/plugin.json`

- [ ] **Step 1: Create `VERSION`**

Write exactly `0.9.0-alpha.2` followed by a newline.

- [ ] **Step 2: Create the minimal writer**

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const value = process.argv[2];
const semver = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$/;
if (!value || !semver.test(value)) throw new Error('Usage: node scripts/release-version.mjs <semver-version>');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.CONCORD_VERSION_ROOT || repoRoot);
const manifests = [
  path.join(root, 'plugins/concord/.claude-plugin/plugin.json'),
  path.join(root, 'plugins/concord-codex/.codex-plugin/plugin.json'),
];
fs.writeFileSync(path.join(root, 'VERSION'), `${value}\\n`);
for (const file of manifests) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.version = value;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\\n`);
}
```

- [ ] **Step 3: Synchronize the current release through the writer**

Run `node scripts/release-version.mjs 0.9.0-alpha.2`.

Expected: Codex changes from `0.1.0-alpha.1` to `0.9.0-alpha.2`; `VERSION` and the Claude manifest remain at `0.9.0-alpha.2`.

- [ ] **Step 4: Verify GREEN**

Run `node --test plugins/concord/hooks/test/plugin-version.test.js`.

Expected: PASS with both tests passing.

- [ ] **Step 5: Commit the implementation**

Run `git add VERSION scripts/release-version.mjs plugins/concord/.claude-plugin/plugin.json plugins/concord-codex/.codex-plugin/plugin.json` and `git commit -m "feat: unify Claude and Codex plugin versions"`.

### Task 3: Verify the complete release guard

**Files:**
- Test: `plugins/concord/hooks/test/*.test.js`

- [ ] **Step 1: Run all plugin tests**

Run `node --test plugins/concord/hooks/test/*.test.js`.

Expected: PASS, including `plugin-version.test.js` and `codex-bundle-drift.test.js`.

- [ ] **Step 2: Validate bad input handling**

Run `node scripts/release-version.mjs invalid-version`.

Expected: non-zero exit with `Usage: node scripts/release-version.mjs <semver-version>` and no changed files.

- [ ] **Step 3: Confirm idempotence and clean whitespace**

Run `node scripts/release-version.mjs 0.9.0-alpha.2`, then run `git diff --check`.

Expected: rerunning the canonical release makes no diff; whitespace validation passes.
