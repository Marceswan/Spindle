import { useState } from "react";
import type { Savings } from "../api.ts";

const DAY = 86_400_000;
/** Daily points use UTC, matching SQLite's date aggregation. Missing days mean zero calls. */
function dailyValues(
  timeline: Savings["timeline"],
  range: string,
): Savings["timeline"] {
  const sorted = [...timeline].sort((a, b) => a.day.localeCompare(b.day));
  if (!sorted.length) return [];
  const end = Date.parse(sorted[sorted.length - 1]!.day + "T00:00:00Z");
  const first = Date.parse(sorted[0]!.day + "T00:00:00Z");
  const start =
    range === "all" ? first : Math.max(first, end - (Number(range) - 1) * DAY);
  const byDay = new Map(sorted.map((d) => [d.day, d]));
  const result: Savings["timeline"] = [];
  for (let time = start; time <= end; time += DAY) {
    const day = new Date(time).toISOString().slice(0, 10);
    result.push(byDay.get(day) ?? { day, tokensSaved: 0, calls: 0 });
  }
  return result;
}

export function SavingsTimeline({
  timeline,
}: {
  timeline: Savings["timeline"];
}): JSX.Element {
  const [range, setRange] = useState("30");
  const days = dailyValues(timeline, range);
  if (!days.length)
    return (
      <section>
        <h3>Savings over time</h3>
        <p className="muted">
          No savings history yet. Run a graph query to start recording daily
          estimates.
        </p>
      </section>
    );
  const max = Math.max(1, ...days.map((d) => d.tokensSaved));
  const x = (i: number): number =>
    days.length === 1 ? 320 : 24 + (i / (days.length - 1)) * 592;
  const y = (value: number): number => 160 - (value / max) * 132;
  return (
    <section className="timeline">
      <div className="row controls">
        <h3>
          Savings over time <span className="muted">(estimated)</span>
        </h3>
        <select
          aria-label="Timeline range"
          value={range}
          onChange={(e) => setRange(e.target.value)}
        >
          <option value="30">Latest 30 days</option>
          <option value="90">Latest 90 days</option>
          <option value="all">All recorded dates</option>
        </select>
      </div>
      <p className="muted">
        Daily estimated tokens saved, UTC. {days[0]!.day} to{" "}
        {days[days.length - 1]!.day}; ends on the latest recorded activity.
      </p>
      <svg
        role="img"
        aria-label="Daily estimated token savings"
        viewBox="0 0 640 190"
      >
        <title>Daily estimated token savings (UTC)</title>
        <line x1="24" y1="160" x2="616" y2="160" stroke="var(--line)" />
        <text x="24" y="16" fill="var(--muted)" fontSize="12">
          {max.toLocaleString()} tokens
        </text>
        <polyline
          points={days.map((d, i) => `${x(i)},${y(d.tokensSaved)}`).join(" ")}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
        />
        {days.map((d, i) => (
          <circle
            key={d.day}
            cx={x(i)}
            cy={y(d.tokensSaved)}
            r="3"
            fill="var(--accent)"
          >
            <title>
              {d.day}: {d.tokensSaved.toLocaleString()} estimated tokens saved,{" "}
              {d.calls} calls
            </title>
          </circle>
        ))}
        <text x="24" y="184" fill="var(--muted)" fontSize="12">
          {days[0]!.day}
        </text>
        <text
          x="616"
          y="184"
          textAnchor="end"
          fill="var(--muted)"
          fontSize="12"
        >
          {days[days.length - 1]!.day}
        </text>
      </svg>
      <details>
        <summary>Daily values</summary>
        <div className="timeline-values">
          <table>
            <thead>
              <tr>
                <th scope="col">Date (UTC)</th>
                <th scope="col">Estimated tokens saved</th>
                <th scope="col">Calls</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td>{d.tokensSaved.toLocaleString()}</td>
                  <td>{d.calls.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
