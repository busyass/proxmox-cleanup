import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The shim in bin/ is what every installed copy actually runs, and it was
 * never covered: it loaded the CLI with `require`, which made `require.main`
 * the shim, so the CLI's direct-execution guard never fired and every command
 * exited 0 having done nothing.
 *
 * These drive the real shim as a subprocess, because the defect only exists in
 * that path — importing the module in-process cannot see it.
 */
describe('bin/proxmox-cleanup entry point', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const shim = path.join(repoRoot, 'bin', 'proxmox-cleanup');
  const built = path.join(repoRoot, 'dist', 'cli', 'index.js');

  const run = (...args: string[]): { stdout: string; status: number } => {
    try {
      const stdout = execFileSync(process.execPath, [shim, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return { stdout, status: 0 };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; status?: number };
      return { stdout: (e.stdout || '') + (e.stderr || ''), status: e.status ?? 1 };
    }
  };

  // Skipped rather than failed when dist/ is absent: `npm test` is run before
  // `npm run build` in some workflows, and a missing build is not this test's
  // subject.
  const itBuilt = fs.existsSync(built) ? it : it.skip;

  itBuilt('actually runs the CLI rather than exiting silently', () => {
    const { stdout, status } = run('--version');

    expect(status).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  itBuilt('reports the same version as package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

    expect(run('--version').stdout.trim()).toBe(pkg.version);
  });

  itBuilt('dispatches a subcommand and surfaces its exit code', () => {
    // A pattern that cannot match must stop the run. Proves the shim reaches
    // real command logic, not just commander's version flag.
    const { stdout, status } = run('list', '-p', 'tags:env');

    expect(status).toBe(1);
    expect(stdout).toContain('did you mean "tag:"');
  });

  itBuilt('prints help rather than nothing when given no arguments', () => {
    const { stdout } = run();

    expect(stdout).toContain('cleanup');
    expect(stdout).toContain('dry-run');
  });
});
