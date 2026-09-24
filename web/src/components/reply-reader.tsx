import {
  CheckCircledIcon,
  ChevronDownIcon,
  CopyIcon,
  Cross2Icon,
  DownloadIcon,
} from "@radix-ui/react-icons";
import { Dialog, IconButton, Text } from "@radix-ui/themes";
import { useEffect, useState } from "react";

import { Markdown } from "@/components/markdown";
import { Button } from "@/components/theme-button";
import { replyFileName, replyTitle } from "@/lib/reply-title";
import { localSecond } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * 长回复的阅读视图(模仿 Craft Agents 的 `DocumentFormattedMarkdownOverlay`)。
 * 对话卡片里 320px 收着的长回复点「阅读」在这里摊开成一篇文章:字号上提一档(`Markdown`
 * 的 `size="article"`),弹窗 1200px 宽、正文铺满,尽量用宽度;头部钉住标题与动作,滚的只是
 * 正文,滚动条因此不贯穿头部。
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
  /** 元素放在 state 里而不是 ref:Portal 里的内容晚于这个组件的 effect 才挂上,ref 在那一刻还是空的。 */
  const [titleElement, setTitleElement] = useState<HTMLSpanElement | null>(null);
  const [clipped, setClipped] = useState(false);
  const [titleOpen, setTitleOpen] = useState(false);
  useEffect(() => {
    if (titleOpen || titleElement === null) return;
    const check = (): void => setClipped(titleElement.scrollWidth > titleElement.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(titleElement);
    return () => observer.disconnect();
  }, [titleElement, titleOpen, title]);
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
          只能拿到「正文行宽加内边距」那么宽,比视口宽、关闭键被挤出屏外;把上限钉在视口
          宽减两侧 16px 边距,表格才在自己的滚动壳里横滚,壳不再撑开。
          Content 本身不滚(Themes 默认 overflow auto):它是一列 flex,头部不收缩,正文那一格
          `min-h-0` 自己滚。 */}
      <Dialog.Content
        {...(portalHost === null ? {} : { container: portalHost })}
        width="100%"
        maxWidth="min(1200px, calc(100vw - 32px))"
        className="flex max-h-[calc(100dvh-64px)] flex-col overflow-hidden rounded-3xl bg-surface p-0 shadow-modal"
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      >
        {/* 收起时整行对「标题 + 时刻」这一块垂直居中;问题摊开后那一块变高,动作键留在顶上。
            「展开问题全文」放进动作组:放在标题旁它只对得上标题那一行,与右侧三颗差半行。 */}
        <div
          className={cn(
            "flex shrink-0 justify-between gap-3 border-b border-overlay-line px-4 py-3 sm:px-8",
            titleOpen ? "items-start" : "items-center",
          )}
        >
          <div className="min-w-0 flex-1">
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
              <span ref={setTitleElement} className={titleOpen ? undefined : "block truncate"}>
                {title}
              </span>
            </Dialog.Title>
            <Text as="p" size="1" color="gray">
              {localSecond(at)}
            </Text>
          </div>
          {/* ghost 键的 hover 底向四周撑出 8px,相邻两颗留 gap-5 才不叠。 */}
          <div className="flex shrink-0 items-center gap-5 max-sm:gap-3">
            {clipped || titleOpen ? (
              <IconButton
                type="button"
                variant="ghost"
                color="gray"
                size="1"
                aria-expanded={titleOpen}
                aria-label={titleOpen ? "收起问题" : "展开问题全文"}
                onClick={() => setTitleOpen((was) => !was)}
              >
                <ChevronDownIcon aria-hidden className={titleOpen ? "rotate-180" : undefined} />
              </IconButton>
            ) : null}
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
        <div className="min-h-0 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6">
          <Markdown text={text} size="article" />
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
