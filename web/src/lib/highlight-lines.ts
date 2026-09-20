/** 文件扩展名到 highlight.js 语言名(`lib/common` 那一批里有的)。认不出的不高亮。 */
const LANGUAGE_BY_EXT: Record<string, string> = {
  java: "java", kt: "kotlin", kts: "kotlin", gradle: "kotlin",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", rb: "ruby", php: "php", swift: "swift", lua: "lua",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
  xml: "xml", html: "xml", htm: "xml", vue: "xml", svg: "xml",
  json: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", properties: "ini",
  css: "css", scss: "scss", less: "less", md: "markdown", graphql: "graphql",
};

export function languageOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "Makefile") return "makefile";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? undefined : LANGUAGE_BY_EXT[name.slice(dot + 1).toLowerCase()];
}

/**
 * 把 highlight.js 产出的整段 HTML 按换行拆成逐行 HTML。diff 一行一个 `<tr>`,而跨行的注释
 * 与字符串在 hljs 那里是一个跨行的 `<span>`:行尾把还开着的 span 全部闭合,下一行按原样
 * 重开,每一行因此都是自洽的一段 HTML。整段高亮再拆(而不是逐行高亮)是为了让跨行注释的
 * 第二行起仍被认成注释。
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = "";
  let last = 0;
  for (const match of html.matchAll(/<span[^>]*>|<\/span>|\n/g)) {
    current += html.slice(last, match.index);
    last = match.index + match[0].length;
    if (match[0] === "\n") {
      lines.push(current + "</span>".repeat(open.length));
      current = open.join("");
    } else {
      if (match[0] === "</span>") open.pop();
      else open.push(match[0]);
      current += match[0];
    }
  }
  lines.push(current + html.slice(last));
  return lines;
}
