import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests',testMatch:'e2e.spec.ts',workers:1,timeout:90000,expect:{timeout:15000},reporter:'list'});
