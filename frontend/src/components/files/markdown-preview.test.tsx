// Markdown 预览组件测试：
// - 格式化渲染（标题/加粗/GFM 表格/行内代码/围栏高亮）；
// - 安全边界：原始 HTML（<script>/<img onerror>）按文本输出，绝不进 DOM 元素（react-markdown 默认转义）；
// - 文本类分类器（isMarkdown/isText）。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownPreview } from './markdown-preview';
import { isMarkdown, isText } from '@/lib/utils';

describe('MarkdownPreview', () => {
  it('渲染标题 / 加粗 / 行内代码 / 链接', () => {
    const { container } = render(<MarkdownPreview content={'# 标题一\n\n**加粗** 与 `code` 与 [链接](https://example.com)'} />);
    expect(container.querySelector('h1')?.textContent).toBe('标题一');
    expect(container.querySelector('strong')?.textContent).toBe('加粗');
    expect(container.querySelector('.md-inline-code')?.textContent).toBe('code');
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com');
  });

  it('GFM 表格渲染为 table（含表头）', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    const { container } = render(<MarkdownPreview content={md} />);
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelectorAll('th').length).toBe(2);
    expect(container.querySelectorAll('td').length).toBe(2);
  });

  it('原始 HTML 不渲染为元素：<script> 与 <img onerror> 均按文本输出（XSS 边界）', () => {
    const md = '前文\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n后文';
    const { container } = render(<MarkdownPreview content={md} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    // 内容仍在（文本节点形式），不静默吞掉
    expect(container.textContent).toContain('alert(1)');
    expect(container.textContent).toContain('onerror');
  });

  it('围栏代码块经转义 + 高亮：源码里的 HTML 不会成为元素', () => {
    const md = '```html\n<script>alert(1)</script>\n```';
    const { container } = render(<MarkdownPreview content={md} />);
    expect(container.querySelector('.md-fence')).toBeTruthy();
    // 高亮输出是转义后的标记：<script> 只能以文本实体形式存在，不能是真实元素
    expect(container.querySelector('.md-fence script')).toBeNull();
    expect(container.querySelector('.md-fence')?.textContent).toContain('<script>');
  });

  it('围栏代码块按语言高亮（html → hljs 标记）', () => {
    const md = '```html\n<p>hi</p>\n```';
    const { container } = render(<MarkdownPreview content={md} />);
    const fence = container.querySelector('.md-fence code');
    expect(fence?.querySelector('.hljs-tag')).toBeTruthy();
  });

  it('无语言多行围栏回落纯文本块，不丢内容', () => {
    const md = '```\nplain line\nsecond line\n```';
    const { container } = render(<MarkdownPreview content={md} />);
    expect(container.querySelector('.md-fence')?.textContent).toContain('plain line');
  });
});

describe('文本类分类器', () => {
  it('isMarkdown：md/markdown 命中，其他不命中', () => {
    expect(isMarkdown('README.md')).toBe(true);
    expect(isMarkdown('notes.markdown')).toBe(true);
    expect(isMarkdown('a.txt')).toBe(false);
    expect(isMarkdown('a.js')).toBe(false);
  });
  it('isText：txt/log 命中，markdown/代码不命中', () => {
    expect(isText('notes.txt')).toBe(true);
    expect(isText('app.log')).toBe(true);
    expect(isText('README.md')).toBe(false);
  });
});
