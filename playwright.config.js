'use strict';

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: process.env.PM_CHROMIUM
      ? { executablePath: process.env.PM_CHROMIUM, args: ['--disable-dev-shm-usage'] }
      : {}
  },
  projects: [
    { name: 'PC', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } } },
    { name: 'スマホ', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } }
  ],
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1',
    url: 'http://127.0.0.1:4173/portfolio_manager.html',
    reuseExistingServer: false
  }
});
