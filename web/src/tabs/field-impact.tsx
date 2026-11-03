import { useState } from "react";
import {useRequestEpoch} from "../request-epoch.ts";
import { api } from "../api.ts";

const BUCKETS: [string, string][] = [
  ["apex_methods", "Apex"],
  ["lwc_bundles", "LWC"],
  ["vf_pages", "VF Pages"],
  ["vf_components", "VF Components"],
  ["validation_rules", "Validation Rules"],
  ["layouts", "Layouts / FlexiPages"],
  ["flows", "Flows"],
  ["ui_bundles", "UI Bundles"],
  ["permission_sets", "Permission Sets"],
  ["formula_fields", "Formula Fields"],
];

type Usage = { qualified_name: string; file_path: string | null; context: string };

export function FieldImpact({ project }: { project: number }): JSX.Element {
  const [field, setField] = useState("");
  const [report, setReport] = useState<Record<string, unknown> | null>(null);

  const begin = useRequestEpoch();
  const [loading, setLoading] = useState(false);
  async function run(): Promise<void> {
    const current = begin();
    setReport(null); setLoading(true);
    try { const result = await api.fieldUsage(project, field); if (current()) setReport(result); }
    catch (error) { if (current()) setReport({error: (error as Error).message}); }
    finally { if (current()) setLoading(false); }
  }

  return (
    <div>
      <div className="row">
        <input
          placeholder="Object__c.Field__c"
          value={field}
          onChange={(e) => setField(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
        />
        <button onClick={() => void run()}>Impact</button>
      </div>
      {loading && <p role="status">Loading…</p>}
      {report?.["error"] != null && <p style={{ color: "#ef4444" }}>{String(report["error"])}</p>}
      {report &&
        report["error"] == null &&
        BUCKETS.map(([key, label]) => {
          const items = report[key] as Usage[] | undefined;
          if (!items || items.length === 0) return null;
          return (
            <div key={key}>
              <h3>
                {label} ({items.length})
              </h3>
              <table>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={i}>
                      <td>{it.qualified_name}</td>
                      <td>{it.context}</td>
                      <td>
                        <code>{it.file_path ?? ""}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
    </div>
  );
}
