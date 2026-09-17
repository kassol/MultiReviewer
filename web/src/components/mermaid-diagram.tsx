import {
  AspectRatioIcon,
  ChevronDownIcon,
  Cross2Icon,
  EnterFullScreenIcon,
  SizeIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "@radix-ui/react-icons";
import { IconButton, Skeleton } from "@radix-ui/themes";
import { Collapsible, Dialog } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  fitView,
  pinchView,
  zoomAround,
  type DiagramView,
  type Point,
  type PointerPair,
} from "@/lib/diagram-view";
import { cn } from "@/lib/utils";

/**
 * mermaid 整包按需下载并只初始化一次。主题取 `base` 再把 `--v8-*` 令牌填进
 * `themeVariables`,图里的面、线与文字因此和面板同一套颜色,不用它自带的紫色。
 */
let loading: Promise<typeof import("mermaid").default> | undefined;

function loadMermaid() {
  loading ??= import("mermaid").then(({ default: mermaid }) => {
    const root = getComputedStyle(document.documentElement);
    const token = (name: string) => root.getPropertyValue(name).trim();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // 出错时连临时容器一起收走。默认行为是先把错误图画进挂在 body 上的临时 div 再抛,
      // 那个 div 会留在文档里。
      suppressErrorRendering: true,
      fontFamily: token("--v8-font-text"),
      // mermaid 12 默认 look 是 neo:节点带投影与渐变描边,与面板的平面卡片不是一套。
      look: "classic",
      // 12 把 flowchart 的换行宽度从 200 收到 120,中英混排的节点标签三四个字就折一行。
      flowchart: { wrappingWidth: 200 },
      // 节点标签是 HTML,浏览器对中文默认逐字可断,会把「挑最佳」拆成「挑 / 最佳」。
      // keep-all 只在空格处断,整段无空格的中文超宽时由 overflow-wrap 兜底。
      themeCSS: ".nodeLabel, .edgeLabel { word-break: keep-all; overflow-wrap: anywhere; }",
      theme: "base",
      themeVariables: {
        background: token("--v8-surface"),
        primaryColor: token("--v8-accent-tint"),
        primaryBorderColor: token("--v8-accent"),
        primaryTextColor: token("--v8-text"),
        secondaryColor: token("--v8-surface-sunken"),
        tertiaryColor: token("--v8-bg"),
        lineColor: token("--v8-text-secondary"),
        textColor: token("--v8-text"),
        // 不显式给时它由 secondaryColor 提亮 30 推出来,半透明令牌经这一步丢掉 alpha,
        // 「是 / 否」这类边标签就顶着一块实心灰。图卡底色是 surface,标签跟它同色。
        edgeLabelBackground: token("--v8-surface"),
      },
    });
    return mermaid;
  });
  return loading;
}

/** 同一段代码只渲染一次:会话页流式重渲时每一帧都会走到这里。 */
const drawn = new Map<string, Promise<string>>();
let serial = 0;

function draw(code: string) {
  let job = drawn.get(code);
  if (job === undefined) {
    // id 必须在这里定下来:mermaid 渲染前会把文档里同 id 的元素删掉,同页几张图并发时若等
    // 到包加载完再读 serial,拿到的是同一个号,先画好的那张会被后画的顺手清空。
    serial += 1;
    const id = `mermaid-${serial}`;
    job = loadMermaid().then(async (mermaid) => (await mermaid.render(id, code)).svg);
    drawn.set(code, job);
  }
  return job;
}

/** 报错正文常是多行的解析位置说明,一行里只放第一行。 */
function firstLine(reason: unknown) {
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.split("\n")[0]?.trim() || "图表渲染失败";
}

/** 渲染完成前按代码行数占位,免得图出来时整段正文往下跳。 */
function placeholderHeight(code: string) {
  const lines = code.trimEnd().split("\n").length;
  return Math.min(Math.max(lines, 4), 24) * 22;
}

/** mermaid 的 front matter 写了 title 就用它,否则统一叫「图表预览」。 */
function diagramTitle(code: string) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(code.trimStart());
  const title = front === null ? null : /^title:\s*(.+?)\s*$/m.exec(front[1] ?? "");
  return title?.[1] ?? "图表预览";
}

/** SVG 的自然尺寸取自 viewBox:预览画布按它定位与居中,不依赖布局测量的时机。 */
function naturalSize(svg: string) {
  const box = /viewBox="\s*[-\d.eE+]+\s+[-\d.eE+]+\s+([\d.eE+]+)\s+([\d.eE+]+)/.exec(svg);
  if (box === null) return null;
  const width = Number(box[1]);
  const height = Number(box[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Markdown 里的 ```mermaid 围栏(spec #329 的会话页里,agent 常用它画流程)。原样当代码块摊出来
 * 读不动,这里渲染成图卡:卡内 SVG 自适应宽度,右上角进全屏预览,卡底「源码」折叠回原代码块。
 * 渲染失败就退回原代码块并把报错第一行写在上面——图画不出来时,原文比一句「失败」有用。
 */
export function MermaidDiagram({ code, source }: { code: string; source: ReactNode }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // 流式生成时围栏是一行行长出来的,每一帧都去解析只会把半截语法的报错闪一遍。
    const timer = setTimeout(() => {
      void draw(code).then(
        (next) => {
          if (!live) return;
          setSvg(next);
          setError(null);
        },
        (reason: unknown) => {
          if (live) setError(firstLine(reason));
        },
      );
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code]);

  if (error !== null) {
    return (
      <div className="my-2 flex min-w-0 flex-col first:mt-0 last:mb-0">
        <p className="text-xs text-danger">{error}</p>
        {source}
      </div>
    );
  }

  if (svg === null) {
    return (
      <Skeleton
        aria-hidden
        className="my-2 w-full first:mt-0 last:mb-0"
        style={{ height: `${placeholderHeight(code)}px` }}
      />
    );
  }

  return (
    <figure className="group/diagram relative my-2 min-w-0 overflow-hidden rounded-lg border border-card-line bg-surface first:mt-0 last:mb-0">
      <div
        className="overflow-x-auto p-3 [&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <Dialog.Root>
        <Dialog.Trigger asChild>
          <IconButton
            variant="soft"
            color="gray"
            size="1"
            aria-label="放大预览"
            className="absolute top-1.5 right-1.5 min-h-11 min-w-11 transition-opacity md:min-h-0 md:min-w-0 md:opacity-0 md:group-hover/diagram:opacity-100 md:group-focus-within/diagram:opacity-100 md:focus-visible:opacity-100"
          >
            <EnterFullScreenIcon />
          </IconButton>
        </Dialog.Trigger>
        <DiagramPreview svg={svg} title={diagramTitle(code)} />
      </Dialog.Root>
      <Collapsible.Root className="group/source border-t border-line">
        <Collapsible.Trigger
          type="button"
          className="flex min-h-11 w-full cursor-pointer items-center gap-1.5 px-3 text-sm text-text-secondary outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset sm:min-h-9"
        >
          <span>源码</span>
          <ChevronDownIcon
            aria-hidden
            className="size-4 shrink-0 transition-transform group-data-[state=open]/source:rotate-180"
          />
        </Collapsible.Trigger>
        <Collapsible.Content className="px-3 pb-1">{source}</Collapsible.Content>
      </Collapsible.Root>
    </figure>
  );
}

/**
 * 全屏预览的浮层壳。Portal 挂到 `PanelTheme` 内的 `#panel-portal`,材质走第 2.3 节的浮层令牌。
 * 画布另起一个组件:它只在打开时挂载,「适应」因此能在挂载那一刻算一次。
 */
function DiagramPreview({ svg, title }: { svg: string; title: string }) {
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalHost(document.getElementById("panel-portal"));
  }, []);
  if (portalHost === null) return null;

  return (
    <Dialog.Portal container={portalHost}>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
      <Dialog.Content
        aria-describedby={undefined}
        style={{ backdropFilter: "var(--v8-drawer-blur)" }}
        className="fixed top-1/2 left-1/2 z-50 flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-[color:var(--v8-drawer-bg)] shadow-overlay outline-none"
      >
        <DiagramStage svg={svg} title={title} />
      </Dialog.Content>
    </Dialog.Portal>
  );
}

/** 画布上按住的那几根手指里取头两根,坐标换算到画布左上角。不足两根时返回 null。 */
function pairFrom(points: Point[], origin: Point): PointerPair | null {
  const [a, b] = points;
  if (a === undefined || b === undefined) return null;
  return [
    { x: a.x - origin.x, y: a.y - origin.y },
    { x: b.x - origin.x, y: b.y - origin.y },
  ];
}

function DiagramStage({ svg, title }: { svg: string; title: string }) {
  const size = useMemo(() => naturalSize(svg), [svg]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<DiagramView>({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  // 按在画布上的手指,键是 pointerId、值是它上一帧的位置(客户端坐标),按落下的先后排。
  // 一根即拖动,两根即捏合;两者都只看「上一帧到这一帧」的差,不必记按下那一刻的状态。
  const pointers = useRef(new Map<number, Point>());
  // 捏合期间画布左上角在客户端坐标里的位置。浮层是 fixed 的,一次手势里不会动,按下第二根
  // 手指时量一次就够——每帧都 getBoundingClientRect 是一次白搭的布局读取。
  const origin = useRef<Point | null>(null);

  /** 整张图按「适应」摆好:宽屏两轴都装下,窄屏按宽装、高度留给纵向拖动。 */
  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null || size === null) return;
    setView(fitView({ width: canvas.clientWidth, height: canvas.clientHeight }, size));
  }, [size]);

  const zoomAtCenter = useCallback((scale: number) => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    setView((current) =>
      zoomAround(current, scale, canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
  }, []);

  useEffect(() => {
    fit();
  }, [fit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    // React 把 onWheel 装成 passive 的,preventDefault 在那里不生效;要自己挂一个非
    // passive 的,否则滚轮会连页面一起滚。触控板双指捏合在浏览器里也是 wheel + ctrlKey,
    // 与滚轮走同一条路。
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY / (event.ctrlKey ? 100 : 400));
      setView((current) =>
        zoomAround(
          current,
          current.scale * factor,
          event.clientX - rect.left,
          event.clientY - rect.top,
        ),
      );
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <>
      {/* 窄屏上按键整排折到第二行,标题因此占满第一行:与它们挤在一行时标题只剩两个字宽。 */}
      <div className="flex flex-wrap items-center gap-1 border-b border-overlay-line px-2 py-2 sm:px-3">
        <Dialog.Title className="w-full min-w-0 truncate px-1 text-3xl font-semibold sm:w-auto sm:flex-1">
          {title}
        </Dialog.Title>
        <IconButton
          variant="ghost"
          color="gray"
          size="2"
          aria-label="缩小"
          onClick={() => zoomAtCenter(view.scale / 1.25)}
        >
          <ZoomOutIcon />
        </IconButton>
        <IconButton
          variant="ghost"
          color="gray"
          size="2"
          aria-label="放大"
          onClick={() => zoomAtCenter(view.scale * 1.25)}
        >
          <ZoomInIcon />
        </IconButton>
        <IconButton variant="ghost" color="gray" size="2" aria-label="适应" onClick={fit}>
          <SizeIcon />
        </IconButton>
        <IconButton
          variant="ghost"
          color="gray"
          size="2"
          aria-label="原始大小"
          onClick={() => zoomAtCenter(1)}
        >
          <AspectRatioIcon />
        </IconButton>
        <span className="w-12 shrink-0 text-right font-mono text-base text-text-muted tabular-nums">
          {Math.round(view.scale * 100)}%
        </span>
        <Dialog.Close asChild>
          <IconButton
            variant="ghost"
            color="gray"
            size="2"
            className="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
            aria-label={`关闭${title}`}
          >
            <Cross2Icon />
          </IconButton>
        </Dialog.Close>
      </div>
      <div
        ref={canvasRef}
        className={cn(
          "relative min-h-0 flex-1 touch-none overflow-hidden",
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size >= 2) {
            const rect = event.currentTarget.getBoundingClientRect();
            origin.current = { x: rect.left, y: rect.top };
            setDragging(false);
          } else {
            setDragging(true);
          }
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (previous === undefined) return;
          const before = [...pointers.current.values()];
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          const anchor = origin.current;
          if (before.length >= 2 && anchor !== null) {
            const from = pairFrom(before, anchor);
            const to = pairFrom([...pointers.current.values()], anchor);
            if (from !== null && to !== null) setView((current) => pinchView(current, from, to));
            return;
          }
          const dx = event.clientX - previous.x;
          const dy = event.clientY - previous.y;
          setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          pointers.current.delete(event.pointerId);
          // 松开一根手指后剩下的那根接着拖动:它记的位置就是它自己的上一帧,不会跳。
          if (pointers.current.size < 2) origin.current = null;
          setDragging(pointers.current.size === 1);
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) origin.current = null;
          setDragging(pointers.current.size === 1);
        }}
      >
        <div
          className="absolute top-0 left-0 origin-top-left [&_svg]:block [&_svg]:h-full [&_svg]:w-full"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            ...(size === null ? {} : { width: `${size.width}px`, height: `${size.height}px` }),
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </>
  );
}
