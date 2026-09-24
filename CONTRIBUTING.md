# Contributing

Thanks for looking under the hood. Vegan Grove's code is public so the community can audit how member data is handled. Read `LICENSE` first: contributions are welcome, redistribution is not.

## Before you start

1. Read `SOUL.md` and `PRODUCT-PRINCIPLES-CHECKLIST.md`.
2. Open an issue describing the change. Privacy-affecting changes need a short data-inventory note in the issue.
3. Use Node 24 (`.nvmrc`). Run `npm ci`.

## Workflow

- Branch from `main`: `feat/<thing>`, `fix/<thing>`, `docs/<thing>`.
- Run `npm run validate` before pushing. It is the same check CI runs.
- Never commit `.env` files, credentials, `ios/`, `android/`, or hostnames of real infrastructure. `secretlint` runs on every commit.
- Open a pull request with the summary block from the checklist filled in.
- Maintainers squash-merge. Code-owner approval and a green `validate` check are required.

## Style

Biome formats and lints everything. Two spaces, single quotes, semicolons, trailing commas, 100 columns, LF line endings. Conventional commit subjects.

## Reporting security issues

See `SECURITY.md`. Please do not file security problems as public issues.
