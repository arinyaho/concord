#!/usr/bin/env node
// Regenerate plugins/concord-codex/engine/ from the shared source so the Codex
// plugin is self-contained (codex plugin install copies only this plugin dir;
// it does not follow symlinks or include sibling plugins). Run after editing
// core/ or the codex statedir adapter. The drift-guard test enforces sync.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));           // plugins/concord-codex/bin
const codexRoot = path.dirname(here);                                     // plugins/concord-codex
const repoRoot = path.dirname(path.dirname(codexRoot));                   // repo root
const coreDir = path.join(repoRoot, 'plugins/concord/core');
const codexStatedir = path.join(repoRoot, 'plugins/concord/adapters/codex/statedir.js');
const engineDir = path.join(codexRoot, 'engine');

fs.rmSync(engineDir, { recursive: true, force: true });
fs.mkdirSync(engineDir, { recursive: true });

const header = '// GENERATED — do not edit. Vendored copy for the self-contained Codex plugin.\n// Source of truth: plugins/concord/core/ + adapters/codex/statedir.js. Regenerate: node bin/bundle.mjs\n';

let n = 0;
for (const f of fs.readdirSync(coreDir).filter((f) => f.endsWith('.js'))) {
  fs.copyFileSync(path.join(coreDir, f), path.join(engineDir, f));
  n++;
}
fs.copyFileSync(codexStatedir, path.join(engineDir, 'statedir.js'));
n++;
console.log(`bundled ${n} files into engine/`);
