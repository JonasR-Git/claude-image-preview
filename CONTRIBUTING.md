# Contributing

Thanks for helping. Bug reports with the output of `/image-preview status` are the most useful thing you can
send; for a change in behavior, please open an issue first so we can agree on it.

## Setup

You need Claude Code (2.1.296 or later) and nothing else: the plugin is TypeScript that Claude Code runs
directly, with no build step and no dependencies.

```sh
git clone https://github.com/JonasR-Git/claude-image-preview
cd claude-image-preview
claude --plugin-dir .           # a session with your working copy; edits reload when a turn ends
```

## Before you send a pull request

```sh
claude plugin validate --strict .
claude plugin test .
npx -p typescript tsc -p .      # needs .claude-plugin/types/, written when Claude Code first loads the folder
npx prettier@3.5.3 --check .
```

CI runs the first two on Linux, macOS and Windows, compiles the Windows overlay helper and checks the
formatting.

- Keep to the layers in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): only `hooks/register.tsx` talks to Claude
  Code; everything else gets the outside world passed in, so it can be tested with the fake host.
- Every command is an argument vector. Never build a shell or PowerShell string from a path; use `psString`
  for PowerShell literals.
- The Windows helper (`hooks/lib/platform/overlay.cs`) must never write to the console it attaches to: what it
  writes would land in the person's prompt. It logs to `overlay.log`.
- Add a test for what you fix or add. Decoder fixtures come from `scripts/make-fixtures.py` (Pillow); run it
  from the repository root and commit `tests/fixtures/images.ts`.
- Comments say why, not what; match the style of the code around them.
- Add a line to `CHANGELOG.md` under a heading for the next version.

## Releases

The version lives in `.claude-plugin/plugin.json`. A release is tagged with `claude plugin tag .`, which checks
that the manifest and the marketplace entry agree.
