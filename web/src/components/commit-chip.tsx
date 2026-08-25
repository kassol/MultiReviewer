/** commit hash 的统一表面:等宽 + 蓝 tint,列表副标题、总览与详情面板头共用。 */
export function CommitChip({ sha }: { sha: string }) {
  return (
    <code className="rounded-chip bg-accent-tint-strong px-[5px] font-mono text-xs font-normal text-primary">
      {sha.slice(0, 7)}
    </code>
  );
}
