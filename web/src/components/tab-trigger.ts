/**
 * Tabs 激活指示条与模型服务详情的 TabNav 同一形态:3px 圆头、左右各缩 14px。限定在
 * data-[state=active] 是必须的——不限定的话 Tailwind 会给未激活项也生成一个空的
 * ::before 盒子,把 tab 的高度顶开。
 */
export const TAB_TRIGGER =
  "data-[state=active]:before:inset-x-3.5 data-[state=active]:before:h-[3px] data-[state=active]:before:rounded-t-[3px]";
