# Changelog

All notable changes to Rastro. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [0.2.0]

The map now answers **what matters**: what a change affects, how one part reaches another, where to look first, in English or Portuguese.

### Added

- **Rastro in every pull request.** A GitHub Action (`uses: MongeAI/rastro@v0.2.0`) comments on each pull request what it changes, what could be affected, the HTTP routes involved and the tests to run (one comment per analyzed path, updated on every push, so a monorepo can run it once per package), writes the job summary and uploads the offline HTML map. Links point to the analyzed commit and to each file's path in the repository. Pull requests from forks still get the job summary.
- **`rastro impact`.** The impact of the git changes in the terminal, as Markdown (with `file:line` links) or JSON; `--tests` prints only the affected test files, ready for `xargs -r -d '\n' npx vitest run` (which runs nothing when no test is affected). Names from the analyzed project are escaped so they cannot inject links, images, mentions or HTML into a comment.
- **Git changes and impact.** `--changes` (since the last commit, including untracked files) and `--since <ref>` (since the branch forked from `<ref>`) mark the changed functions, methods and files by their changed lines. The new **Changes** tab lists what changed, who depends on it by distance, the HTTP routes involved and the test files to run, and the map highlights the blast radius. Git only runs read-only commands, never enters submodules and refuses repository config that would run commands (`--trust-git-config` to override). Also available in `rastro export`, so an offline HTML report can carry a pull request's impact.
- **Paths: “how does A reach B?”** Shortest chains of proven calls, imports and inheritance (up to 3 alternatives), each step with its evidence, shown in a map view with only the path.
- **Insights tab.** Most called functions, orchestrators, central files, largest files, most coupled folders and possibly unused code (internal vs. exported), computed only from proven relationships.
- **Live mode** (`--watch`). Re-analysis on save with the compiler kept in memory; the open map updates without losing the selection. Watches only the analyzed folders and falls back to polling (with a warning) when the system refuses more watchers.
- **More routes.** Next.js (App and Pages Router, API routes, static `pageExtensions`), Fastify (`register` with `prefix`), Hono (`app.route`, `basePath`) and NestJS (`@Controller`, method decorators, global prefix), plus Express mount prefixes. The full path is only given when it can be proven.
- **Export and compare.** `rastro export --format mermaid|dot|graphml|json|html` with level, folder and relationship filters; the HTML format is a single offline file with the whole interactive map. `rastro compare a.json b.json` diffs two analyses (`--json` for CI).
- **Navigation.** Command palette (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd>), arrow-key movement between nodes, <kbd>Alt</kbd>+<kbd>↑</kbd> to the parent, a minimap, a breadcrumb and a shortcuts list (<kbd>?</kbd>).
- **Analyzer precision.** `super(...)` calls, inherited methods, union receivers, per-package `tsconfig` `paths` in monorepos, and _possible_ implementations for calls through interfaces or abstract methods (always unresolved, never drawn as proven).
- **Languages.** Interface and CLI in English and Portuguese (`--lang`, `RASTRO_LANG`, system locale); analyzer diagnostics are translated too (`Diagnostic.params` + `diagnosticText`).
- **Quality.** Interface tests in headless Chrome and benchmarks (100, 1,000 and 5,000 files) in CI.

### Changed

- About 37% faster analysis (one tree pass per file straight on the compiler). On a 5,000-file project: 6.0 s → 3.3 s; re-analysis in `--watch` 2.5 s.
- Large maps stay responsive: the files level of a 5,000-file project opens in about 5 s instead of minutes (dense groups packed in a grid, lighter layout options with a time limit, cheaper style updates, straight lines and an image while panning).
- A relationship from a visible entity to one inside a closed file now goes to that file instead of disappearing.
- The folders level opens a project that lives in a single folder (like `src/`) by itself.
- Options that do not apply to a command are rejected instead of silently ignored (including `--no-open` outside `open`/`serve`), and so are empty values (`--since ""`, `-o ""`) and extra arguments (`rastro impact . main`).
- Clearer CLI errors, all in the chosen language: unknown options and missing values, a folder passed where a graph JSON is expected, a non-git folder or unknown `--since` reference (checked before the analysis starts), a non-regular `-o` target, and `validate`/`compare` problems (`validateGraph` takes `{ lang }`; `graphIssues` and `validationText` give language-independent codes). `impact --link` only accepts `http(s)://` addresses.
- More honest about what can't be proven: a call on a receiver typed as a union (or intersection) of several project classes, and a call to a module whose `module.exports` is assigned in more than one branch (`if (prod) module.exports = require('./a') else …`), are now unresolved with the _possible_ targets listed, instead of resolved edges to every branch.
- A relative import counts as a framework (its own repository and examples) only when the entry point really exports the framework's factory; a `package.json` that merely uses the name no longer turns plain objects into routes.

### Fixed (found by analyzing 8 open-source projects: Express, Fastify, Hono, NestJS, Vite, tRPC, Excalidraw and a Next.js app)

- Evidence of calls in multi-line chains (`a.b({…})\n.c()`) now points at the line of the called method, not the start of the chain.
- `module.exports = require('./lib/x')` re-exports are followed; `var app = module.exports = express()` is recognized as an app.
- A framework imported through a relative path (its own examples) is recognized when the target is that package's entry point.
- Unresolved chained calls get short, readable names (`pipeline.step(…).done`) instead of mangled kilobyte-long text.
- `paths` aliases to non-code files (`@/styles/globals.css`) are no longer reported as npm packages.
- Export evidence of decorated classes points at the `export` keyword; handlers declared inside functions no longer become false unresolved nodes.
- `npm ci` works again after the version bump (internal packages pointed at a version that was never published).

### Security

- `--changes`/`--since` run only read-only git commands with external diff, text conversion, hooks, pager and fsmonitor disabled, fixed diff prefixes, and refuse repositories whose local, worktree or command-line config defines commands (`--trust-git-config` to override).
- Untracked files are only read when they are regular JS/TS files under the size limit (no symlinks, FIFOs or devices).
- Names printed in the terminal have control characters removed; Mermaid labels encode characters that could inject directives.

### Data format

`schemaVersion` stays `0.1.0`: 0.2 only adds optional fields (`changes`, `meta.candidates`, `meta.mentions`, route `fullPath`/`mountedAt`/`routeKind`, `Diagnostic.params`). Graphs from 0.1 still open.

## [0.1.1]

- English README on GitHub and npm.

## [0.1.0]

- First public release: static analysis of JS/TS projects into an evidence-backed graph and an interactive local map.

[0.2.0]: https://github.com/MongeAI/rastro/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/MongeAI/rastro/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MongeAI/rastro/releases/tag/v0.1.0
