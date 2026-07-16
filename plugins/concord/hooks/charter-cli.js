'use strict';
const { resolveStateDirFromCwd } = require('../adapters/claude-code/statedir');
require('../core/charter-cli.js').runMain(resolveStateDirFromCwd);
