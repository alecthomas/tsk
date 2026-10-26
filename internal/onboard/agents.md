# Linters

This repository enforces its conventions with `tsk` linters, configured in
`.tsk/config.toml`. Use the `tsk` skill for how to enable, configure, and write
them.

- Run `tsk` to lint, and fix its findings before finishing a change. Keep an
  intentional finding with a `//nolint:<linter> // <reason>` comment.
- When the user asks you to fix a kind of issue across the codebase, check
  `tsk list` for a linter that reports it. If one exists and is not enabled,
  suggest enabling it so the issue stays fixed.
- When the user asks you to apply an architectural constraint or convention,
  enforce it with a linter: enable or configure an existing one, or write one
  in `.tsk/`.
- When the user corrects you, check whether the correction is a lasting rule a
  linter could enforce. Any review comment or question that leads you to
  change code is a correction. "Why is this a separate type?" counts as much
  as "don't do this".
- Offer a linter if these plausibly hold. They are a quick filter, not a gate,
  and the user decides whether the linter is worth it:
  - The rule applies across the codebase, not only to the current change.
  - A linter can detect violations from Go syntax and types with few false
    positives.
  - No linter in `tsk list` already enforces it.
- Make the offer in the response that applies the correction, not later in the
  session. End that response with one sentence that names the rule and says
  how a linter would detect it.
- Offer once per rule, and do not repeat it if the user declines.
