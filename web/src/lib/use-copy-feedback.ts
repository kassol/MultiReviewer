/**
 * 复制到剪贴板之后那 2 秒的反馈状态(2026-10-28,backlog #467)。三处复制按钮(阶段页的
 * 「复制给 AI」、回复卡与阅读视图的「复制 Markdown」)原先各写一份 `writeText` → 置位 →
 * `setTimeout` 复位,连点与卸载时的计时器也各处理一遍;收在这里之后判据只有一份。
 *
 * `copied` 总是 2 秒后复位;`failed` 默认留着,直到下一次复制——失败原因不该自己消失,
 * 人得看见它。阶段页那枚失败徽章要跟成功一样一闪即收,传 `resetFailed: true`。
 */
import { useEffect, useRef, useState } from "react";

/** 成功反馈在界面上停留的时长。 */
const COPY_FEEDBACK_MS = 2000;

export type CopyFeedback = {
  /** 刚复制成功:2 秒后自动复位。 */
  copied: boolean;
  /** 复制失败:默认保留到下一次复制。 */
  failed: boolean;
  /** 失败原文,成功时清空。 */
  error: string | null;
  /** 写剪贴板;文本在点击那一刻才求值,调用方直接传进来即可。 */
  copy: (text: string) => Promise<void>;
};

export function useCopyFeedback({ resetFailed = false }: { resetFailed?: boolean } = {}): CopyFeedback {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
      setError(null);
    } catch (failure) {
      setCopied(false);
      setFailed(true);
      setError((failure as Error).message);
    }
    // 连点只按最后一次计时;旧的那一次不能把刚点出来的状态提前收走。
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopied(false);
      if (resetFailed) setFailed(false);
    }, COPY_FEEDBACK_MS);
  };

  return { copied, failed, error, copy };
}
