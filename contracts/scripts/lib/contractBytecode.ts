// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

type ImmutableReference = { start: number; length: number };

export function normalizeRuntimeBytecode(
  bytecode: string,
  immutableReferences: Record<string, ImmutableReference[]>,
): string {
  const normalized = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
  const characters = normalized.split('');
  for (const references of Object.values(immutableReferences)) {
    for (const reference of references) {
      characters.fill('0', reference.start * 2, (reference.start + reference.length) * 2);
    }
  }
  return `0x${characters.join('')}`;
}
