'use strict';
const cli = require('../../concord/core/review-cli.js');
const { resolveStateDirFromCwd } = require('../../concord/adapters/codex/statedir');
module.exports = cli;
if (require.main === module) cli.runMain(resolveStateDirFromCwd);
