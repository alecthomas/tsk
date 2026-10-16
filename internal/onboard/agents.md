# Linters

This repository enforces its conventions with `tsk` linters, configured in
`.tsk/config.toml`. Use the `tsk` skill for how to enable, configure, and write
them.

- Run `tsk` to lint, and fix its findings before finishing a change. Keep an
  intentional finding with a `//nolint:<linter> <reason>` comment.
- When the user asks you to fix a kind of issue across the codebase, check
  `tsk list` for a linter that reports it. If one exists and is not enabled,
  suggest enabling it so the issue stays fixed.
- When the user asks you to apply an architectural constraint or convention,
  enforce it with a linter: enable or configure an existing one, or write one
  in `.tsk/`.
- When the user corrects you, check whether the correction is a lasting rule a
  linter could enforce. Offer a linter only when all of these hold:
  - The rule applies across the codebase, not only to the current change.
  - A linter can detect violations from Go syntax and types with few false
    positives.
  - No linter in `tsk list` already enforces it.
- Make an offer once, in your final response for the task, and do not repeat
  it if the user declines.
