import { useEffect, useState } from "react";
import { SavingsTimeline } from "../components/savings-timeline.tsx";
import { api, type Savings, type Schema } from "../api.ts";

function fmt(n: number): string {
  return n.toLocaleString();
}

export function Overview({ project }: { project: number }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [s, setS] = useState<Savings | null>(null);
  const [schema, setSchema] = useState<Schema | null>(null);

  useEffect(() => {
    let current = true;
    setS(null);
    setSchema(null);
    setError(null);
    Promise.all([api.savings(project), api.schema(project)])
      .then(([savings, schema]) => {
        if (current) {
          setS(savings);
          setSchema(schema);
        }
      })
      .catch((error: Error) => {
        if (current) setError(error.message);
      });
    return () => {
      current = false;
    };
  }, [project]);

  if (error)
    return (
      <p role="alert">
        Cannot load overview: {error}. Reopen this tab to retry.
      </p>
    );
  if (s === null) return <p>Loading savings…</p>;

  const minutes = Math.round(s.totalTokensSaved / 1000); // ~1k tokens/min reading, rough
  const max = Math.max(1, ...s.perTool.map((t) => t.tokensSaved));
  const pctVsGrep =
    s.totalBaselineTokens > 0
      ? Math.round((1 - s.totalResultTokens / s.totalBaselineTokens) * 100)
      : 0;

  return (
    <div>
      <div>
        <div className="kpi">
          <b>{fmt(s.totalTokensSaved)}</b>
          <span>tokens saved (estimated)</span>
        </div>
        <div className="kpi">
          <b>{fmt(s.totalCalls)}</b>
          <span>graph queries</span>
        </div>
        <div className="kpi">
          <b>~{fmt(minutes)}m</b>
          <span
            className="tooltip"
            title="approx tokens saved / 1000 tokens-per-minute reading"
          >
            reading avoided
          </span>
        </div>
        <div className="kpi">
          <b>{pctVsGrep}%</b>
          <span>fewer tokens vs grep+read</span>
        </div>
      </div>

      <h3>
        Savings by tool{" "}
        <span
          className="tooltip"
          title="Estimated. Result-aware tools sum the bytes of files grep+read would have opened; others use a bench-derived multiplier."
        >
          (how?)
        </span>
      </h3>
      {s.perTool.length === 0 && (
        <p>
          No tool calls recorded yet. Use Spindle's MCP tools to populate this.
        </p>
      )}
      {s.perTool.map((t) => (
        <div className="row" key={t.toolName}>
          <div style={{ width: 170 }}>{t.toolName}</div>
          <div
            className="bar"
            style={{ width: `${(t.tokensSaved / max) * 50}%` }}
          />
          <div>
            {fmt(t.tokensSaved)} ({t.calls})
          </div>
        </div>
      ))}

      <SavingsTimeline timeline={s.timeline} />

      <h3>Corpus</h3>
      {schema &&
        Object.entries(schema.nodeCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([label, n]) => (
            <div className="row" key={label}>
              <div style={{ width: 220 }}>{label}</div>
              <div>{fmt(n)}</div>
            </div>
          ))}
    </div>
  );
}
