// Markdown 格式化预览（支持表格、删除线、任务列表等 GFM 扩展）。
//
// 安全模型（对照仓库 XSS 约束「禁止 dangerouslySetInnerHTML，除非明确安全审查」）：
// - react-markdown **默认不渲染原始 HTML**（无 rehype-raw 时 `<script>` 等标签按文本输出），
//   正文里不存在任何文档级 dangerouslySetInnerHTML——MD 源里的内联 HTML 都是纯文本节点；
// - remark-gfm 仅扩展表格/删除线/任务列表等语法，不引入 HTML 注入面；
// - 围栏代码块把**原始代码**直接交给 highlight.js，其自身的实体转义即是唯一安全边界
//   （详见下方 highlightFence 的注释）——此处**不**预跑 escapeHtml：那会与 hljs 内部
//   转义叠加成双重转义（页面显示 `&lt;`）并破坏语法匹配。
import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from '@/lib/hljs';

/** 从 ```lang 围栏提取 hljs 语言标识（未注册语言回退 auto） */
function highlightFence(code: string, lang: string | undefined): string | undefined {
  // highlight.js 的输出契约就是对原始代码做实体转义（< → &lt; 等），这里必须传**原始**代码：
  // 预先 escapeHtml 会与 hljs 内部转义叠加成双重转义（页面显示 `&lt;`），并破坏语法匹配。
  // 输出经 dangerouslySetInnerHTML 的安全边界 = hljs 自身的转义行为（其核心规范，输入即视为纯文本）。
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return undefined;
  }
}

export function MarkdownPreview({ content }: { content: string }) {
  // highlight.js 语言注册发生在 preview.tsx 模块加载时（本组件与其同一打包块）；
  // memo 避免父级与内容无关的重渲染重复解析整篇文档
  const node = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 围栏代码块由下方 code 覆盖渲染成自带 <pre> 的块；这里的默认 <pre> 只透传，避免 pre>pre 嵌套
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const match = /language-(\w+)/.exec(className ?? '');
            const raw = String(children ?? '').replace(/\n$/, '');
            if (!match && !raw.includes('\n')) {
              // 行内代码
              return <code className="md-inline-code">{children}</code>;
            }
            const html = highlightFence(raw, match?.[1]);
            return html ? (
              <pre className="md-fence scrollbar-thin">
                <code className={className} dangerouslySetInnerHTML={{ __html: html }} />
              </pre>
            ) : (
              <pre className="md-fence scrollbar-thin">
                <code className={className}>{children}</code>
              </pre>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    ),
    [content]
  );
  return <div className="md-preview h-full w-full overflow-auto scrollbar-thin">{node}</div>;
}
