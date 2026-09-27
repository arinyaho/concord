'use strict';
const state = require('../engine/lgtm-state.js');
module.exports = state;
if (require.main === module) state.runMain();
