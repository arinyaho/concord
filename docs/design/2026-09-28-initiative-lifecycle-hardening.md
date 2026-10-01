# Initiative lifecycle hardening

Initiative execution roots and state directories are canonicalized through their nearest existing ancestor before the runner derives paths, evaluates Git ignore rules, or opens a ledger. Git-ignore validation only applies when that canonical root is an actual Git worktree and checks the actual hashed ledger path.

Terminal target revisions persist `head_sha`, including a file target's content identity. A keyed rerun checks an existing terminal target before `round-start`; it returns the stored safe aggregate only when the target and its revision pair (ref, base, head) match; another head or base is a new target that proceeds to `round-start`. A stored terminal disposition without `head_sha` (or, for a git ref, without a base) is never matched, because no identity is derived from current bytes; it neither replays nor blocks a new revision pair.

`--initiative-finalise` accepts a matching already-terminal ledger as an idempotent read-only replay, returning the same aggregate. Repository, budget, and lock mismatches remain errors.
