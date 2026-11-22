# makefun-hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Rezzrizz25/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Rezzrizz25/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write — unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON edits — to a tree of text files. It finds the lines each edit names at the first of three matching tiers (exact, then trailing whitespace, then indentation), and writes every change or none (atomic). Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty.

Referral: https://make.fun/r/v4m1pbv2

## Run it

```sh
node main.ts [options] [PATCH]
```

`SPEC.md` is the whole specification. The entry is `main.ts`, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`.

## What it does

- Reads a patch in one of four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. `--format=NAME` forces one; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Matching at three tiers: tier 0 every line equal; tier 1 equal once trailing spaces and tabs are removed; tier 2 equal once leading and trailing spaces and tabs are removed. At tier 2, new lines are re-indented to the file's indentation and context lines are written as the file's own matched lines.
- Unified diffs: sections, hunks, creations, deletions, moves (reported as `R old -> new`), `\ No newline at end of file`, and the nearest occurrence to the hunk's line number.
- SEARCH/REPLACE: blocks with their path line, `ambiguous` when the old lines occur more than once, creation when the old lines are empty.
- V4A: Add / Delete / Update sections, `*** Move to:`, `@@` anchors with a cursor, and `*** End of File` chunks.
- JSON: `create`, `str_replace` (exact, exactly once), and `insert` edits, as one array or as JSON Lines.
- Atomic: a failed edit changes nothing, the edits after it still run, and when any edit failed no file is written (exit 1).

## The files

- `main.ts`: the CLI. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check main.ts gets wrong, with what differed, and the practice score. This entry scores 100/100 on the practice set.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit code, everything written to stdout and every file afterwards are exactly what SPEC.md says. stderr is never compared. Each run has 10 seconds.

---

<sub>Entered on [make.fun](https://make.fun/?ref=v4m1pbv2&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
