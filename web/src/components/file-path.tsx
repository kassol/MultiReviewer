import { Fragment } from "react";

/**
 * 一个「文件:行」位置。目录走次级色、文件名走主文字色加半粗(次级色是对比度过 AA 的最浅一档):人认的是文件名,几百条往下
 * 扫时目录那一长串是噪声。整段仍是一个可折行的等宽串,复制出来与原路径逐字相同。
 */
export function FilePath({ file, line, className = "" }: { file: string; line: number; className?: string }) {
  const cut = file.lastIndexOf("/") + 1;
  return (
    // 窄屏上先在斜杠后折行(`<wbr>` 不进复制出来的文本),一段目录名本身放不下才在字符间断。
    <span className={`min-w-0 font-mono [overflow-wrap:anywhere] ${className}`}>
      <span className="text-text-secondary">
        {file.slice(0, cut).split("/").slice(0, -1).map((segment, index) => (
          <Fragment key={index}>{segment}/<wbr /></Fragment>
        ))}
      </span>
      <span className="font-medium text-text">{file.slice(cut)}</span>
      <span className="text-text-secondary">:{line}</span>
    </span>
  );
}
