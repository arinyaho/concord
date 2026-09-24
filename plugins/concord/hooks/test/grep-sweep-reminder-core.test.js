'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isSearchSweepCommand, shouldRemind, reminderText } = require('../../core/grep-sweep-reminder');

test('isSearchSweepCommand: matches grep and rg as standalone command words', () => {
  assert.equal(isSearchSweepCommand('grep -rn foo src/'), true);
  assert.equal(isSearchSweepCommand('rg foo src/'), true);
  assert.equal(isSearchSweepCommand('cat foo | grep bar'), true);
  assert.equal(isSearchSweepCommand('egrep -rn foo src/'), true);
  assert.equal(isSearchSweepCommand('fgrep foo src/'), true);
});

test('isSearchSweepCommand: does not match rg/grep as a substring of another word', () => {
  assert.equal(isSearchSweepCommand('node program.js'), false);
  assert.equal(isSearchSweepCommand('ls -la'), false);
});

test('isSearchSweepCommand: non-string input is not a sweep command', () => {
  assert.equal(isSearchSweepCommand(undefined), false);
  assert.equal(isSearchSweepCommand(null), false);
});

test('shouldRemind: false under the threshold', () => {
  for (let count = 1; count < 10; count += 1) assert.equal(shouldRemind(count), false);
});

test('shouldRemind: true at the threshold and every multiple after', () => {
  assert.equal(shouldRemind(10), true);
  assert.equal(shouldRemind(20), true);
  assert.equal(shouldRemind(11), false);
  assert.equal(shouldRemind(19), false);
});

test('reminderText: names the delegate-verbose-work skill', () => {
  assert.match(reminderText(10), /delegate-verbose-work/);
});

test('reminderText: reflects a passed-in threshold, not a hardcoded 10', () => {
  assert.match(reminderText(20, 20), /roughly 20\+ calls/);
  assert.doesNotMatch(reminderText(20, 20), /roughly 10\+ calls/);
});
