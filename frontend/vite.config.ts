/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: 5173,
    // 忽略构建/覆盖率产物：coverage 与 dist 会随测试与构建写入，watcher 命中会触发整页重载（表现为页面反复刷新/卡住）
    watch: { ignored: ['**/coverage/**', '**/dist/**'] },

    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/webdav': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // 门禁聚焦安全关键模块：XSS 转义 + 注册页交互（均有回归测试锁定）
      include: ['src/lib/escape.ts', 'src/pages/Register.tsx'],
      exclude: ['src/test/**'],
      thresholds: {
        statements: 80,
        branches: 40,
        functions: 60,
        lines: 80,
      },
    },
  },
});
