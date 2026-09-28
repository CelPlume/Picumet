import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
      // F-01：与 wrangler.toml [alias] 一致——@aws-sdk/xml-builder 解析到 browser 构建
      //（DOMParser），Node 测试环境与 workerd 同样没有它。整体替换为 vendored 纯 JS 实现。
      '@aws-sdk/xml-builder': fileURLToPath(new URL('./src/shims/aws-xml-builder.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
  },
});
