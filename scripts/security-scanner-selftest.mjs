import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-scanner-probe-'));
function scan(command, scanners, expectedId) {
  const output = path.join(directory, `${scanners}.json`);
  const result = spawnSync(
    'trivy',
    [
      command,
      ...(command === 'fs' ? ['--scanners', scanners] : []),
      '--exit-code',
      '1',
      '--format',
      'json',
      '--output',
      output,
      directory,
    ],
    { encoding: 'utf8', timeout: 180_000, stdio: 'pipe' },
  );
  assert.equal(result.status, 1, `${scanners}: seeded finding must fail the scanner`);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.ok(
    report.Results?.some((entry) =>
      [...(entry.Secrets ?? []), ...(entry.Misconfigurations ?? [])].some((finding) =>
        (finding.RuleID ?? finding.ID)?.includes(expectedId),
      ),
    ),
    `${scanners}: failure must contain the seeded detection, not a download or startup error`,
  );
}

try {
  // This synthetic token cannot authenticate. Build it here to keep fixtures credential-free.
  fs.writeFileSync(
    path.join(directory, 'credential.txt'),
    `token=${['ghp_', randomBytes(18).toString('hex')].join('')}\n`,
  );
  fs.writeFileSync(
    path.join(directory, 'main.tf'),
    'resource "aws_security_group_rule" "open" {\n type = "ingress"\n from_port = 22\n to_port = 22\n protocol = "tcp"\n cidr_blocks = ["0.0.0.0/0"]\n security_group_id = "sg-test"\n}\n',
  );
  scan('fs', 'secret', 'github');
  fs.rmSync(path.join(directory, 'credential.txt'));
  scan('config', 'misconfig', 'AWS-0107');
  console.log('Secret and IaC seeded detections passed.');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
