import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'playwright/test';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '../..');
const frontendPort = Number(process.env.C3_FRONTEND_PORT || 4513);
const systemChrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);

export default defineConfig({
  testDir: testDirectory,
  testMatch: 'c3-agent-run.spec.mjs',
  outputDir: path.join(repositoryRoot, 'test-results/c3-agent-run/artifacts'),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(repositoryRoot, 'test-results/c3-agent-run/html'), open: 'never' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: systemChrome, args: ['--no-sandbox'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
