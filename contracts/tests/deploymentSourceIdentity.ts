// SPDX-License-Identifier: Apache-2.0
import { expect } from 'chai';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDeploymentSourceIdentity } from '../scripts/lib/deploymentSourceIdentity';

function runGit(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

describe('deployment source identity', function () {
  it('accepts a clean commit and rejects uncommitted source', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-deploy-source-'));
    try {
      runGit(root, ['init']);
      runGit(root, ['config', 'user.name', 'Cotsel Test']);
      runGit(root, ['config', 'user.email', 'cotsel-test@example.invalid']);
      fs.writeFileSync(path.join(root, 'contract.sol'), 'contract Test {}\n');
      runGit(root, ['add', 'contract.sol']);
      runGit(root, ['commit', '-m', 'test source']);

      expect(getDeploymentSourceIdentity(root)).to.deep.equal({
        commitSha: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
        worktreeClean: true,
      });

      fs.appendFileSync(path.join(root, 'contract.sol'), '// modified\n');
      expect(() => getDeploymentSourceIdentity(root)).to.throw('clean Git worktree');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
