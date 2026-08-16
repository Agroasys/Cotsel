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
  it('accepts generated deployment evidence but rejects uncommitted source', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-deploy-source-'));
    try {
      runGit(root, ['init']);
      runGit(root, ['config', 'user.name', 'Cotsel Test']);
      runGit(root, ['config', 'user.email', 'cotsel-test@example.invalid']);
      fs.writeFileSync(path.join(root, 'contract.sol'), 'contract Test {}\n');
      const evidenceDirectory = path.join(root, 'contracts', 'reports', 'deploy', 'base-sepolia');
      fs.mkdirSync(evidenceDirectory, { recursive: true });
      const evidenceFile = path.join(evidenceDirectory, 'agroasysescrow-deploy.json');
      fs.writeFileSync(evidenceFile, '{"deployment":"initial"}\n');
      runGit(root, ['add', 'contract.sol', 'contracts/reports/deploy']);
      runGit(root, ['commit', '-m', 'test source']);

      const expectedIdentity = {
        commitSha: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
        worktreeClean: true as const,
      };
      expect(getDeploymentSourceIdentity(root)).to.deep.equal(expectedIdentity);

      fs.writeFileSync(evidenceFile, '{"deployment":"replacement"}\n');
      fs.writeFileSync(path.join(evidenceDirectory, 'verification.json'), '{}\n');
      expect(getDeploymentSourceIdentity(root)).to.deep.equal(expectedIdentity);

      const unexpectedReportFile = path.join(evidenceDirectory, 'operator-notes.txt');
      fs.writeFileSync(unexpectedReportFile, 'not generated evidence\n');
      expect(() => getDeploymentSourceIdentity(root)).to.throw('clean Git worktree');
      fs.rmSync(unexpectedReportFile);

      fs.appendFileSync(path.join(root, 'contract.sol'), '// modified\n');
      expect(() => getDeploymentSourceIdentity(root)).to.throw('clean Git worktree');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
