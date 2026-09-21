#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const copilotRoot = path.dirname(here);
const repoRoot = path.dirname(path.dirname(copilotRoot));
const coreDir = path.join(repoRoot, 'plugins/concord/core');
const adapterDir = path.join(repoRoot, 'plugins/concord/adapters/copilot');
const engineDir = path.join(copilotRoot, 'engine');
const sharedSkillsDir = path.join(repoRoot, 'plugins/concord/skills');
const packagedSkillsDir = path.join(copilotRoot, 'skills');

fs.rmSync(engineDir, { recursive: true, force: true });
fs.mkdirSync(engineDir, { recursive: true });

const files = fs.readdirSync(coreDir).filter((file) => file.endsWith('.js'));
for (const file of files) {
  fs.copyFileSync(path.join(coreDir, file), path.join(engineDir, file));
}
for (const file of ['event.js', 'statedir.js']) {
  fs.copyFileSync(path.join(adapterDir, file), path.join(engineDir, file));
}

for (const skill of ['ticket-writing', 'ticket-to-pr', 'proposal-package-authoring', 'review-until-lgtm']) {
  fs.rmSync(path.join(packagedSkillsDir, skill), { recursive: true, force: true });
  fs.cpSync(path.join(sharedSkillsDir, skill), path.join(packagedSkillsDir, skill), { recursive: true });
}

const initiativeDir = path.join(packagedSkillsDir, 'initiative-to-prs');
fs.rmSync(initiativeDir, { recursive: true, force: true });
fs.cpSync(path.join(sharedSkillsDir, 'initiative-to-prs'), initiativeDir, { recursive: true });
fs.copyFileSync(
  path.join(copilotRoot, 'overrides/initiative-model-routing.md'),
  path.join(initiativeDir, 'references/model-routing.md'),
);

fs.mkdirSync(path.join(copilotRoot, 'skills/review-until-green/references'), { recursive: true });
fs.copyFileSync(path.join(repoRoot, 'plugins/concord/core/review-driver.md'), path.join(copilotRoot, 'skills/review-until-green/references/review-driver.md'));

process.stdout.write(`bundled ${files.length + 2} files into engine/\n`);