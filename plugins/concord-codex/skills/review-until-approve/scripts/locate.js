'use strict';
// Finds the review runner modules and the review CLI for the package the skill is
// installed in: the Claude plugin keeps them in core/ and hooks/, the Codex
// plugin in engine/ and bin/.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', '..');
const layouts = [
  { core: path.join(root, 'core'), cli: path.join(root, 'hooks', 'review-cli.js') },
  { core: path.join(root, 'engine'), cli: path.join(root, 'bin', 'review-cli.js') },
];
const found = layouts.find((l) => fs.existsSync(path.join(l.core, 'codex-review-runner.js')) && fs.existsSync(l.cli));
if (!found) {
  process.stderr.write(`review-until-approve: Concord runner not found under ${root}\n`);
  process.exit(2);
}
module.exports = found;
