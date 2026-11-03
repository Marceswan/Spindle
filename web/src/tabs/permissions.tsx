import { useState } from "react";
import { useRequestEpoch } from "../request-epoch.ts";
import { api, type SearchNode } from "../api.ts";

type Grant = { source_qualified_name: string; access: Record<string, unknown> };
type Group = { qualified_name: string; includes: string[] };

export function Permissions({ project }: { project: number }): JSX.Element {
  const [type, setType] = useState("Field");
  const [target, setTarget] = useState("");
  const [report, setReport] = useState<Record<string, unknown> | null>(null);

  const [methodQuery, setMethodQuery] = useState("");
  const [methods, setMethods] = useState<SearchNode[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const beginSearch = useRequestEpoch();
  const begin = useRequestEpoch();
  const [loading, setLoading] = useState(false);
  function clearReport(): void {
    begin();
    setReport(null);
    setLoading(false);
  }
  function changeType(value: string): void {
    clearReport();
    beginSearch();
    setSearching(false);
    setSearchError(null);
    setType(value);
    setTarget("");
    setMethods([]);
    setMethodQuery("");
    setSearched(false);
  }
  async function findMethods(): Promise<void> {
    const current = beginSearch();
    setSearching(true);
    setSearchError(null);
    setMethods([]);
    setTarget("");
    clearReport();
    try {
      const result = await api.search(project, methodQuery, "ApexMethod");
      if (current()) {
        setMethods(result.nodes);
        setSearched(true);
      }
    } catch (error) {
      if (current()) setSearchError((error as Error).message);
    } finally {
      if (current()) setSearching(false);
    }
  }
  async function run(): Promise<void> {
    if (type === "ApexMethod" && !target) return;
    const current = begin();
    setReport(null);
    setLoading(true);
    try {
      const result = await api.permission(project, type, target);
      if (current()) setReport(result);
    } catch (error) {
      if (current()) setReport({ error: (error as Error).message });
    } finally {
      if (current()) setLoading(false);
    }
  }

  const permSets = (report?.["permission_sets"] as Grant[] | undefined) ?? [];
  const profiles = (report?.["profiles"] as Grant[] | undefined) ?? [];
  const groups =
    (report?.["permission_set_groups"] as Group[] | undefined) ?? [];

  return (
    <div>
      <div className="row controls">
        <select
          aria-label="Target type"
          value={type}
          onChange={(e) => changeType(e.target.value)}
        >
          {[
            "Field",
            "ApexMethod",
            "SObject",
            "ApexClass",
            "VisualforcePage",
            "RecordType",
          ].map((t) => (
            <option key={t} value={t}>
              {t === "ApexMethod" ? "Apex method" : t}
            </option>
          ))}
        </select>
        {type === "ApexMethod" ? (
          <>
            <input
              aria-label="Method search"
              placeholder="Class or method name"
              value={methodQuery}
              onChange={(e) => {
                beginSearch();
                setSearching(false);
                setMethods([]);
                setTarget("");
                setSearched(false);
                setSearchError(null);
                clearReport();
                setMethodQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void findMethods();
              }}
            />
            <button disabled={searching} onClick={() => void findMethods()}>
              Find methods
            </button>
            {methods.length > 0 && (
              <select
                aria-label="Method"
                value={target}
                onChange={(e) => {
                  clearReport();
                  setTarget(e.target.value);
                }}
              >
                <option value="" disabled>
                  Select a method
                </option>
                {methods.map((method) => (
                  <option key={method.id} value={method.qualifiedName}>
                    {method.qualifiedName}
                  </option>
                ))}
              </select>
            )}
          </>
        ) : (
          <input
            aria-label="Permission target"
            placeholder={type === "Field" ? "Object__c.Field__c" : "ApiName"}
            value={target}
            onChange={(e) => {
              clearReport();
              setTarget(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
          />
        )}
        <button
          disabled={loading || (type === "ApexMethod" && !target)}
          onClick={() => void run()}
        >
          Who has access?
        </button>
      </div>
      {type === "ApexMethod" && (
        <p className="muted">
          Shows metadata grants to the method's declaring class. This does not
          determine whether a specific user can execute the method.
        </p>
      )}
      {searching && <p role="status">Searching methods…</p>}
      {searchError && <p role="alert">{searchError}. Try the search again.</p>}
      {type === "ApexMethod" &&
        searched &&
        !searching &&
        methods.length === 0 && (
          <p>
            No indexed methods match. Try a class name or a shorter method name.
          </p>
        )}
      {methods.length >= 50 && (
        <p className="muted">
          Showing the first 50 matches. Refine the search to find a specific
          method.
        </p>
      )}
      {report?.["declaringClass"] != null && (
        <p>
          Declaring class: <b>{String(report["declaringClass"])}</b>
        </p>
      )}
      {loading && <p role="status">Loading…</p>}
      {report?.["error"] != null && (
        <p style={{ color: "#ef4444" }}>{String(report["error"])}</p>
      )}
      {report && report["error"] == null && (
        <>
          <h3>Permission Sets ({permSets.length})</h3>
          <table>
            <tbody>
              {permSets.map((g, i) => (
                <tr key={i}>
                  <td>{g.source_qualified_name}</td>
                  <td>
                    <code>{JSON.stringify(g.access)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Profiles ({profiles.length})</h3>
          <table>
            <tbody>
              {profiles.map((g, i) => (
                <tr key={i}>
                  <td>{g.source_qualified_name}</td>
                  <td>
                    <code>{JSON.stringify(g.access)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {groups.length > 0 && (
            <>
              <h3>Permission Set Groups</h3>
              {groups.map((grp, i) => (
                <div className="row" key={i}>
                  <b>{grp.qualified_name}</b>: {grp.includes.join(", ")}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
