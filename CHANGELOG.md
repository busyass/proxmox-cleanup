# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-08-01

Two ways cleanup could delete something it shouldn't are fixed, along with
several places where the output said something other than what happened. If you
drive this from the systemd unit the installer sets up, the first two fixes
matter to you.

Major version because some of these fixes change what a given command does.
Nothing needs re-configuring, but read the breaking changes below if you parse
`--json` output or drive the CLI from a script.

### ⚠️ Breaking Changes

- **Paused and restarting containers are no longer removed.** Previously they were treated as dormant and force-removed. If you were relying on `cleanup` clearing paused containers, you now need to stop them first. This is the fix described below, listed here because it changes what a cleanup deletes.
- **`--json` reports the real container state.** Container `status` in the JSON output was always one of `running`, `stopped`, or `exited`; a paused, created, restarting, removing, or dead container all reported `stopped`. Each now reports its actual Docker state, so `status` can be any of `created`, `running`, `paused`, `restarting`, `exited`, `removing`, `dead`, or `unknown`. Scripts comparing against `"stopped"` need updating.
- **The summary file no longer has a `Success Rate:` line.** It counted protected and in-use resources as failures. Replaced by `Failed to remove: N of M attempted`, or `No failures.` if nothing failed. Anything grepping for the old line needs updating.
- **A `--config` path that doesn't exist is now an error.** It used to fall back to built-in defaults, which meant a typo ran a cleanup with none of your protection patterns. It now exits with the path it couldn't find.
- **`--types all` now overrides a narrower config.** If your config file set `resourceTypes` and you passed `--types all`, the narrow set was kept. Passing `all` explicitly now means all types, as documented. Omitting `-t` still uses whatever your config says.
- **For anyone importing this package as a library:** `ContainerResource.status` no longer includes `'stopped'`, `ContainerResource` has a required `networks` field, `listUnused()` returns `{ resources, skippedUnknownAge }` instead of an array, and `CleanupErrorDetail` has a required `type`. The CLI is unaffected.

### Security

- **Updated `axios` to 1.19.x** — clears ten advisories in the HTTP client used for the Proxmox connection, the most serious a high-severity denial of service. A transitive `protobufjs` advisory that came in through `dockerode` is cleared too. `npm audit` reports 0 vulnerabilities. Nothing about how the tool talks to Proxmox or Docker changes.

### Bug Fixes

- **Fixed protection patterns that silently matched nothing** — several ways of protecting a resource looked right and did nothing, so a resource you had explicitly asked to keep was removed. `-p id:ec3f0931a6e6` (the short ID `docker images` prints) only worked if you supplied the full `sha256:…` digest instead. `-p tag:env=production` never matched, because only label keys were being read and the values discarded. Patterns in `config.json` were never trimmed, so `" keep-* "` with a stray space matched nothing while the same pattern passed on the command line worked. Short IDs and `key=value` labels both work now, IDs accept any prefix of 12 characters or more, and patterns are trimmed wherever they come from. If you have been relying on any of these, check your patterns: they may not have been doing what you expected.
- **A protection pattern that cannot match is now an error, not a silent no-op** — a misspelled prefix (`tags:`, `label:`, `ID:`), an ID prefix too short to be unambiguous, or a prefix with nothing after it used to be treated as a literal name, so it matched nothing and said nothing. Any of these now stops the command and names the offending pattern, because running with a protection list that does nothing is how you lose something you meant to keep. A name pattern still can't protect an untagged image, which is a property of dangling images rather than a bug; the README explains what to use instead.
- **Fixed the globally installed command doing nothing** — after `npm install -g`, every command exited immediately and silently: `--version` printed nothing, `list` and `dry-run` returned without output. The launcher loaded the CLI as a module, so the CLI never recognised that it was the program being run and never started. This affected every release that shipped the launcher, not just this one; running `node dist/cli/index.js` directly always worked, which is how it went unnoticed.
- **Fixed a dry-run logging resources as removed** — the log recorded `Removed network: my-net` during a preview that deleted nothing, both on screen and in the saved report and summary files. It now reads `Would remove` for a dry-run. The report heading was already correct; this was the same wording problem one layer down.
- **Fixed `validate-config` repeating itself on failure** — errors read `Config validation failed: Configuration validation failed: …`. Now stated once, and the underlying reason is no longer replaced by a generic wrapper.
- **Fixed backups overwriting each other when two runs overlap** — the filename carried a timestamp only, and two backups written in the same millisecond resolved to the same path, so the second silently replaced the first and the record of what the earlier run deleted was lost. Filenames now carry a sequence number as well.
- **Fixed paused containers being killed and removed** — a container you'd paused, or one restarting under `restart: always`, was treated as a dormant leftover and force-removed. Docker would normally refuse to delete a live container, but the tool overrode that. Only containers that have exited, were created and never started, or are dead are removed now, and anything still live is reported as skipped with the reason.
- **Fixed `backupPath` and `logPath` in your config file being ignored** — running `cleanup` without `--backup-path` / `--log-path` silently used `./backups` and `./logs` regardless of what your config said. Under the systemd unit, which runs from `/`, that meant backups and logs were written to `/backups` and `/logs` instead of the directories the installer configured. Both settings are respected now, and the flags still override them when you pass one.
- **Fixed networks in active use being listed as unused** — Docker stopped reporting which containers are attached to a network in a 2018 API change, so every network except `bridge`, `host`, and `none` looked idle. `list` and `dry-run` offered live networks up for deletion, and `cleanup` reported a failure for each one it tried, which also made the systemd unit exit non-zero on every timer tick. Attachment is now read from the containers themselves.
- **Fixed `cleanup --dry-run` reporting a completed cleanup** — the preview printed "CLEANUP REPORT", counted resources as removed, and finished with "Cleanup completed successfully!" despite deleting nothing. It now reads as a dry-run, including the reminder that nothing was removed. The separate `dry-run` command was always correct.
- **Fixed `list --older-than` hiding what it skipped** — resources Docker reports no creation time for (most volumes) were dropped from the listing with no mention, so a filtered `list` could look like there was nothing to reclaim. `cleanup` and `dry-run` already showed this count; `list` now shows it too, in text and JSON output.
- **Fixed a mistyped `--config` path falling back to defaults** — pointing `-c` at a file that doesn't exist ran with no protection patterns at all rather than stopping. It now fails with the path it couldn't find.
- **Fixed `--types all` not widening a narrowed config** — if your config file limited `resourceTypes`, passing `--types all` inherited that limit instead of overriding it.
- **Fixed the Proxmox host being missing from every backup** — the host was read from a `PROXMOX_HOST` environment variable that nothing documents, so backups recorded `unknown`. It comes from your config now, with the environment variable still honoured as a fallback.

### Improvements

- **Report and backup files no longer pile up forever** — each `cleanup` or `dry-run` writes a report and a summary, and each cleanup with backups enabled writes a manifest, none of which the installer's log rotation covered. The 30 most recent of each are kept now, configurable via `keepReports` and `keepBackups`, counted separately for cleanups and dry-runs so previews can't push out the record of a real cleanup. On a daily timer that was over 700 files a year in a tool meant to reclaim disk.
- **Untagged images are identifiable in the output** — every dangling image displayed as `<none>:<none>`, which made a list of them impossible to review. Each row now carries a short ID, the same one `docker images` shows.
- **Volume and network sizes read "size unknown" instead of "0 B"** — Docker doesn't report either, and showing `0 B` suggested a volume was empty when it might hold gigabytes.
- **Failures are counted instead of scored** — the summary ended with a success rate that treated protected and in-use resources as failures, so a clean run on a well-protected host could report 50%. It now states the number of resources that actually failed to remove, or "No failures."
- **Removal errors say what went wrong** — a network in use reported the daemon's own wording, "unexpected", and the summary labelled every failure `unknown`. Both now read as "still in use".
- **Cleanup no longer exits early on large JSON output** — `--json` combined with a non-zero exit could truncate the document mid-way on a pipe.

### Under the hood

- Container states are mapped from Docker's full set rather than collapsed into three, and the removable set is now an explicit list, so a state this version doesn't recognise is left alone instead of being treated as safe to delete.
- The pre-cleanup safety check re-reads the current container list rather than the values captured during the scan, so it can catch a container that started mid-run.
- The Docker Engine behaviour this tool depends on is documented in the repo, with the API version each detail was verified against.
- Test suite is at 197 tests, up from 122. The new ones cover each container state, the config-versus-flag precedence, network attachment, file retention, protection-pattern forms, the error classifications, and the launcher itself, none of which had coverage before.
- `npm run smoke` packs the tarball, installs it into a throwaway project, and drives the installed binary. Unit tests import source, so nothing previously exercised what an installed copy actually runs.
- Verified on a live Proxmox host, including a real cleanup: paused containers were left alone, an in-use network was protected, and backups and reports landed in the configured directories rather than at the filesystem root.

## [1.4.0] - 2026-07-06

### Added

- **`--json` machine-readable output** — all four commands (`cleanup`, `dry-run`, `list`, `validate-config`) can now emit JSON instead of human-readable text. Pass `--json` to get structured data on stdout with no decorative output, so scripts can parse the results. The `cleanup` and `dry-run` commands emit the full Report object; `list` emits `{resources, summary: {count, totalSize, byType}}`; `validate-config` emits `{valid, checks}`.
- **`--older-than` creation-age filter** — only remove resources that were created before now minus a specified duration (e.g. `7d`, `12h`, `30m`). Accepted units: `s` (seconds), `m` (minutes), `h` (hours), `d` (days), `w` (weeks). The filter can also be set via `minAge` in the config file. Age is how long ago the resource was *created*, not last-used.

### Changed

- **Unknown creation times are now represented explicitly** — Docker volumes and other resources whose creation time the Engine doesn't report were previously filtered with no visibility. Now they're skipped by `--older-than` and surfaced in the report as a separate count (`skippedUnknownAge`), so you can see what's been left untouched and why.

## [1.3.0] - 2026-06-15

No change to how cleanup, dry-run, or backups behave. A security update, two options removed that never did anything, and some tidying behind the scenes.

### Security

- **Updated `dockerode` to 5.x** — clears three advisories that came in through its dependencies, including a high-severity gRPC crash. `npm audit` is back to 0 vulnerabilities. The Docker API this tool uses is unchanged, so nothing about how it talks to your daemon differs.

### Removed

- **Dropped the `--sort-by-size` flag on `list`** — it defaulted to on with no way to turn it off, so it never did anything you could observe. `list` still sorts largest-first, exactly as before.
- **Dropped the `nodeId` config field and `--proxmox-node` flag** — nothing in the tool ever read them, so setting a node had no effect. You can remove `nodeId` from your `config.json`; if you leave it, it's ignored. If a future release adds node-specific operations, the setting comes back wired to a real feature.

### Under the hood

- **Less duplicated code, same behaviour** — error handling, the `list` and `cleanup` scan paths, and disk-size formatting now run through shared code instead of separate copies, so `list` always reflects exactly what a cleanup would act on. Around 350 fewer lines overall, with the full test suite still green.

## [1.2.1] - 2026-05-12

### Bug Fixes

- **Fixed `npm install -g` producing a CLI that won't start** — the packaged tarball was missing its compiled output, so running `proxmox-cleanup` after a global install failed with "Cannot find module". The build now runs automatically when the package is built.
- **Fixed reports claiming 0 B freed after a successful cleanup** — the tool compared two identical disk snapshots to measure freed space, so the total was always zero. The report now sums the actual sizes of the resources it removed.
- **Fixed every container size showing as 0 B** — the tool asked Docker for the container list without requesting sizes, so size was missing for every row. Sizes now come back populated, and `list` / `cleanup` output reflects real values.
- **Fixed dry-run results changing between back-to-back runs** — running two previews on the same process kept stale scan state from the first run. Each run now starts fresh.
- **Fixed cleanup issuing far more Docker calls than needed** — the safety check for "is this still in use?" ran once per resource on both the orchestrator and the scanner, fanning out to hundreds of calls on larger hosts. Runs now make one pass per cleanup cycle.
- **Fixed bind-mount paths being counted as Docker volumes** — host paths mounted into containers were mixed up with named volume identifiers in the scanner. Only named volumes are tracked now.
- **Fixed Proxmox auth failing when the password contained `!`** — the tool guessed a legacy password was an API token because of one `!` and sent it down the wrong code path. Auth now checks for the full `user@realm!tokenid:secret` shape before treating input as an API token.
- **Fixed `--backup` flag always overriding `backupEnabled: false` in config** — running the CLI without specifying `--backup` / `--no-backup` silently re-enabled backups even when the config file disabled them. The flag only takes effect now when you actually pass it.

### Improvements

- **Removed unused scheduling and notification code** — earlier releases shipped a built-in scheduler and webhook notifier that were never wired into the CLI, plus `scheduling` / `notifications` blocks in `config.example.json` that did nothing. They've been dropped. For scheduled runs, drive `proxmox-cleanup cleanup` from a systemd timer or cron — the installer registers the systemd unit for you.
- **Clearer error when the build is missing** — if `proxmox-cleanup` can't find its compiled entry point, it now tells you to run `npm run build` or reinstall, instead of printing a bare `MODULE_NOT_FOUND` stack.
- **Smaller package tarball** — dropped from about 1.4 MB to 40 kB by including only `dist/`, `bin/`, and the docs. (This project isn't on the npm registry; install with the script or from source.)

### Under the hood

- `node-cron` and `@types/node-cron` dropped from dependencies; `axios`, `follow-redirects`, `protobufjs` moved off vulnerable versions; ESLint bumped to 9 and `@typescript-eslint` to 8 (`npm audit` now reports 0 vulnerabilities).

## [1.2.0] - 2026-04-03

**Codebase audit & cleanup — same features, ~285 fewer lines of code.**

### Improvements

- **Smaller, cleaner codebase** — a full architecture audit identified and removed unused internal code across 18 files. Nothing you interact with has changed, but there's significantly less code to maintain behind the scenes.
- **Consistent disk space formatting** — size numbers (like "1.2 GB freed") now come from one shared function instead of three separate copies, so you'll never see inconsistent formatting between the CLI, scheduler, and reports.
- **`--version` now stays in sync** — the version shown by `proxmox-cleanup --version` is read directly from the package, so it always matches the installed version. Previously it was stuck on `1.0.0`.

### Bug Fixes

- **Fixed `--version` showing wrong number** — `proxmox-cleanup --version` was hardcoded to `1.0.0` regardless of the actual installed version. It now correctly reports the real version.
- **Fixed a duplicate log entry** — the cleanup log was writing a "starting operation" line twice at the beginning of each run. Now it logs once, with the correct resource count.

## [1.1.1] - 2026-03-15

### Improvements

- **Cleaner repository** — removed leftover files and unnecessary dependencies that were cluttering the project.

### Bug Fixes

- **Fixed broken `prepare-release` script** — the npm script was pointing to a file that didn't exist.

## [1.1.0] - 2026-01-11

### Bug Fixes

- **Fixed "Cannot find module" error after global install** — if you installed with `npm install -g`, the CLI would crash on startup because it couldn't find its own files. The path resolution is now reliable regardless of how npm sets up symlinks.
- **Fixed wrong repository URL in install script** — the one-line installer was pointing to the wrong GitHub repo, so `curl | bash` would fail. It now uses the correct URL.
- **Fixed install failures leaving a mess** — if something went wrong during installation, leftover files and partial configs could cause problems on retry. The installer now cleans up after itself on failure.

### Improvements

- **Smoother updates** — the update script now handles git conflicts automatically and shows you which version you're moving from/to.
- **Safer config handling** — configuration file updates use proper JSON parsing instead of string manipulation, so your settings won't get corrupted during upgrades.
- **Test failures don't block install** — if tests fail during installation (e.g. no Docker daemon on the build machine), you'll see a warning instead of a hard stop.

## [1.0.0] - 2026-01-02

**Initial release.**

- **Automated Docker cleanup** — finds and removes unused containers, images, volumes, and networks in one command.
- **Dry-run mode** — preview everything that would be removed before you commit. Run it as many times as you like — results are identical each time.
- **Backup before cleanup** — resource metadata (names, IDs, sizes, what depends on what) is saved to a JSON file before anything gets deleted.
- **Protection patterns** — keep important resources safe with wildcards (`production-*`), exact names, tags, or IDs.
- **Dependency checking** — images used by containers, volumes mounted by containers, and networks with active connections are never touched.
- **CLI with multiple commands** — `cleanup`, `dry-run`, `list`, and `validate-config`, all with flexible options.
- **Configuration file** — set your preferences once in `config.json`, override anything with CLI flags.
- **Scheduled cleanup** — set a cron expression and let it run automatically. (Removed in v1.2.1: this was never wired into the CLI. Use a systemd timer or cron instead.)
- **Webhook notifications** — get notified when cleanup succeeds or fails. (Removed in v1.2.1: this was never wired into the CLI.)
- **One-line install** — `curl | bash` handles Node.js dependencies, build, global CLI setup, systemd service, config files, and log rotation.
- **Property-based testing** — fast-check covers resource identification, safe removal, backup integrity, and report consistency, alongside unit tests for every component.

[2.0.0]: https://github.com/hiall-fyi/proxmox-cleanup/releases/tag/v2.0.0
[1.4.0]: https://github.com/hiall-fyi/proxmox-cleanup/releases/tag/v1.4.0
[1.3.0]: https://github.com/hiall-fyi/proxmox-cleanup/releases/tag/v1.3.0
[1.2.1]: https://github.com/hiall-fyi/proxmox-cleanup/releases/tag/v1.2.1
[1.2.0]: https://github.com/hiall-fyi/proxmox-cleanup/releases/tag/v1.2.0
[1.1.1]: https://github.com/hiall-fyi/proxmox-cleanup/releases/tag/v1.1.1
[1.1.0]: https://github.com/hiall-fyi/proxmox-cleanup/releases/tag/v1.1.0
[1.0.0]: https://github.com/hiall-fyi/proxmox-cleanup/releases/tag/v1.0.0
