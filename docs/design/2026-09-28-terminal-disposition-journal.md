# Terminal disposition journal

Initiative review ledgers use breaking schema version 3. Version 2 ledgers are rejected rather than upgraded, so a replay cannot infer terminal state from legacy fields.

Every terminal runner result is normalized into one durable disposition: `terminal`, `error`, or `escape`. A terminal disposition remains the sole replay/identity authority; error and escape entries are retained for audit but do not suppress a later retry. Duplicate dispositions are ignored under the ledger lock.

The public initiative summary remains aggregate-only. The shared core is bundled unchanged into the Codex and Copilot engines.
