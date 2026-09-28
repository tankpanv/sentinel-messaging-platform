import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runtimePath = resolve(root, 'frontend/src/generated/runtime.ts');
const runtime = readFileSync(runtimePath, 'utf8');
const basePathLine = /export const BASE_PATH = "[^"]*"\.replace\(\/\\\/\+\$\/, ""\);/;
if (!basePathLine.test(runtime) && !runtime.includes('export const BASE_PATH = "";')) throw new Error('OpenAPI runtime BASE_PATH format changed; review generated client before use');
if (basePathLine.test(runtime)) writeFileSync(runtimePath, runtime.replace(basePathLine, 'export const BASE_PATH = "";'));

for (const name of ['frontend/src/generated/apis/DefaultApi.ts', 'frontend/src/generated/docs/DefaultApi.md', 'frontend/src/generated/models/AgentRun.ts']) {
  const file = resolve(root, name);
  writeFileSync(file, readFileSync(file, 'utf8').split('\n').map(line => line.trimEnd()).join('\n'));
}
