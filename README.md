# Proxmox Cleanup — Automated Docker Resource Cleanup for Proxmox VE

<div align="center">

<!-- Platform Badges -->
![Proxmox](https://img.shields.io/badge/Proxmox-VE%208.x+-E57000?style=for-the-badge&logo=proxmox&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue?style=for-the-badge&logo=typescript&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white) ![Docker](https://img.shields.io/badge/Docker-24.x+-2496ED?style=for-the-badge&logo=docker&logoColor=white)

<!-- Status Badges -->
![Version](https://img.shields.io/badge/Version-3.0.0-purple?style=for-the-badge) ![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge) ![Maintained](https://img.shields.io/badge/Maintained-Yes-green.svg?style=for-the-badge)

<!-- Community Badges -->
![GitHub stars](https://img.shields.io/github/stars/hiall-fyi/proxmox-cleanup?style=for-the-badge&logo=github) ![GitHub forks](https://img.shields.io/github/forks/hiall-fyi/proxmox-cleanup?style=for-the-badge&logo=github) ![GitHub issues](https://img.shields.io/github/issues/hiall-fyi/proxmox-cleanup?style=for-the-badge&logo=github) ![GitHub last commit](https://img.shields.io/github/last-commit/hiall-fyi/proxmox-cleanup?style=for-the-badge&logo=github)

<!-- Support -->
[![Buy Me A Coffee](https://img.shields.io/badge/Support-Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/hiallfyi)

**🧹 One command to find and remove unused Docker containers, images, volumes, and networks on your Proxmox host.**

**Dry-run first, backup automatically, protect what matters. Install once, schedule with cron, and forget about it.**

[Quick Start](#quick-start) • [Features](#features) • [Configuration](#configuration) • [CLI Reference](#cli-commands-reference) • [Troubleshooting](#troubleshooting)

</div>

---

## Why Proxmox Cleanup?

Running Docker on a Proxmox host tends to leave behind unused containers, images, volumes, and networks — quietly eating disk space. Proxmox Cleanup finds and removes them, with a few safety nets: a metadata manifest written before anything is deleted, a dry-run you can preview first, protection patterns for the things you want to keep, and dependency checks so nothing in use gets touched.

---

## Quick Start

**Prerequisites:** Node.js 18+, npm, Docker daemon running, Proxmox VE (optional — only used for the connectivity check in `validate-config`).

### 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/hiall-fyi/proxmox-cleanup/main/scripts/install.sh | bash
```

The installer handles Node.js dependencies, build, global CLI setup, systemd service, config files, and log rotation.

![Installation Success](docs/images/installation-success.png)
*Successful installation with all components configured*

<details>
<summary>Install from Source</summary>

```bash
git clone https://github.com/hiall-fyi/proxmox-cleanup.git
cd proxmox-cleanup
npm install
npm run build
npm install -g .          # optional: puts `proxmox-cleanup` on your PATH
```

Without the last line, run it as `node dist/cli/index.js` from the clone.
</details>

### 2. Configure

```bash
nano /etc/proxmox-cleanup/config.json
```

### 3. Test (Dry Run)

```bash
proxmox-cleanup dry-run -c /etc/proxmox-cleanup/config.json
```

### 4. Clean Up

```bash
proxmox-cleanup cleanup -c /etc/proxmox-cleanup/config.json
```

### 5. Verify

![Cleanup Results Demo](docs/images/cleanup-results-demo.png)
*Real-world results: 38 resources scanned, 1.02 GB freed in 2.3 seconds*

---

## Features

- **Automated Docker cleanup** — remove unused containers, images, volumes, and networks in one command
- **Safety first** — backup before cleanup, dry-run mode, protected resource patterns, dependency checking
- **Well tested** — property-based tests with `fast-check`, structured logging, explicit error reporting
- **Proxmox VE friendly** — tested on Proxmox VE 8.x+ running Docker on the host
- **Scheduled runs via systemd or cron** — the installer registers a systemd unit you can drive from a timer or system cron
- **Readable reports** — disk space freed, execution time, what was kept or skipped and why
- **CLI with the common commands you'd expect** — `cleanup`, `dry-run`, `list`, `validate-config`, plus the usual flags

### Resource Types

| Type | What Gets Cleaned |
|------|-------------------|
| containers | Containers that have exited, were created but never started, or are dead |
| images | Images not used by any container |
| volumes | Volumes not mounted by any container |
| networks | Networks with no attached containers (excluding defaults) |

Containers that are running, **paused**, restarting, or mid-removal are never
touched. A paused container is a live workload, so it's left alone and reported
as skipped with the reason.

### Safety Features

- **Dependency Checking** — Containers using images, volumes mounted by containers, and networks with attached containers are all protected
- **Protected Resources** — System networks (bridge, host, none), resources matching protection patterns, tagged resources
- **Backup Manifest** — Before deleting anything, resource metadata (names, IDs, sizes, dependencies) is written to a JSON file. It's a record for manual recovery, not a restore point: metadata can't bring back a volume's contents or an image's layers. A `restore` command that re-pulls images by name is planned.
- **Dry-Run Mode** — Preview all operations without making changes. The report and the log both say "would remove", so a preview can't be mistaken for a completed cleanup

---

## Configuration

Create a `config.json` file (see `config.example.json`):

```json
{
  "proxmox": {
    "host": "proxmox.example.com",
    "token": "root@pam:your-api-token",
    "verifyTls": false
  },
  "cleanup": {
    "dryRun": false,
    "resourceTypes": [],
    "protectedPatterns": ["important-*", "system-*"],
    "backupEnabled": true,
    "backupPath": "./backups",
    "minAge": "7d",
    "keepBackups": 30
  },
  "reporting": {
    "verbose": true,
    "logPath": "./logs",
    "keepReports": 30
  }
}
```

Every setting here can be overridden by a CLI flag, and a flag only takes
effect when you actually pass it — omit it and your config file wins. `-p`/
`--protect` is the one exception: it adds to the config file's
`protectedPatterns` rather than replacing them, covered under Protection
Patterns below.

**File retention:** each run writes a report and a summary to the log directory,
and each cleanup writes a backup manifest. `keepReports` and `keepBackups`
(default 30 each) bound how many of these are kept — the oldest are deleted once
the limit is passed. The log files themselves rotate separately.

**Age filtering:** the optional `minAge` setting (or `--older-than` CLI flag) accepts a duration like `7d` (7 days), `12h` (12 hours), `30m` (30 minutes). Only resources older than this are removed — age is how long ago the resource was *created*, not last-used. Accepted units: `s` (seconds), `m` (minutes), `h` (hours), `d` (days), `w` (weeks).

**Volumes and creation time:** Docker volumes often report no creation time. When a resource's creation time is unavailable, `--older-than` skips it entirely, and `cleanup`, `dry-run`, and `list` all show a separate count of these skipped resources. This keeps the tool safe by default — if the Engine can't tell you when a volume was created, the age filter won't guess.

**Volume and network sizes:** the Docker Engine doesn't report either, so they show as "size unknown" rather than `0 B`. A volume listed for cleanup may still hold a lot of data, and a completed cleanup's "Disk Space Freed" total is a lower bound whenever one was removed — the report says so when it applies.

### Scheduling

The installer registers `proxmox-cleanup.service` as a systemd unit. Drive it from a systemd timer or regular cron:

```ini
# /etc/systemd/system/proxmox-cleanup.timer
[Unit]
Description=Run Proxmox Cleanup daily

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now proxmox-cleanup.timer
```

| Pattern | Schedule |
|---------|----------|
| `0 2 * * *` | Daily at 2 AM |
| `0 */6 * * *` | Every 6 hours |
| `0 0 * * 0` | Weekly on Sunday |
| `0 0 1 * *` | Monthly on 1st |

### Protection Patterns

`-p`/`--protect` on the command line adds to whatever your config file already
protects — it doesn't replace it. A config guarding `production-*` stays
protected even if you also pass `-p "test-*"` for a one-off run.

Protect resources from cleanup using patterns:

- **Wildcards**: `important-*`, `*-production`, `*-system-*` (matched against the name)
- **Exact names**: `my-important-container`
- **Labels**: `tag:backup` matches any resource carrying that label; `tag:env=production` matches the key and value
- **IDs**: `id:ec3f0931a6e6` (the short ID `docker images` and `docker ps` print), or the full `sha256:…` digest. Prefixes shorter than 12 characters are rejected as ambiguous.

**Untagged ("dangling") images:** these have no meaningful name, so a name pattern
like `important-*` will never match one. To keep a specific dangling image, protect
it by ID, by a label, or by a wildcard on its short ID (`*ec3f0931a6e6*`) — the
short ID appears in how the tool displays it.

Prefixes are lower-case and exact (`tag:`, `id:`). If a pattern can't possibly
match anything — a misspelled prefix like `tags:`, an ID prefix too short to be
unambiguous, or a prefix with nothing after it — the command stops and tells you
which pattern is wrong instead of running with a protection list that does
nothing.

### Proxmox Credentials

The `token` field accepts either form Proxmox issues: a legacy
`user@realm:password`, or the newer, recommended API token,
`user@realm!tokenid:secret`.

However you authenticate, avoid putting it on the command line: `--proxmox-token`
works, but it leaves the token in your shell history and visible to anyone else
on the box via `ps`. Set a `PROXMOX_TOKEN` environment variable instead, or keep
it in `config.json` — either beats a bare CLI flag, and an explicit
`--proxmox-token` or a `token` in `config.json` still wins over the environment
variable.

By default the tool accepts Proxmox's certificate without verifying it, since
Proxmox ships a self-signed one out of the box. If you've replaced it with a
certificate from a real CA, set `"verifyTls": true` under `proxmox` in
`config.json` to have it checked.

---

## CLI Commands Reference

### `cleanup`

Execute cleanup of unused Docker resources.

```bash
proxmox-cleanup cleanup [options]

Options:
  -d, --dry-run                    Preview without removing
  -t, --types <types>              Resource types, or all (containers,images,volumes,networks,all)
  -p, --protect <patterns>         Protection patterns (wildcards supported)
  -b, --backup                     Create backup (default: true)
  --no-backup                      Disable backup
  --backup-path <path>             Custom backup directory (default: ./backups)
  -c, --config <path>              Configuration file path
  -v, --verbose                    Enable verbose logging
  --log-path <path>                Custom log directory path (default: ./logs)
  --proxmox-host <host>            Proxmox host address
  --proxmox-token <token>          Proxmox API token
  --older-than <duration>          Only remove resources older than this (e.g. 7d, 12h)
  --json                           Output JSON only (suppresses human-readable output)
```

### `dry-run`

Preview what would be removed without making changes.

```bash
proxmox-cleanup dry-run [options]

Options:
  -t, --types <types>              Resource types to scan, or all (containers,images,volumes,networks,all)
  -p, --protect <patterns>         Protection patterns (wildcards supported)
  -c, --config <path>              Path to configuration file
  -v, --verbose                    Enable verbose logging
  --log-path <path>                Custom log directory path (default: ./logs)
  --proxmox-host <host>            Proxmox host address
  --proxmox-token <token>          Proxmox API token
  --older-than <duration>          Only remove resources older than this (e.g. 7d, 12h)
  --json                           Output JSON only (suppresses human-readable output)
```

### `list`

List unused Docker resources without removing them. Results are grouped by type and sorted largest-first.

```bash
proxmox-cleanup list [options]

Options:
  -t, --types <types>              Resource types to list, or all (containers,images,volumes,networks,all)
  -p, --protect <patterns>         Protection patterns (wildcards supported)
  -c, --config <path>              Path to configuration file
  --older-than <duration>          Only list resources older than this (e.g. 7d, 12h)
  --json                           Output JSON only (suppresses human-readable output)
```

### `validate-config`

Validate configuration file and test connections.

```bash
proxmox-cleanup validate-config -c /etc/proxmox-cleanup/config.json

Options:
  -c, --config <path>              Path to configuration file
  --json                           Output JSON only (suppresses human-readable output)
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Everything the tool set out to do succeeded. Resources that were skipped (protected, still in use, or undatable) are a success, not a failure. |
| 1 | The run couldn't proceed (Docker unreachable, bad config, invalid `--older-than`), or at least one resource failed to remove. Failures are itemised in the report. |

If you pass `-c` with a path that doesn't exist, the command fails rather than
falling back to defaults — otherwise a typo would run a cleanup with none of
your protection patterns.

---

## Usage Examples

```bash
# Preview what would be removed
proxmox-cleanup dry-run

# Preview specific resource types
proxmox-cleanup dry-run --types containers,images

# Clean all unused resources with backup
proxmox-cleanup cleanup

# Clean specific types without backup
proxmox-cleanup cleanup --types volumes --no-backup

# List all unused resources (sorted largest-first)
proxmox-cleanup list

# Only clean resources created more than 7 days ago
proxmox-cleanup cleanup --older-than 7d

# Machine-readable JSON output for scripting
proxmox-cleanup list --json > unused-resources.json

# Verbose mode for troubleshooting
proxmox-cleanup cleanup --verbose -c /etc/proxmox-cleanup/config.json
```

---

## Architecture

```text
proxmox-cleanup/
├── src/
│   ├── types/           # TypeScript type definitions
│   ├── interfaces/      # Interface contracts
│   ├── clients/         # Docker & Proxmox API clients
│   ├── scanners/        # Resource scanning logic
│   ├── utils/           # Utility functions
│   ├── managers/        # Backup management
│   ├── reporters/       # Report generation
│   ├── orchestrators/   # Main workflow coordination
│   └── cli/             # Command-line interface
├── config.example.json  # Example configuration
└── README.md
```

### Testing

208 tests. Property-based testing with `fast-check` (100+ random inputs per property) covering resource identification, safe removal guarantees, backup completeness, size calculation accuracy, and report consistency, alongside unit tests for the clients, scanner, orchestrator, reporter, and backup manager. All seven Docker container states are covered, and a state the tool doesn't recognise is treated as not removable.

```bash
npm test              # Run the full suite
npm run test:coverage # Run with coverage
npm run build         # Build
npm run lint          # Linting
npm run smoke         # Verify the packaged tarball actually installs and runs
```

---

## Troubleshooting

<details>
<summary>Docker daemon not running</summary>

```bash
systemctl status docker
systemctl start docker
```
</details>

<details>
<summary>Permission denied errors</summary>

```bash
sudo usermod -aG docker $USER
newgrp docker
```
</details>

<details>
<summary>Configuration validation failed</summary>

```bash
proxmox-cleanup validate-config -c /etc/proxmox-cleanup/config.json
tail -f /var/log/proxmox-cleanup/cleanup.log
```
</details>

For other issues, use the `--verbose` flag for detailed logging and check the logs in your configured log directory. Still stuck? [Open an issue](https://github.com/hiall-fyi/proxmox-cleanup/issues/new/choose) — the form asks for the few things that pin most problems down. For usage questions, [Discussions](https://github.com/hiall-fyi/proxmox-cleanup/discussions) is the better place.

If something was removed that you wanted to keep, the report in your log directory lists exactly what went, and the backup manifest in your backup directory records its metadata. Both are worth attaching to the issue.

---

## Resources

- [Docker Documentation](https://docs.docker.com/)
- [Proxmox VE Documentation](https://pve.proxmox.com/wiki/Main_Page)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [fast-check Property Testing](https://github.com/dubzzz/fast-check)

---

## License

**MIT License** — Free to use, modify, and distribute. See [LICENSE](LICENSE) for full details.

**Made with ❤️ by Joe Yiu ([@hiall-fyi](https://github.com/hiall-fyi))**

---

## Contributing

Contributions welcome!

1. Fork the repository
2. Create feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

<details>
<summary>Disclaimer</summary>

This project is not affiliated with, endorsed by, or connected to Proxmox Server Solutions GmbH or Docker, Inc. Proxmox and the Proxmox logo are registered trademarks of Proxmox Server Solutions GmbH. Docker and the Docker logo are registered trademarks of Docker, Inc. All product names, logos, and brands are property of their respective owners.

This tool is provided "as is" without warranty of any kind. Use at your own risk.

</details>

---

See [CHANGELOG.md](CHANGELOG.md) for version history.
