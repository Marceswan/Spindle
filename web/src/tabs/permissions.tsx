import { useState } from "react";
import {useRequestEpoch} from "../request-epoch.ts";
import { api } from "../api.ts";

type Grant = { source_qualified_name: string; access: Record<string, unknown> };
type Group = { qualified_name: string; includes: string[] };

export function Permissions({ project }: { project: number }): JSX.Element {
  const [type, setType] = useState("Field");
  const [target, setTarget] = useState("");
  const [report, setReport] = useState<Record<string, unknown> | null>(null);

  const begin = useRequestEpoch();
  const [loading, setLoading] = useState(false);
  async function run(): Promise<void> {
    const current = begin();
    setReport(null); setLoading(true);
    try { const result = await api.permission(project, type, target); if (current()) setReport(result); }
    catch (error) { if (current()) setReport({error: (error as Error).message}); }
    finally { if (current()) setLoading(false); }
  }

  const permSets = (report?.["permission_sets"] as Grant[] | undefined) ?? [];
  const profiles = (report?.["profiles"] as Grant[] | undefined) ?? [];
  const groups = (report?.["permission_set_groups"] as Group[] | undefined) ?? [];

  return (
    <div>
      <div className="row">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {["Field", "SObject", "ApexClass", "VisualforcePage", "RecordType"].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <input
          placeholder={type === "Field" ? "Object__c.Field__c" : "ApiName"}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
        />
        <button onClick={() => void run()}>Who has access?</button>
      </div>
      {loading && <p role="status">Loading…</p>}
      {report?.["error"] != null && <p style={{ color: "#ef4444" }}>{String(report["error"])}</p>}
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
