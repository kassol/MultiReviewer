import {
  CheckCircledIcon,
  ChevronDownIcon,
  CopyIcon,
  Cross2Icon,
  DownloadIcon,
} from "@radix-ui/react-icons";
import { Dialog, IconButton, Text } from "@radix-ui/themes";
import { useEffect, useRef, useState } from "react";

import { Markdown } from "@/components/markdown";
import { Button } from "@/components/theme-button";
import { replyFileName, replyTitle } from "@/lib/reply-title";
import { localSecond } from "@/lib/time";

/**
 * 长回复的阅读视图(模仿 Craft Agents 的 `DocumentFormattedMarkdownOverlay`)。
 * 对话卡片里 320px 收着的长回复点「阅读」在这里摊开成一篇文章:字号上提一档(`Markdown`
 * 的 `size="article"`),880px 居中限宽,头部钉住标题与「复制 Markdown」,滚的只是正文。
 *
 * `open`/`onOpenChange` 受控:「阅读」按钮在对话卡片里,这个组件不渲染触发它的那个按钮;
 * 焦点归位交给调用方的 `useDialogReturnFocus`(`onCloseAutoFocus` 由调用方传入)。
 */
export function ReplyReader({
  open,
  onOpenChange,
  text,
  question,
  at,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  text: string;
  /** 这一轮里这条回复之前最近的一条用户消息;没有即 undefined。 */
  question: string | undefined;
  at: string;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [copied, setCopied] = useState(false);
  /**
   * 挂到 `#panel-portal`,与 mermaid 预览、阶段详情面板同一个宿主。Radix Themes 的 Dialog 默认
   * 挂到 body 末尾,而 `#root` 是一个 z-index 为 0 的层叠上下文:正文里 mermaid 图的全屏预览
   * 挂在 `#root` 里的宿主上,再高的 z-index 也压不过 body 末尾的阅读视图。同一个宿主里后开的
   * 预览排在后面,自然盖在阅读视图之上。
   */
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalHost(document.getElementById("panel-portal"));
  }, []);
  const title = replyTitle(question, text);
  /** 标题一行放不下(`truncate` 截掉了)才给「展开」:短问题不该多一颗点了没反应的键。 */
  const titleRef = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  const [titleOpen, setTitleOpen] = useState(false);
  useEffect(() => {
    const element = titleRef.current;
    if (!open || titleOpen || element === null) return;
    const check = (): void => setClipped(element.scrollWidth > element.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, titleOpen, title]);
  const download = (): void => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = replyFileName(title, at);
    link.click();
    URL.revokeObjectURL(url);
  };
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 阅读视图没有留反馈位:复制失败人再点一次,或者自己在正文里选中复制。
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {/* 上限里减掉视口宽:Radix 的滚动容器是按内容收缩的 flex 项,`width="100%"` 在手机上
          只能拿到「正文 72ch 加内边距」那么宽,比视口宽、关闭键被挤出屏外;把上限钉在视口
          宽减两侧 16px 边距,表格才在自己的滚动壳里横滚,壳不再撑开。 */}
      <Dialog.Content
        {...(portalHost === null ? {} : { container: portalHost })}
        width="100%"
        maxWidth="min(1200px, calc(100vw - 32px))"
        className="max-h-[calc(100dvh-64px)] overflow-y-auto rounded-3xl bg-surface p-0 shadow-modal"
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-overlay-line bg-surface px-6 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start gap-2">
              {/* 摊开的长问题限高自己滚,不把正文挤出视口。 */}
              <Dialog.Title
                size="4"
                mb="0"
                className={
                  titleOpen
                    ? "max-h-[40dvh] min-w-0 overflow-y-auto whitespace-pre-wrap break-words"
                    : "min-w-0"
                }
              >
                <span ref={titleRef} className={titleOpen ? undefined : "block truncate"}>
                  {title}
                </span>
              </Dialog.Title>
              {clipped || titleOpen ? (
                <IconButton
                  type="button"
                  variant="ghost"
                  color="gray"
                  size="1"
                  className="mt-1 shrink-0"
                  aria-expanded={titleOpen}
                  aria-label={titleOpen ? "收起问题" : "展开问题全文"}
                  onClick={() => setTitleOpen((was) => !was)}
                >
                  <ChevronDownIcon aria-hidden className={titleOpen ? "rotate-180" : undefined} />
                </IconButton>
              ) : null}
            </div>
            <Text as="p" size="1" color="gray">
              {localSecond(at)}
            </Text>
          </div>
          {/* ghost 键的 hover 底向四周撑出 8px,相邻两颗留 gap-5 才不叠。 */}
          <div className="flex shrink-0 items-center gap-5 max-sm:gap-3">
            <Button type="button" variant="ghost" color="gray" size="1" onClick={() => void copy()}>
              {copied ? <CheckCircledIcon aria-hidden /> : <CopyIcon aria-hidden />}
              <span className="max-sm:sr-only">{copied ? "已复制" : "复制 Markdown"}</span>
            </Button>
            <Button type="button" variant="ghost" color="gray" size="1" onClick={download}>
              <DownloadIcon aria-hidden />
              <span className="max-sm:sr-only">下载 .md</span>
            </Button>
            <Dialog.Close>
              <IconButton type="button" variant="ghost" color="gray" size="2" aria-label="关闭">
                <Cross2Icon aria-hidden />
              </IconButton>
            </Dialog.Close>
          </div>
        </div>
        <div className="px-6 py-5">
          <Markdown text={text} size="article" />
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
