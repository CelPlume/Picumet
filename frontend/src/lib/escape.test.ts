// escapeHtml：代码预览高亮前的 XSS 纵深防御
import { describe, it, expect } from 'vitest';
import { escapeHtml } from './escape';

describe('escapeHtml', () => {
  it('转义脚本标签，防止注入 innerHTML', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('转义引号与 & 号', () => {
    expect(escapeHtml(`a & "b" 'c'`)).toBe('a &amp; &quot;b&quot; &#39;c&#39;');
  });

  it('普通文本保持不变', () => {
    const code = 'const x = 1; // 正常代码\nfunction hi() { return 1 + 1; }';
    expect(escapeHtml(code)).toBe(code);
  });

  it('不破坏 highlight.js 后续高亮所需的结构', () => {
    const input = '<div class="a">x</div>';
    const escaped = escapeHtml(input);
    expect(escaped).not.toContain('<div');
    expect(escaped).toContain('&lt;div');
  });
});
