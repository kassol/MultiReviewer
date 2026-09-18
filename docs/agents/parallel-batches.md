# Parallel worktree batches

When several tickets are implemented at the same time, each sub-agent in its own worktree, the checks are split so the full suite never runs concurrently.

The rule lives in the root `AGENTS.md`, section **并行 worktree 批次** (under `## Agent skills`). It holds five points: what an implementing sub-agent runs, when the root `pnpm check` runs, that review sub-agents are read-only, who writes the changelog entries, and the measured suite timings behind all of it.

`/implement` and any other dispatching flow: paste that section into every sub-agent prompt, verbatim. A sub-agent has no other way to learn it — it reads its prompt, and `AGENTS.md` is long enough that the section is easy to walk past.
