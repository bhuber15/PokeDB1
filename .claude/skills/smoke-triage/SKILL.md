---
name: smoke-triage
description: Use when the user shares smoke-testing or usage-testing notes — a raw findings log from using the app (bugs, questions, ideas mixed together) — and wants them turned into actionable work.
---

# Smoke-Test Triage

Turn a raw findings log into routed work while keeping this session thin: answer what's cheap, batch what's small, spin off what's big. Do not fix non-trivial bugs in this session.

## Workflow

1. **Archive the log.** If it isn't already a file, save it verbatim to `docs/testing/smoke-YYYY-MM-DD.md` (today's date). Append a `## Triage` section with the outcomes as you go.
2. **Flag unusable items.** Truncated or ambiguous entries ("it takes a…") get listed back to the user for completion — never guess intent.
3. **Classify every item** as one of: **question** (how does it work?), **tweak** (rename, copy change, empty state), **bug** (broken behavior), **feature** (new capability).
4. **Cluster before routing.** Items sharing a module or root cause become ONE work item (e.g. three search complaints = one search overhaul), not one chip each.
5. **Route:**

| Kind | Action | Model |
|------|--------|-------|
| Question | Read the current code, answer inline | this session |
| Tweaks | One batch → subagent in a worktree, tests included | haiku (mechanical) / sonnet (logic + tests) |
| Bug or bug cluster | Confirm it's real via code inspection or quick repro, then one spawn_task chip | sonnet (contained) / fable or opus (cross-cutting) |
| Feature | Stub spec in `docs/superpowers/`, spawn_task chip for a brainstorm session | fable or opus |

6. **Chip prompts must stand alone**: file paths, repro steps (did / expected / got), relevant domain rules from AGENTS.md, and a definition of done. The spawned session has no memory of this one.

## Final message shape

A table mapping each log item → classification → outcome (answer given / chip created / batched / needs user input), followed by the inline answers in full, then the items awaiting user clarification.

## Common mistakes

- Fixing a "quick-looking" bug inline that turns into an investigation — if the fix isn't obviously one edit, stop and chip it.
- One chip per symptom when several symptoms share a root cause.
- Chip prompts that say "the bug discussed above" — the new session cannot see above.
- Answering questions from memory instead of reading the current code.
