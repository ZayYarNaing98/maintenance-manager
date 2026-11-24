import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = mkdtempSync(join(tmpdir(), 'maintenance-test-'));
try {
  const result = spawnSync('workerd', ['test', '--experimental', '-d', `state=${state}`, 'test/runtime.capnp'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(state, { recursive: true, force: true });
}
