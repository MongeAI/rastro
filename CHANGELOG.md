# Changelog

All notable changes to Rastro. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Fixed

- `--changes`/`--since` (and `rastro impact`/`rastro check` run directly in a GitHub Actions workflow) no longer refuse a repository just because its config has an `include.path` or `includeIf` (the current `actions/checkout` stores credentials that way). The keys of included files are still checked, so an included file that defines a command is still refused.

## [0.2.0]

The map now answers **what matters**: what a change affects, how one part reaches another, where to look first, in English or Portuguese. And your AI coding agent can ask the same questions.

### Added

- **Architecture rules (`rastro check`).** Declare in `rastro.rules.json` who may depend on whom: `deny` (these files must not depend on those files or packages), `allow` (only on these) or `noCycles`, each applied to `from`/`except` file patterns (`*`, `**`, `?`, `{a,b}`, a folder path meaning everything inside it, `pkg:<name>` for packages, `pkg:node:*` for built-ins), with `severity`, `because` and `ignoreTypeImports`. Only proven relationships (resolved imports, calls and inheritance, grouped per pair of files with `file:line`) violate a rule; calls through interfaces that _may_ reach a forbidden file are listed as possible and never fail. `rastro check` prints the rules and their violations (text, Markdown or JSON; exit code 1 on failing violations, 2 on a problem with the rules file); with `--changes`/`--since` only violations whose evidence is on a changed line fail, so existing debt never blocks a pull request. **`rastro check --init` writes the rules the project already follows** (the layering between its main folders, no import cycles, production code not importing tests), every one checked to pass. The same rules appear in `rastro impact` and the pull request comment (the Action fails the job on new violations, `fail-on-violations`, and has a `violations` output), in a new **Rules** tab of the map that draws the violations in red (live with `--watch`), and in the MCP tool `rastro_check`, which also proposes rules when the project has none. Unknown fields are errors (a typo never turns a rule off silently) and a JSON Schema ships with the package for editor autocompletion.
- **`rastro mcp`: Rastro for AI agents.** A Model Context Protocol server over stdio for Claude Code, Cursor, VS Code and any MCP client, with eight read-only tools: `rastro_overview`, `rastro_search`, `rastro_entity` (with the source on request), `rastro_references`, `rastro_impact` (for entities, for the uncommitted changes or `since` a branch), `rastro_check` (the architecture rules), `rastro_path` and `rastro_routes`. Answers are compact Markdown with `file:line` evidence, keep proven, external and possible (unresolved, with candidates) relationships apart, accept ids, names, `Class.method`, paths (also the `.js` specifier of a `.ts` file), `path:line`, `path:line:column` or `path:start-end`, list the candidates of an ambiguous name, suggest close matches for a typo (by path similarity for paths) and say what is not modeled as an entity. Calls to a base method are listed as _possible_ callers of each override, `new` of a class without a constructor reaches the inherited one, `rastro_impact` puts routes and tests first, has `format: "tests"`/`"summary"` and, in git mode, lists the references the change possibly broke; `rastro_path` accepts folders and an external package as destination and marks type-only steps; long lists say "N shown of M" and page with `offset`; large answers shrink every list instead of dropping sections; a partial analysis is flagged in every answer. The project is watched and re-analyzed incrementally before the next answer after an edit, including a call made right after saving (`--no-watch` to turn it off, and then code and git changes of files edited since the analysis come with a warning); the first analysis runs in a worker thread, so the server answers right away. It speaks MCP 2024-11-05 to 2025-11-25 (`initialize`) and the stateless 2026-07-28, has no runtime dependency and was checked against the official TypeScript SDK clients. Without a path it analyzes the project Claude Code is working on (`CLAUDE_PROJECT_DIR`), then the current folder.
- **Rastro in every pull request.** A GitHub Action (`uses: MongeAI/rastro@v0.2.0`) comments on each pull request what it changes, what it possibly broke, what could be affected, the HTTP routes involved and the tests to run (one comment per analyzed path, updated on every push, so a monorepo can run it once per package), writes the job summary and uploads the offline HTML map. Links point to the analyzed commit and to each file's path in the repository. Pull requests from forks still get the job summary.
- **`rastro impact`.** The impact of the git changes in the terminal, as Markdown (with `file:line` links) or JSON, including a **possibly broken by this change** section: references into what changed that no longer resolve (an import of a deleted or renamed file, a name the changed file no longer exports, a method its class no longer has, or a call inside the changed file to a name that no longer exists there), each with `file:line` (also in the JSON, the Action's `broken` output and the Changes tab); `--tests` prints only the affected test files, ready for `xargs -r -d '\n' npx vitest run` (which runs nothing when no test is affected). Names from the analyzed project are escaped so they cannot inject links, images, mentions or HTML into a comment.
- **Git changes and impact.** `--changes` (since the last commit, including untracked files) and `--since <ref>` (since the branch forked from `<ref>`) mark the changed functions, methods and files by their changed lines. The new **Changes** tab lists what changed, who depends on it by distance, the HTTP routes involved and the test files to run, and the map highlights the blast radius. Git only runs read-only commands, never enters submodules and refuses repository config that would run commands (`--trust-git-config` to override). Also available in `rastro export`, so an offline HTML report can carry a pull request's impact.
- **Paths: “how does A reach B?”** Shortest chains of proven calls, imports and inheritance (up to 3 alternatives), each step with its evidence, shown in a map view with only the path.
- **Insights tab.** Most called functions, orchestrators, central files, largest files, most coupled folders and possibly unused code (internal vs. exported), computed only from proven relationships.
- **Live mode** (`--watch`). Re-analysis on save with the compiler kept in memory; the open map updates without losing the selection. Watches only the analyzed folders and falls back to polling (with a warning) when the system refuses more watchers.
- **More routes.** Next.js (App and Pages Router, API routes, static `pageExtensions`), Fastify (`register` with `prefix`), Hono (`app.route`, `basePath`) and NestJS (`@Controller`, method decorators, global prefix), plus Express mount prefixes. The full path is only given when it can be proven.
- **Export and compare.** `rastro export --format mermaid|dot|graphml|json|html` with level, folder and relationship filters; the HTML format is a single offline file with the whole interactive map. `rastro compare a.json b.json` diffs two analyses (`--json` for CI).
- **Navigation.** Command palette (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd>), arrow-key movement between nodes, <kbd>Alt</kbd>+<kbd>↑</kbd> to the parent, a minimap, a breadcrumb and a shortcuts list (<kbd>?</kbd>).
- **Analyzer precision.** `super(...)` calls, inherited methods, union receivers, per-package `tsconfig` `paths` in monorepos, and _possible_ implementations for calls through interfaces or abstract methods (always unresolved, never drawn as proven). The impact of a constructor includes `new` of its class and of subclasses without a constructor of their own.
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

- Tests and routes that depend on code with a possibly broken reference (a file importing a deleted file, for example) are now among the tests to run (`rastro impact --tests`, the Action's `tests` output and `rastro_impact`, where they are marked), even though the broken reference is no longer a proven relationship.
- Editing a hand-written `.d.ts` now triggers re-analysis in live mode and in `rastro mcp`.
- "Possibly broken" is more precise: no false alarm for barrels that `export *` from a module Rastro cannot see (an uninstalled package, a generated file) or for CommonJS modules (`exports.x =`, `__exportStar`, `Object.assign(module.exports, …)`), which mark the file's export list as incomplete (`meta.exportsIncomplete`, `meta.commonjs`); a name that is not declared only counts when the call is on a changed line or the name was removed (`ChangedFile.removedNames`), ambient `.d.ts` files from the `tsconfig` `include` are loaded and a missing `@types` package never makes globals look undeclared. New cases are caught: a moved file whose own relative imports no longer resolve (`importer-moved`), names that disappear through `export *` barrels, and a deleted file imported through a `paths`/`baseUrl` alias (`meta.aliasTargets`).
- Binary, empty and mode-only changes are no longer missing from the git changes (their path comes from the `diff --git` line), and helper files inside test folders (`helpers/`, `fixtures/`, `utils/`, `mocks/`, `setup.ts`…) are no longer listed as tests to run.
- Routes: a router mounted on a receiver that cannot be proven no longer gets a full path, and neither does a Next.js app whose config could bring `basePath` from elsewhere (a spread, an import, a wrapper call). `rastro compare` reports routes whose address changed.
- Analyzer: a file without read permission or with an invalid name becomes a warning instead of aborting the analysis (`unreadable-file`); `export { type X } from` is type-only and no longer creates import cycles; a reassigned `let`/`var` `require` alias is no longer resolved to its first value; calls in member decorators and computed method names belong to the class, not to the method.

- Evidence of calls in multi-line chains (`a.b({…})\n.c()`) now points at the line of the called method, not the start of the chain.
- `module.exports = require('./lib/x')` re-exports are followed; `var app = module.exports = express()` is recognized as an app.
- A framework imported through a relative path (its own examples) is recognized when the target is that package's entry point.
- Unresolved chained calls get short, readable names (`pipeline.step(…).done`) instead of mangled kilobyte-long text.
- `paths` aliases to non-code files (`@/styles/globals.css`) are no longer reported as npm packages.
- Export evidence of decorated classes points at the `export` keyword; handlers declared inside functions no longer become false unresolved nodes.
- `npm ci` works again after the version bump (internal packages pointed at a version that was never published).
- Line numbers after a U+2028/U+2029 inside a string are no longer shifted: lines are counted on `\n` only, like git, editors and the source viewer.
- Live mode keeps seeing edits in a folder that was deleted and recreated (`rm -rf src && mkdir src`).

### Security

- The rules file is plain JSON (no project code runs). The default `rastro.rules.json` must be a regular file (a symbolic link is refused; `--rules` follows one on purpose), a JSON error never quotes the file, and patterns are matched by dynamic programming instead of regular expressions, with brace expansion and pattern length capped, so a rules file in a pull request cannot hang CI or echo another file into a comment. Rule names and reasons reach comments and agents as inline code.
- `rastro mcp` only talks over stdio (no network port), its tools only read, source code is only read from analyzed JS/TS files inside the project (the same checks as the local server: no absolute paths, `..` or symlink escapes), and the git mode of `rastro_impact` keeps every git protection, refusing risky repository config unless the server was started with `--trust-git-config`. Nothing but protocol messages is written to stdout (U+2028/U+2029 escaped), oversized messages are rejected, a client that closes stderr does not take the server down, and project-derived text (names, paths, ids, code) reaches the agent with line breaks and control characters escaped, so a file or package name cannot inject headings or instructions; ids printed that way work as targets.
- `--changes`/`--since` run only read-only git commands with external diff, text conversion, hooks, pager and fsmonitor disabled, fixed diff prefixes, and refuse repositories whose local, worktree or command-line config defines commands (`--trust-git-config` to override).
- Untracked files are only read when they are regular JS/TS files under the size limit (no symlinks, FIFOs or devices).
- Names printed in the terminal have control characters removed; Mermaid labels encode characters that could inject directives.

### Data format

`schemaVersion` stays `0.1.0`: 0.2 only adds optional fields (`changes`, `rules`, `meta.candidates`, `meta.mentions`, `meta.abstractMembers`, `meta.receiverFile`, route `fullPath`/`mountedAt`/`routeKind`/`inlineHandler`, `Diagnostic.params`). Graphs from 0.1 still open.

## [0.1.1]

- English README on GitHub and npm.

## [0.1.0]

- First public release: static analysis of JS/TS projects into an evidence-backed graph and an interactive local map.

[Unreleased]: https://github.com/MongeAI/rastro/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/MongeAI/rastro/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/MongeAI/rastro/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MongeAI/rastro/releases/tag/v0.1.0
