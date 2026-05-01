# CLAUDE.md

## Project working principles

This project values correctness, maintainability, and small reviewable changes over clever or overly compact code.

When implementing changes:

- Prefer simple, explicit code over premature abstraction.
- Preserve existing public APIs unless explicitly asked to change them.
- Preserve existing behavior unless the task clearly requires behavior change.
- Avoid unrelated refactors while implementing a task.
- Do not introduce new dependencies unless there is a clear reason.
- Do not remove error handling, validation, logging, or tests just to make code shorter.
- When uncertain about intent, explain the uncertainty before making broad changes.

## Editing rules

When modifying code:

- Keep changes scoped to the requested task.
- Avoid formatting-only churn in unrelated files.
- Do not rewrite large modules unless explicitly requested.
- Do not rename exported APIs unless explicitly requested.
- Do not change database schemas, migrations, or persistence behavior unless the task requires it.
- Do not update snapshots or test expectations unless the behavior change is intentional.

## Commenting style

Prefer comments that explain why, not what.

Preserve comments that explain:

- business rules
- external API quirks
- non-obvious trade-offs
- concurrency or consistency constraints
- security constraints
- performance constraints
- compatibility constraints

Avoid comments that merely restate the code, tutorial-style comments, or vague TODOs.

## Testing expectations

For behavior changes, consider:

- happy path
- edge cases
- failure cases
- regression risk

When adding or changing logic, suggest relevant tests if they are missing.

Do not claim tests passed unless they were actually run.

## Review priorities

When reviewing code, prioritize issues in this order:

1. Correctness and regression risk
2. Security and authorization
3. Data consistency and state transitions
4. Error handling and observability
5. Performance and scalability
6. Test coverage
7. Maintainability
8. Style

Avoid nitpicks unless they indicate a deeper maintainability problem.

Good review comments should explain:

- what is wrong
- why it matters
- where it happens
- how to fix it

## Git and commit rules

Do not commit automatically unless I explicitly ask.

Before committing:

- inspect git status
- inspect staged and unstaged diffs
- check for unrelated files
- check for secrets or environment files
- propose a commit plan if changes contain multiple logical units

Commit message rules:

- Do not include task tracker codes (e.g. `T3`, `T12`) in commit subjects or bodies. Describe the change itself, not its slot in `tasks/todo.md`.

Never run:

- git push
- git push --force
- git reset --hard
- git clean -fd
- git commit --no-verify

unless I explicitly ask for it.

## Post-task workflow

After implementing a task, use the following workflow when appropriate:

Small change:

1. /deslop
2. /code-review --focus correctness
3. /commit-pr

Medium change:

1. /simplify
2. /deslop
3. /code-review
4. /commit-pr

Large or risky change:

1. /task-done-check
2. /simplify
3. /deslop
4. /code-review --focus correctness
5. /code-review --focus tests
6. /commit-pr

For security-sensitive changes, also use:
/code-review --focus security

Do not run these workflows automatically unless I ask.
Suggest them when the task appears complete.
