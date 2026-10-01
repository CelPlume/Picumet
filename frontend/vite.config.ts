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
      // skipFull 必须在 **reporter 级** 覆盖：Vitest 在检测到 agent/CI 环境（std-env 的 isAgent，
      // 例如 CI、AGENT、CLAUDECODE 等环境变量）时，会给 text reporter 强制注入 skipFull:true，
      // 从而隐藏 100% 覆盖的文件——escape.ts 恰好是 100%，会在 CI 上消失。
      // 该注入发生在 coverage 级配置解析之后且 spread 在前，覆盖率顶层的 skipFull:false 压不住它。
      reporter: [['text', { skipFull: false }], 'html'],
      // 门禁**只**覆盖以下两个模块（thresholds 仅以这两个文件计算，不要把 include 扩大到整个 src/）：
      // - src/lib/escape.ts：escapeHtml 是纵深防御（defense-in-depth）助手，**没有任何生产调用方**。
      //   代码预览链路依赖 highlight.js 自身的实体转义作为唯一安全边界，并**刻意不**预跑 escapeHtml
      //   （预转义会与 hljs 内部转义叠加成双重转义，页面显示 &lt; 并破坏语法匹配）。
      //   因此这里的 100% 只是"转义函数契约测试"，**不代表存在一条在线的 XSS 防御**。
      // - src/pages/Register.tsx：注册页是真实面向用户的交互面，门禁的主要着力点。
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
