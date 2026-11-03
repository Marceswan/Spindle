import { lazy, Suspense, useEffect, useState } from "react";
import { api, type Project } from "./api.ts";
import { Overview } from "./tabs/overview.tsx";
const Explore = lazy(() =>
  import("./tabs/explore.tsx").then((module) => ({ default: module.Explore })),
);
import { FieldImpact } from "./tabs/field-impact.tsx";
import { Permissions } from "./tabs/permissions.tsx";

const TABS = ["Overview", "Explore", "Field Impact", "Permissions"] as const;
type Tab = (typeof TABS)[number];

export function App(): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");

  useEffect(() => {
    api
      .projects()
      .then((ps) => {
        // Hide empty throwaway projects (e.g. session-start detection temps) when real ones exist.
        const real = ps.filter((p) => p.nodeCount > 0);
        const shown = real.length > 0 ? real : ps;
        setProjects(shown);
        if (shown.length > 0) setProject(shown[0]!.id);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div>
      <div className="tabs">
        {TABS.map((t) => (
          <div
            key={t}
            className={`tab ${t === tab ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t}
          </div>
        ))}
        <div style={{ marginLeft: "auto" }}>
          <select
            aria-label="Project"
            value={project ?? ""}
            onChange={(e) => setProject(Number(e.target.value))}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.nodeCount} nodes)
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="page" key={project}>
        {error && (
          <p role="alert">
            Cannot load projects: {error}. Reopen the Workbench from the CLI.
          </p>
        )}
        {project === null ? (
          <p>
            No indexed project found. Run{" "}
            <code>spindle index &lt;path&gt;</code> first.
          </p>
        ) : tab === "Overview" ? (
          <Overview project={project} />
        ) : tab === "Explore" ? (
          <Suspense fallback={<p role="status">Loading graph explorer…</p>}>
            <Explore project={project} />
          </Suspense>
        ) : tab === "Field Impact" ? (
          <FieldImpact project={project} />
        ) : (
          <Permissions project={project} />
        )}
      </div>
    </div>
  );
}
