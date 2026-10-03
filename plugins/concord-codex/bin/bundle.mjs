#!/usr/bin/env node
// Regenerate plugins/concord-codex/engine/ from the shared source so the Codex
// plugin is self-contained (codex plugin install copies only this plugin dir;
// it does not follow symlinks or include sibling plugins). Run after editing
// core/, the codex adapters, or a shared skill. The drift-guard test enforces sync.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { NOT_YET_WIRED } from './bundle-exclusions.mjs';

const here = path.dirname(url.fileURLToPath(import.meta.url));           // plugins/concord-codex/bin
const codexRoot = path.dirname(here);                                     // plugins/concord-codex
const repoRoot = path.dirname(path.dirname(codexRoot));                   // repo root
const coreDir = path.join(repoRoot, 'plugins/concord/core');
const codexAdaptersDir = path.join(repoRoot, 'plugins/concord/adapters/codex');
const engineDir = path.join(codexRoot, 'engine');
const sharedSkillsDir = path.join(repoRoot, 'plugins/concord/skills');
const packagedSkillsDir = path.join(codexRoot, 'skills');

fs.rmSync(engineDir, { recursive: true, force: true });
fs.mkdirSync(engineDir, { recursive: true });

let n = 0;
for (const f of fs.readdirSync(coreDir).filter((f) => f.endsWith('.js') && !NOT_YET_WIRED.has(f))) {
  fs.copyFileSync(path.join(coreDir, f), path.join(engineDir, f));
  n++;
}
for (const f of ['statedir.js', 'transcript.js', 'event.js']) {
  fs.copyFileSync(path.join(codexAdaptersDir, f), path.join(engineDir, f));
  n++;
}

for (const skill of ['ticket-writing', 'ticket-to-pr', 'proposal-package-authoring', 'review-until-lgtm', 'initiative-to-prs', 'deep-review']) {
  fs.rmSync(path.join(packagedSkillsDir, skill), { recursive: true, force: true });
  fs.cpSync(path.join(sharedSkillsDir, skill), path.join(packagedSkillsDir, skill), { recursive: true });
  n++;
}

console.log(`bundled ${n} files into engine/`);
