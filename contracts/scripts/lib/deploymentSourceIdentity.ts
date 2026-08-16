// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';

export interface DeploymentSourceIdentity {
  commitSha: string;
  worktreeClean: true;
}

export function getDeploymentSourceIdentity(repositoryRoot: string): DeploymentSourceIdentity {
  let commitSha: string;
  let status: string;
  try {
    commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    status = execFileSync(
      'git',
      [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        '.',
        ':(glob,exclude)contracts/reports/deploy/**/*.json',
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  } catch {
    throw new Error('Deployment requires a readable Git commit and worktree status');
  }

  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error('Deployment requires a full 40-character Git commit SHA');
  }
  if (status) {
    throw new Error('Deployment requires a clean Git worktree with no tracked or untracked changes');
  }

  return { commitSha, worktreeClean: true };
}
