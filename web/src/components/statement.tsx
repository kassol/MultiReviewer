import { Fragment } from "react";

import { statementParts } from "@/lib/products";

/**
 * 一句话的正文。拆段在 `lib/products.ts` 的 `statementParts`(反引号圈住的那几段按行内
 * 代码渲染,与会话页同一种样子),这里只画。产品知识的陈述与 Finding 的正文共用。
 */
export function Statement({ text }: { text: string }) {
  return (
    <>
      {statementParts(text).map((part, index) =>
        part.code ? (
          <code key={index} className="rounded-chip bg-fill px-1 py-0.5 font-mono text-xs">
            {part.text}
          </code>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
