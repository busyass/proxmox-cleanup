#!/usr/bin/env node
/**
 * Pack the tarball, install it into a throwaway project, and run the installed
 * binary. This is the only check that exercises what a user actually gets:
 * `npm test` imports source, so a broken bin shim or a missing dist/ in the
 * packed files passes every unit test and fails on first use.
 *
 * Run before publishing or tagging a release.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const expected = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const work = mkdtempSync(join(tmpdir(), 'pcx-smoke-'));
let failed = false;

try {
  const packed = run('npm', ['pack', '--pack-destination', work], repoRoot).trim().split('\n').pop();
  console.log(`packed ${packed}`);

  run('npm', ['init', '-y'], work);
  run('npm', ['install', join(work, packed)], work);

  const bin = join(work, 'node_modules', '.bin', 'proxmox-cleanup');
  const version = run(bin, ['--version'], work).trim();

  if (version !== expected) {
    console.error(`FAIL: installed binary reported "${version}", expected "${expected}"`);
    failed = true;
  } else {
    console.log(`ok: installed binary reports ${version}`);
  }

  // A subcommand, so this covers dispatch and not just the version flag.
  const help = run(bin, ['--help'], work);
  for (const command of ['cleanup', 'dry-run', 'list', 'validate-config']) {
    if (!help.includes(command)) {
      console.error(`FAIL: "${command}" missing from --help output`);
      failed = true;
    }
  }
  if (!failed) console.log('ok: all four commands reachable');
} catch (error) {
  console.error('FAIL: packaged install did not run');
  console.error(error.stderr || error.message);
  failed = true;
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
