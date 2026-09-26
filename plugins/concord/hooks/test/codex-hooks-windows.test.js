'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// plugins/concord-codex/hooks.json is the Codex CLI plugin's hook manifest.
// Codex's own hook-handler schema (codex-rs/config/src/hook_config.rs,
// HookHandlerConfig::Command) defines a `commandWindows` sibling field next
// to `command` as the per-hook Windows override -- the same mechanism
// concord-copilot's hooks.json already uses under the name "windows". The
// existing `command` value here is an `sh -c '...'` POSIX script, which has
// no sh.exe on native Windows; every hook entry therefore needs a
// `commandWindows` override that resolves node and the target script without
// depending on sh/bash.
function loadHandlers() {
  const manifestPath = path.join(__dirname, '..', '..', '..', 'concord-codex', 'hooks.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const handlers = [];
  for (const groups of Object.values(manifest.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) handlers.push(handler);
    }
  }
  return handlers;
}

test('every concord-codex hook has a commandWindows override', () => {
  const handlers = loadHandlers();
  assert.ok(handlers.length > 0, 'expected at least one hook handler');
  for (const handler of handlers) {
    assert.strictEqual(typeof handler.commandWindows, 'string', `missing commandWindows for command: ${handler.command}`);
    assert.ok(handler.commandWindows.trim().length > 0, `empty commandWindows for command: ${handler.command}`);
  }
});

test('commandWindows never shells out to sh or bash', () => {
  const handlers = loadHandlers();
  for (const handler of handlers) {
    assert.ok(!/\bsh\b|\bbash\b/.test(handler.commandWindows), `commandWindows still depends on sh/bash: ${handler.commandWindows}`);
  }
});

test('commandWindows still resolves and runs the same target .js file as command', () => {
  const handlers = loadHandlers();
  for (const handler of handlers) {
    const targetMatch = handler.command.match(/([\w-]+\.js)/);
    assert.ok(targetMatch, `could not find a target .js file in command: ${handler.command}`);
    assert.ok(handler.commandWindows.includes(targetMatch[1]), `commandWindows does not reference ${targetMatch[1]}: ${handler.commandWindows}`);
  }
});

// A GitHub Codex review on this exact manifest (PR #113) caught that
// invoking PowerShell by its bare name lets it be resolved by cwd-before-
// PATH search order -- the same class of bug as the core spawn helper's,
// but here it's Codex's own hook dispatcher doing the resolving, not
// anything this repo's crossPlatformCommand can intercept. The fix is an
// absolute path to the well-known system PowerShell location instead.
test('commandWindows invokes PowerShell by an absolute path, not a bare name', () => {
  const handlers = loadHandlers();
  for (const handler of handlers) {
    assert.match(handler.commandWindows, /^[A-Za-z]:\\.*\\powershell\.exe\b/i, `commandWindows must invoke PowerShell by an absolute path, not a bare name resolvable via cwd: ${handler.commandWindows}`);
  }
});
