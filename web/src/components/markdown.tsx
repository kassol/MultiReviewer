import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

/**
 * agent 回复的 Markdown 渲染(spec #329 的会话页)。模型交出来的正文带标题、列表、代码块与
 * 表格,原样摊成纯文本读不动;这里把 GFM 映射到产品排版令牌。`skipHtml`:内嵌 HTML 一律
 * 丢掉,模型的文字不是可信 HTML。
 *
 * 流式生成时同一段文字每帧重渲一次,半截的代码围栏或表格 react-markdown 也能给出合法结果。
 */
const COMPONENTS: Components = {
  p: ({ node: _node, className, ...props }) => (
    <p {...props} className={cn("my-2 break-words text-lg first:mt-0 last:mb-0", className)} />
  ),
  h1: ({ node: _node, className, ...props }) => (
    <h1 {...props} className={cn("mt-3 mb-1.5 text-2xl font-bold first:mt-0", className)} />
  ),
  h2: ({ node: _node, className, ...props }) => (
    <h2 {...props} className={cn("mt-3 mb-1.5 text-xl font-bold first:mt-0", className)} />
  ),
  h3: ({ node: _node, className, ...props }) => (
    <h3 {...props} className={cn("mt-2.5 mb-1 text-lg font-bold first:mt-0", className)} />
  ),
  ul: ({ node: _node, className, ...props }) => (
    <ul {...props} className={cn("my-2 list-disc pl-5 first:mt-0 last:mb-0", className)} />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol {...props} className={cn("my-2 list-decimal pl-5 first:mt-0 last:mb-0", className)} />
  ),
  li: ({ node: _node, className, ...props }) => (
    <li {...props} className={cn("my-0.5 break-words text-lg", className)} />
  ),
  strong: ({ node: _node, className, ...props }) => (
    <strong {...props} className={cn("font-semibold", className)} />
  ),
  a: ({ node: _node, className, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noreferrer"
      className={cn("break-all text-primary underline underline-offset-2", className)}
    />
  ),
  blockquote: ({ node: _node, className, ...props }) => (
    <blockquote
      {...props}
      className={cn("my-2 border-l-2 border-line pl-3 text-text-secondary", className)}
    />
  ),
  hr: ({ node: _node, className, ...props }) => (
    <hr {...props} className={cn("my-3 border-line", className)} />
  ),
  pre: ({ node: _node, className, ...props }) => (
    <pre
      {...props}
      className={cn(
        "my-2 overflow-x-auto rounded-lg border border-line bg-sunken p-3 font-mono text-xs first:mt-0 last:mb-0",
        className,
      )}
    />
  ),
  // 行内 code 套灰底;围栏里的 code 已经由 pre 画底,不再套一层。
  code: ({ node: _node, className, ...props }: ComponentProps<"code"> & { node?: unknown }) => {
    const fenced = typeof className === "string" && className.startsWith("language-");
    return (
      <code
        {...props}
        className={cn(
          fenced ? "font-mono" : "rounded-chip bg-fill px-1 py-0.5 font-mono text-xs",
          className,
        )}
      />
    );
  },
  table: ({ node: _node, className, ...props }) => (
    <div className="my-2 min-w-0 overflow-x-auto">
      <table {...props} className={cn("border-collapse text-base", className)} />
    </div>
  ),
  th: ({ node: _node, className, ...props }) => (
    <th
      {...props}
      className={cn("border border-line bg-sunken px-2 py-1 text-left text-sm font-bold", className)}
    />
  ),
  td: ({ node: _node, className, ...props }) => (
    <td {...props} className={cn("border border-line px-2 py-1 align-top", className)} />
  ),
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
