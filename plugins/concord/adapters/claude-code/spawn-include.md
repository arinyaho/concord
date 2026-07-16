<!-- plugins/concord/adapters/claude-code/spawn-include.md -->
**Claude Code spawn mechanism.** Spawn each reviewer subagent with the `Task`
tool, `general-purpose` agent, in a CLEAN context (do not paste prior reasoning).
Parallel spawns issued as multiple tool calls in one message run concurrently;
sequential dependencies ("wait for the file") mean issue the dependent Task only
after the prior subagent's artifact exists.
