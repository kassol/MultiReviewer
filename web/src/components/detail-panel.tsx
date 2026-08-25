import { Cross2Icon } from "@radix-ui/react-icons";
import { Dialog, IconButton } from "@radix-ui/themes";

/**
 * 桌面宽度 920px。两页装的都是完整 diff 或阶段汇总,一行代码在更窄的面板里要折三四次,
 * 而读 diff 的前提是一行就是一行。
 */
const WIDTH = "md:!w-[920px]";

/**
 * 主从列表的详情面板(DESIGN.md 10.2)。设计稿把它放在四边留白 14px 的位置上而不是
 * 贴边全高:面板浮在列表上,列表仍然露出来,「我是从哪一行点进来的」这个上下文不丢。
 *
 * 窄屏改成底部抽屉(不是全屏):列表的上半屏保持可见,关闭与底部动作都落在拇指能够
 * 到的下缘;全屏会让人以为自己跳了一页,退回去还要找返回入口。
 *
 * 评审记录与范围审查共用这一份外壳。
 */
export function DetailPanel({
  header,
  headerBelow,
  footer,
  onClose,
  onPointerDownOutside,
  children,
}: {
  /** 标题那一列:徽章、`Dialog.Title` 与副标题行。关闭按钮由面板自己出。 */
  header: React.ReactNode;
  /** 标题行下面还要占一块时给,例如处置进度条。 */
  headerBelow?: React.ReactNode;
  /** 底部动作条整段(含 `<footer>`)由调用方给;一个动作都没有时传 null。 */
  footer?: React.ReactNode;
  onClose: () => void;
  /** 点面板外面时接管这一下,例如换成列表里的另一项而不是关闭。 */
  onPointerDownOutside?: React.ComponentProps<typeof Dialog.Content>["onPointerDownOutside"];
  children: React.ReactNode;
}) {
  // `onPointerDownOutside` 在 Radix 那边是 exact optional,显式传 undefined 过不了类型,
  // 没给的时候整条属性就不出现。
  const dismiss = onPointerDownOutside === undefined ? {} : { onPointerDownOutside };
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Content
        aria-describedby={undefined}
        {...dismiss}
        // 四边定位只写 top/right/bottom/left 四个长写法,不混 inset-*:同一属性上「基础值 +
        // 断点值」的覆盖顺序才是确定的,混了简写会让断点值排在基础值前面而失效。
        className={`!fixed !top-auto !right-0 !bottom-0 !left-0 !m-0 !flex !h-[86dvh] !w-full !max-w-none !flex-col !overflow-hidden !rounded-3xl !rounded-b-none !border-0 !bg-[color:var(--v8-drawer-bg)] !p-0 !shadow-overlay backdrop-blur-[40px] md:!top-3.5 md:!right-3.5 md:!bottom-3.5 md:!left-auto md:!h-auto ${WIDTH} md:!max-w-[calc(100vw-28px)] md:!rounded-b-3xl`}
      >
        <header className="flex shrink-0 flex-col gap-3 border-b border-overlay-line px-6 pt-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">{header}</div>
            <Dialog.Close>
              <IconButton size="1" variant="soft" color="gray" radius="full" aria-label="关闭详情">
                <Cross2Icon />
              </IconButton>
            </Dialog.Close>
          </div>
          {headerBelow}
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
          {children}
        </div>

        {footer}
      </Dialog.Content>
    </Dialog.Root>
  );
}
