/**
 * 全屏图表预览那块画布的视图变换(`components/mermaid-diagram.tsx`,issue #377)。
 *
 * 视图就是一组数:`x` / `y` 是图的左上角落在画布坐标系里的什么位置,`scale` 是倍率。缩放
 * 一律绕一个锚点做——滚轮绕光标、双指绕两指中点、按键绕画布中心——锚点在图上对应的那处
 * 得留在原地,否则每放大一档图就往一边跑。算式抽成纯函数是为了让它被 `node --test` 跑到:
 * 画布交互测不了,而这里错一项只表现成「图飞出去了」,靠眼睛回归一次要开好几张图。
 */

export type DiagramView = { scale: number; x: number; y: number };

export type Point = { x: number; y: number };

/** 画布上同时按住的两根手指,按落下的先后排。坐标相对画布左上角。 */
export type PointerPair = readonly [Point, Point];

export type Size = { width: number; height: number };

/** 画布缩放的上下界。低于 0.25 图上的字已经认不出,高于 8 一屏只剩一个节点。 */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 8;

export function clampScale(scale: number) {
  return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
}

/** 以画布上的 `(x, y)` 为锚缩放:那个点在图上对应的位置保持不动。 */
export function zoomAround(view: DiagramView, scale: number, x: number, y: number): DiagramView {
  const next = clampScale(scale);
  return {
    scale: next,
    x: x - ((x - view.x) * next) / view.scale,
    y: y - ((y - view.y) * next) / view.scale,
  };
}

/**
 * 双指走一步:两指间距变化多少即倍率变化多少,两指中点移动多少图跟着平移多少。逐步算
 * (上一帧的两点 → 这一帧的两点),不记下按下那一刻再累计——倍率顶到上下界之后反向捏,
 * 图立刻跟手,而不是先把欠下的那一段还完。
 */
export function pinchView(view: DiagramView, from: PointerPair, to: PointerPair): DiagramView {
  const spread = distance(from);
  if (spread === 0) return view;
  const before = midpoint(from);
  const after = midpoint(to);
  const zoomed = zoomAround(view, (view.scale * distance(to)) / spread, before.x, before.y);
  return { scale: zoomed.scale, x: zoomed.x + after.x - before.x, y: zoomed.y + after.y - before.y };
}

/**
 * 「适应」。宽屏两轴一起装进画布并居中;**窄屏只按宽度适应**,装不下的高度留给纵向拖动——
 * 390px 上一张横着长的时序图两轴都装会落到 25%,节点里的字认不出来;按宽对齐之后字回到能读
 * 的大小,上下拖着读完。判据取外壳那个 640px 切换点:预览浮层占满视口减 2rem,画布宽度就是
 * 视口宽度。图比画布矮时仍然纵向居中,高于画布则从顶上开始,免得开场就看半截。
 */
const NARROW_CANVAS = 640;

export function fitView(canvas: Size, diagram: Size): DiagramView {
  const byWidth = canvas.width / diagram.width;
  const scale = clampScale(
    canvas.width < NARROW_CANVAS ? byWidth : Math.min(byWidth, canvas.height / diagram.height),
  );
  return {
    scale,
    x: (canvas.width - diagram.width * scale) / 2,
    y: Math.max((canvas.height - diagram.height * scale) / 2, 0),
  };
}

function midpoint([a, b]: PointerPair): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance([a, b]: PointerPair) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
