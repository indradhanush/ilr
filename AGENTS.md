# Repository Guidelines

## Project Structure & Module Organization

This is a static UK ILR absence tracker. Keep the page shell, styles, and script
order in `index.html`. Put browser UI and interaction code in `src/app.ts`; keep
the sliding-window absence calculations in the pure functions in `src/model.ts`.
Node tests live in `test/model.test.js` and exercise the compiled `dist/model.js`.
`trips.js.example` is safe sample data; `trips.js` is local personal data and is
intentionally ignored. The GitHub Pages workflow is in `.github/workflows/pages.yml`.

## Build, Test, and Development Commands

- `make build` — compile `src/**/*.ts` into `dist/` with TypeScript.
- `make check` — type-check without producing files; run this before committing.
- `make test` — build, then run the Node built-in test suite.
- `make watch` — continuously recompile during UI work.
- `make clean` — remove generated `dist/` output.

Use Node 20 or later. If `tsc` is not installed locally, mirror CI with
`npx --yes -p typescript@5 tsc -p .`.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, semicolons, double-quoted strings,
and the strict compiler options in `tsconfig.json`. Prefer small, typed helper
functions and descriptive camelCase names such as `tripBounds` and `firstArrivalOn`.
Keep model code deterministic and DOM-free; `app.ts` owns DOM access and rendering.
The two source files compile as plain scripts sharing global scope, so do not add
module `import` or `export` statements without revising the build design.

## Testing Guidelines

Add focused `node:test` cases in `test/model.test.js` for every model change.
Name tests as observable behaviour, for example `"same-day trip costs no days"`.
Cover calendar boundaries, inclusive-day rules, and regression cases; use the
existing deterministic fuzz/reference pattern when changing window logic. Run
`make test` before opening a pull request.

## Commit & Pull Request Guidelines

Use concise Conventional Commit-style subjects, as in `feat: persist edits in
localStorage`, `refactor: drop the today override`, and `docs: Add README and
LICENSE`. Keep each commit scoped. PRs should explain the user-visible or
calculation impact, list tests run, link any relevant issue, and include a
screenshot for visual changes. Never commit a real `trips.js` file or personal
travel data.
