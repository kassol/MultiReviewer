import type { ComponentProps } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

import { MermaidDiagram } from "@/components/mermaid-diagram";
import { cn } from "@/lib/utils";

/** ```mermaid 围栏的源码;其余围栏返回 null,照旧当代码块渲染。 */
function mermaidSource(node: ExtraProps["node"]): string | null {
  const fence = node?.children[0];
  if (fence === undefined || fence.type !== "element" || fence.tagName !== "code") return null;
  const names = fence.properties["className"];
  if (!Array.isArray(names) || !names.includes("language-mermaid")) return null;
  const text = fence.children[0];
  return text === undefined || text.type !== "text" ? null : text.value;
}

/**
 * 两档排版:`chat` 是对话流里的密度,`article` 是阅读视图(`ReplyReader`)里的密度——字号上提
 * 一档、行距放宽,长文一次性读下去不费眼。两档各自的 `Components` 表在下面按需要构建,
 * 只有类名不同,mermaid 与行内 code 的处理两档共用。
 */
function markdownComponents(size: "chat" | "article"): Components {
  const article = size === "article";
  const fence = cn(
    "my-2 overflow-x-auto rounded-lg border border-line bg-sunken font-mono text-xs first:mt-0 last:mb-0",
    article ? "p-4" : "p-3",
  );
  return {
    p: ({ node: _node, className, ...props }) => (
      <p
        {...props}
        className={cn(
          "break-words first:mt-0 last:mb-0",
          article ? "my-3 text-xl leading-[1.7]" : "my-2 text-lg",
          className,
        )}
      />
    ),
    h1: ({ node: _node, className, ...props }) => (
      <h1
        {...props}
        className={cn(
          "font-bold first:mt-0",
          article ? "mt-6 mb-2 text-4xl" : "mt-3 mb-1.5 text-2xl",
          className,
        )}
      />
    ),
    h2: ({ node: _node, className, ...props }) => (
      <h2
        {...props}
        className={cn(
          "font-bold first:mt-0",
          article ? "mt-6 mb-2 text-3xl" : "mt-3 mb-1.5 text-xl",
          className,
        )}
      />
    ),
    h3: ({ node: _node, className, ...props }) => (
      <h3
        {...props}
        className={cn(
          "font-bold first:mt-0",
          article ? "mt-6 mb-2 text-2xl" : "mt-2.5 mb-1 text-lg",
          className,
        )}
      />
    ),
    ul: ({ node: _node, className, ...props }) => (
      <ul
        {...props}
        className={cn(
          "list-disc pl-5 first:mt-0 last:mb-0",
          article ? "my-3 text-xl leading-[1.7]" : "my-2",
          className,
        )}
      />
    ),
    ol: ({ node: _node, className, ...props }) => (
      <ol
        {...props}
        className={cn(
          "list-decimal pl-5 first:mt-0 last:mb-0",
          article ? "my-3 text-xl leading-[1.7]" : "my-2",
          className,
        )}
      />
    ),
    li: ({ node: _node, className, ...props }) => (
      <li
        {...props}
        className={cn("break-words", article ? "my-1 text-xl leading-[1.7]" : "my-0.5 text-lg", className)}
      />
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
    pre: ({ node, className, ...props }) => {
      const fenceEl = <pre {...props} className={cn(fence, className)} />;
      const source = mermaidSource(node);
      return source === null ? fenceEl : <MermaidDiagram code={source} source={fenceEl} />;
    },
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
}

/** 两档排版各自的 `Components` 表在模块加载时建好一次,`size` 只用来挑一张——不必每次渲染
    重新拼一遍类名。 */
const CHAT_COMPONENTS = markdownComponents("chat");
const ARTICLE_COMPONENTS = markdownComponents("article");

/**
 * agent 回复的 Markdown 渲染(spec #329 的会话页)。模型交出来的正文带标题、列表、代码块与
 * 表格,原样摊成纯文本读不动;这里把 GFM 映射到产品排版令牌。`skipHtml`:内嵌 HTML 一律
 * 丢掉,模型的文字不是可信 HTML。
 *
 * 流式生成时同一段文字每帧重渲一次,半截的代码围栏或表格 react-markdown 也能给出合法结果。
 *
 * `size="article"`(阅读视图 `ReplyReader` 用):字号上提一档、行距放宽、正文限宽 72ch 居中
 * ——长文当文章读,不是当聊天气泡读。默认 `"chat"`,对话流里的密度不变。
 */
export function Markdown({
  text,
  className,
  size = "chat",
}: {
  text: string;
  className?: string;
  size?: "chat" | "article";
}) {
  return (
    <div className={cn("min-w-0", size === "article" ? "mx-auto max-w-[120ch]" : "", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={size === "article" ? ARTICLE_COMPONENTS : CHAT_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
