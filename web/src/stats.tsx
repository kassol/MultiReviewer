import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "./api.ts";

export type Cell = {
  model: string;
  category: string;
  resolved: number;
  unresolved: number;
  unknownClosed: number;
  unknownOpen: number;
};

type StatsResponse = {
  from: string;
  to: string;
  cells: Cell[];
  database: { fileBytes: number; tables: { name: string; rows: number }[] };
};

/** 分母 = 已处置 + 看过未 resolve + 已关闭 PR 上无人处置(ADR 0006)。 */
export function denominator(cell: Cell): number {
  return cell.resolved + cell.unresolved + cell.unknownClosed;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** 比率永远带原始分子分母,读者自己判断样本够不够(ADR 0006)。 */
function Rate({ resolved, total }: { resolved: number; total: number }) {
  if (total === 0) {
    return (
      <span className="faint num" style={{ fontSize: 12 }}>
        0/0
      </span>
    );
  }
  const pct = Math.round((resolved / total) * 100);
  return (
    <div className="rate">
      <b>
        {resolved}/{total} ({pct}%)
      </b>
      <div className="bar">
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function StatsPage() {
  const [from, setFrom] = useState(() => isoDay(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const [to, setTo] = useState(() => isoDay(Date.now()));

  const stats = useQuery({
    queryKey: ["stats", from, to],
    queryFn: async () => {
      // 日期框被清空时不发空串——漏掉的那头由服务端默认窗口兜底。
      const params = new URLSearchParams();
      if (from) params.set("from", `${from}T00:00:00.000Z`);
      if (to) params.set("to", `${to}T23:59:59.999Z`);
      const response = await api(`/stats?${params}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `请求失败(${response.status})`);
      }
      return (await response.json()) as StatsResponse;
    },
  });

  const cells = stats.data?.cells ?? [];
  const models = [...new Set(cells.map((cell) => cell.model))].sort();
  const categories = [...new Set(cells.map((cell) => cell.category))].sort();
  const byKey = new Map(cells.map((cell) => [`${cell.model}\n${cell.category}`, cell]));
  const modelTotal = (model: string): { resolved: number; total: number } =>
    cells
      .filter((cell) => cell.model === model)
      .reduce(
        (acc, cell) => ({
          resolved: acc.resolved + cell.resolved,
          total: acc.total + denominator(cell),
        }),
        { resolved: 0, total: 0 },
      );

  return (
    <div className="b-wrap">
      <div className="b-head">
        <div>
          <h1>处置率</h1>
          <p className="muted" style={{ fontSize: 13 }}>
            人看过并做了结论的 Finding 占比。同一处 Finding 只算一次,进不了行级评论的不计入。
          </p>
        </div>
        <div className="b-window">
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          <span className="faint">→</span>
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </div>
      </div>

      {stats.isError ? <p className="error">{(stats.error as Error).message}</p> : null}

      <div className="b-tiles">
        {models.map((model) => {
          const total = modelTotal(model);
          const pct = total.total === 0 ? 0 : Math.round((total.resolved / total.total) * 100);
          return (
            <div className="card tile" key={model}>
              <span className="model">{model}</span>
              <span className="big">{pct}%</span>
              <span className="num faint" style={{ fontSize: 12 }}>
                {total.resolved}/{total.total} 条已处置
              </span>
              <div className="bar">
                <i style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
        {models.length === 0 && !stats.isPending ? (
          <p className="faint">这个时间窗里没有可统计的 Finding。</p>
        ) : null}
      </div>

      {models.length > 0 ? (
        <section className="card scroll-x">
          <table className="matrix">
            <thead>
              <tr>
                <th>模型</th>
                {categories.map((category) => (
                  <th key={category}>{category}</th>
                ))}
                <th>合计</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const total = modelTotal(model);
                return (
                  <tr key={model}>
                    <th>{model}</th>
                    {categories.map((category) => {
                      const cell = byKey.get(`${model}\n${category}`);
                      return (
                        <td key={category}>
                          {cell === undefined ? (
                            <span className="faint num" style={{ fontSize: 12 }}>
                              —
                            </span>
                          ) : (
                            <Rate resolved={cell.resolved} total={denominator(cell)} />
                          )}
                        </td>
                      );
                    })}
                    <td>
                      <Rate resolved={total.resolved} total={total.total} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}

      {stats.data === undefined ? null : (
        <section className="card panel">
          <h2>库体量</h2>
          <div className="kv">
            <span className="k">库文件</span>
            <span className="num">{humanBytes(stats.data.database.fileBytes)}</span>
          </div>
          {stats.data.database.tables.map((table) => (
            <div className="kv" key={table.name}>
              <span className="k mono">{table.name}</span>
              <span className="num">{table.rows} 行</span>
            </div>
          ))}
          <p className="faint" style={{ fontSize: 12 }}>
            评审记录只写不清:处置率算在历史行上,删行即删样本。
          </p>
        </section>
      )}
    </div>
  );
}
