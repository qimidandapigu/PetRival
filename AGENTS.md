# PetRival task rules

Read `README.md`, `CONTRIBUTING.md` and `docs/SITES.md` before making changes.

- The repository root is the canonical implementation. `sites-app/` is a publishing mirror; `.artifacts/` contains historical deliveries and experiments. Neither is a baseline for new features.
- Before editing, inspect the checkout path, branch, status and upstream; fetch `origin` and use the latest `origin/main` as the base. Never treat a fixed historical commit in a document as the latest main.
- Preserve existing uncommitted work. Do not reset, clean, overwrite, or stage unrelated changes. If an existing branch has work, preserve it and integrate the latest main without discarding that work.
- Independent tasks use their own `codex/` branch and worktree based on the latest main. Never switch the branch in a directory another task is using. If an isolated checkout cannot be created, coordinate file ownership before editing the shared checkout.
- Return a focused commit/diff, base commit, changed file list, validation and limitations to the integration task. Do not copy an old full-file delivery over updated application code.
- Keep Node and Sites behavior aligned for shared features, or explicitly identify a runtime gap. Preserve phone identity, guest binding, courtyard, conversation, appearance, both games and skill snapshots unless the requested change requires otherwise.
- Only the coordinated Site owner publishes to the existing Site. Do not create another Site or modify production configuration as a side effect of a feature task.
- Update the relevant Markdown documentation with behavior changes. Distinguish automated fixtures, real model/browser checks, GitHub delivery and deployed behavior.
- Never commit credentials, cookies, `.env`, `.dev.vars`, player data or private task artifacts.

These rules implement the user's instruction that subsequent tasks work from the latest merged main.
