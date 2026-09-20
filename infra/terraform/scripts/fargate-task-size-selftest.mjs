#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const platform = join(here, '..', 'staging-platform');

const validMemoryByCpu = new Map([
  [256, new Set([512, 1024, 2048])],
  [512, new Set([1024, 2048, 3072, 4096])],
  [1024, new Set(Array.from({ length: 7 }, (_, index) => 2048 + index * 1024))],
  [2048, new Set(Array.from({ length: 13 }, (_, index) => 4096 + index * 1024))],
  [4096, new Set(Array.from({ length: 23 }, (_, index) => 8192 + index * 1024))],
  [8192, new Set(Array.from({ length: 12 }, (_, index) => 16384 + index * 4096))],
  [16384, new Set(Array.from({ length: 12 }, (_, index) => 32768 + index * 8192))],
]);

function findBlock(source, start) {
  const openingBrace = source.indexOf('{', start);
  assert.notEqual(openingBrace, -1, 'Terraform resource has no opening brace.');

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '#' || (character === '/' && next === '/')) {
      lineComment = true;
      if (character === '/') index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }

  throw new Error('Terraform resource has no closing brace.');
}

const taskDefinitionPattern = /resource\s+"aws_ecs_task_definition"\s+"([^"]+)"\s*\{/g;
let checked = 0;

for (const file of readdirSync(platform)
  .filter((name) => name.endsWith('.tf'))
  .sort()) {
  const source = readFileSync(join(platform, file), 'utf8');
  for (const match of source.matchAll(taskDefinitionPattern)) {
    const body = findBlock(source, match.index);
    if (!/requires_compatibilities\s*=\s*\[[^\]]*"FARGATE"/s.test(body)) continue;

    const cpu = Number(body.match(/^\s*cpu\s*=\s*(\d+)\s*$/m)?.[1]);
    const memory = Number(body.match(/^\s*memory\s*=\s*(\d+)\s*$/m)?.[1]);
    assert.ok(cpu && memory, `${file}:${match[1]} must declare literal Fargate CPU and memory.`);
    assert.ok(
      validMemoryByCpu.get(cpu)?.has(memory),
      `${file}:${match[1]} uses an invalid Fargate size: ${cpu} CPU and ${memory} MiB memory.`,
    );
    checked += 1;
    console.log(`pass ${file}:${match[1]} ${cpu}/${memory}`);
  }
}

assert.ok(checked > 0, 'No Fargate task definitions were checked.');
console.log(`All ${checked} Fargate task definitions use supported CPU and memory pairs.`);
