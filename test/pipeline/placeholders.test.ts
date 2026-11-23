// Placeholder nodes for unresolved SObject and Field targets (pass 2).
// A project often has no metadata for standard objects and fields. Edges to them must not
// be lost: pass 2 creates a placeholder node (isPlaceholder, no file) and writes the edge.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { handler as fieldUsage } from "../../src/tools/get-field-usage.ts";
import { handler as permissionAccess } from "../../src/tools/get-permission-access.ts";

setDefaultTimeout(30_000);

const BASE = "force-app/main/default";

const permSet = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>PS</label>
${body}
</PermissionSet>
`;
const objPerm = (object: string): string =>
  `    <objectPermissions><object>${object}</object><allowRead>true</allowRead><allowCreate>false</allowCreate><allowEdit>false</allowEdit><allowDelete>false</allowDelete></objectPermissions>`;
const fieldPerm = (field: string): string =>
  `    <fieldPermissions><field>${field}</field><readable>true</readable><editable>false</editable></fieldPermissions>`;
const flowOn = (object: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <label>F</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start><object>${object}</object><triggerType>RecordAfterSave</triggerType><recordTriggerType>CreateAndUpdate</recordTriggerType></start>
</Flow>
`;
const apexClass = (name: string, body: string): string => `public class ${name} {\n  public static void run() {\n    ${body}\n  }\n}\n`;
const clsMeta = `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>
`;

describe("placeholder nodes for unresolved SObject and Field targets", () => {
  let dir: string;
  let store: GraphStore;
  let projectId: number;

  const write = (rel: string, content: string): void => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const full = async (): Promise<void> => {
    await indexProject(dir, store, { mode: "full" });
    projectId = store.db.query<{ id: number }, []>("SELECT id FROM projects").get()!.id;
  };
  const incremental = async (): Promise<void> => { await indexProject(dir, store, { mode: "incremental" }); };

  type NodeRow = { id: number; label: string; qualified_name: string; name: string; file_path: string | null; ph: number | null; parent: string | null };
  const nodes = (label: string): NodeRow[] =>
    store.db.query<NodeRow, [string]>(
      `SELECT id, label, qualified_name, name, file_path,
              json_extract(properties, '$.isPlaceholder') ph, json_extract(properties, '$.parentSObject') parent
       FROM nodes WHERE label = ? ORDER BY qualified_name`,
    ).all(label);
  const node = (label: string, qname: string): NodeRow | undefined => nodes(label).find((n) => n.qualified_name === qname);
  const edges = (type: string): string[] =>
    store.db.query<{ s: string; d: string }, [string]>(
      `SELECT s.qualified_name s, d.label || ':' || d.qualified_name d
       FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes d ON d.id = e.target_id
       WHERE e.edge_type = ? ORDER BY 1, 2`,
    ).all(type).map((r) => `${r.s} -> ${r.d}`);

  beforeEach(() => {
    dir = join(realpathSync(tmpdir()), `spindle-ph-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], sourceApiVersion: "62.0" }));
    store = new GraphStore(join(dir, "graph.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a permission set on a standard object and field creates both placeholders and both grants", async () => {
    write(`${BASE}/permissionsets/Reader.permissionset-meta.xml`, permSet(`${objPerm("Account")}\n${fieldPerm("Account.Name")}`));
    await full();

    const account = node("SObject", "Account")!;
    const name = node("Field", "Account.Name")!;
    expect(account.ph).toBe(1);
    expect(account.file_path).toBeNull();
    expect(name.ph).toBe(1);
    expect(name.file_path).toBeNull();
    expect(name.name).toBe("Name");
    expect(name.parent).toBe("Account");
    expect(edges("GRANTS_OBJECT_ACCESS")).toEqual(["Reader -> SObject:Account"]);
    expect(edges("GRANTS_FIELD_ACCESS")).toEqual(["Reader -> Field:Account.Name"]);

    const obj = (await permissionAccess({ project_id: projectId, target: { type: "SObject", qualified_name: "Account" } }, store)) as { permission_sets: { source_qualified_name: string }[] };
    expect(obj.permission_sets.map((g) => g.source_qualified_name)).toEqual(["Reader"]);
    const fld = (await permissionAccess({ project_id: projectId, target: { type: "Field", qualified_name: "Account.Name" } }, store)) as { permission_sets: { source_qualified_name: string }[] };
    expect(fld.permission_sets.map((g) => g.source_qualified_name)).toEqual(["Reader"]);
  });

  test("a field placeholder does not create a placeholder for its parent object", async () => {
    write(`${BASE}/permissionsets/Reader.permissionset-meta.xml`, permSet(fieldPerm("Account.Name")));
    await full();
    expect(node("Field", "Account.Name")).toBeDefined();
    expect(node("SObject", "Account")).toBeUndefined();
  });

  test("a record-triggered flow on a standard object keeps its FLOW_DML_ON edge", async () => {
    write(`${BASE}/flows/Case_Flow.flow-meta.xml`, flowOn("Case"));
    await full();
    expect(edges("FLOW_DML_ON")).toEqual(["Case_Flow -> SObject:Case"]);
    expect(node("SObject", "Case")!.ph).toBe(1);
  });

  test("an Apex query on a standard field gets a REFERENCES_FIELD edge, found by get_field_usage in any case", async () => {
    write(`${BASE}/classes/Q.cls`, apexClass("Q", "List<Account> a = [SELECT Name FROM Account];"));
    write(`${BASE}/classes/Q.cls-meta.xml`, clsMeta);
    await full();

    expect(edges("REFERENCES_FIELD")).toEqual(["Q.run()" + " -> Field:Account.Name"]);
    expect(node("Field", "Account.Name")!.ph).toBe(1);

    for (const field of ["Account.Name", "account.name", "ACCOUNT.NAME"]) {
      const report = (await fieldUsage({ project_id: projectId, field }, store)) as { apex_methods: { qualified_name: string }[] };
      expect(report.apex_methods.map((m) => m.qualified_name)).toContain("Q.run()");
    }
  });

  test("regex-tier references create no placeholder", async () => {
    write(`${BASE}/pages/P.page`, `<apex:page standardController="Account"><apex:outputField value="{!acct.Name}"/><apex:outputField value="{!Account.Phone}"/></apex:page>`);
    write(`${BASE}/pages/P.page-meta.xml`, `<?xml version="1.0" encoding="UTF-8"?><ApexPage xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><label>P</label></ApexPage>`);
    await full();
    expect(nodes("VisualforcePage").length).toBe(1);
    expect(nodes("Field")).toEqual([]);
    expect(edges("VF_USES_FIELD")).toEqual([]);
  });

  test("references that differ in case give one node", async () => {
    write(`${BASE}/permissionsets/A.permissionset-meta.xml`, permSet(`${objPerm("Account")}\n${fieldPerm("Account.Name")}`));
    write(`${BASE}/permissionsets/B.permissionset-meta.xml`, permSet(`${objPerm("account")}\n${fieldPerm("account.name")}`));
    await full();
    expect(nodes("SObject").map((n) => n.qualified_name.toLowerCase())).toEqual(["account"]);
    expect(nodes("Field").map((n) => n.qualified_name.toLowerCase())).toEqual(["account.name"]);
    expect(edges("GRANTS_OBJECT_ACCESS").length).toBe(2);
    expect(edges("GRANTS_FIELD_ACCESS").length).toBe(2);
  });

  test("a reference in another case resolves to a real node", async () => {
    write(`${BASE}/objects/Account/Account.object-meta.xml`, `<?xml version="1.0" encoding="UTF-8"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Account</label></CustomObject>`);
    write(`${BASE}/objects/Account/fields/Name.field-meta.xml`, `<?xml version="1.0" encoding="UTF-8"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Name</fullName><label>Name</label><type>Text</type></CustomField>`);
    write(`${BASE}/permissionsets/B.permissionset-meta.xml`, permSet(`${objPerm("account")}\n${fieldPerm("account.name")}`));
    await full();
    expect(nodes("SObject").map((n) => [n.qualified_name, n.ph])).toEqual([["Account", 0]]);
    expect(nodes("Field").map((n) => n.qualified_name)).toEqual(["Account.Name"]);
    expect(edges("GRANTS_FIELD_ACCESS")).toEqual(["B -> Field:Account.Name"]);
  });

  test("incremental: placeholder appears, disappears with its last reference, and becomes real with the same id", async () => {
    const permPath = `${BASE}/permissionsets/Reader.permissionset-meta.xml`;
    // (a) full index
    write(permPath, permSet(`${objPerm("Account")}\n${fieldPerm("Account.Name")}`));
    await full();
    const fieldId = node("Field", "Account.Name")!.id;
    expect(node("Field", "Account.Name")!.ph).toBe(1);

    // (b) the reference to the field goes away; the field placeholder goes with it, the object stays
    write(permPath, permSet(objPerm("Account")));
    await incremental();
    expect(node("Field", "Account.Name")).toBeUndefined();
    expect(node("SObject", "Account")!.ph).toBe(1);
    // the file goes away; the last placeholder goes with it
    rmSync(join(dir, permPath));
    await incremental();
    expect(nodes("SObject")).toEqual([]);
    expect(nodes("Field")).toEqual([]);

    // the reference comes back
    write(permPath, permSet(`${objPerm("Account")}\n${fieldPerm("Account.Name")}`));
    await incremental();
    const placeholderId = node("Field", "Account.Name")!.id;
    expect(node("Field", "Account.Name")!.ph).toBe(1);
    expect(fieldId).toBeGreaterThan(0);

    // (c) metadata for the field and the object is added later
    write(`${BASE}/objects/Account/Account.object-meta.xml`, `<?xml version="1.0" encoding="UTF-8"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Account</label></CustomObject>`);
    write(`${BASE}/objects/Account/fields/Name.field-meta.xml`, `<?xml version="1.0" encoding="UTF-8"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Name</fullName><label>Name</label><type>Text</type></CustomField>`);
    await incremental();
    const real = node("Field", "Account.Name")!;
    expect(real.id).toBe(placeholderId);
    expect(real.ph).not.toBe(1);
    expect(real.file_path).toEndWith("Name.field-meta.xml");
    expect(node("SObject", "Account")!.ph).toBe(0);
    expect(edges("GRANTS_FIELD_ACCESS")).toEqual(["Reader -> Field:Account.Name"]);
    expect(edges("GRANTS_OBJECT_ACCESS")).toEqual(["Reader -> SObject:Account"]);
  });

  test("incremental: a placeholder in another spelling merges into the real node that arrives later", async () => {
    write(`${BASE}/permissionsets/Reader.permissionset-meta.xml`, permSet(fieldPerm("account.name")));
    await full();
    expect(node("Field", "account.name")!.ph).toBe(1);

    write(`${BASE}/objects/Account/Account.object-meta.xml`, `<?xml version="1.0" encoding="UTF-8"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Account</label></CustomObject>`);
    write(`${BASE}/objects/Account/fields/Name.field-meta.xml`, `<?xml version="1.0" encoding="UTF-8"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Name</fullName><label>Name</label><type>Text</type></CustomField>`);
    await incremental();
    expect(nodes("Field").map((n) => [n.qualified_name, n.ph === 1])).toEqual([["Account.Name", false]]);
    expect(edges("GRANTS_FIELD_ACCESS")).toEqual(["Reader -> Field:Account.Name"]);
  });

  test("an incremental index gives the same graph as a full index", async () => {
    write(`${BASE}/permissionsets/Reader.permissionset-meta.xml`, permSet(`${objPerm("Account")}\n${fieldPerm("Account.Name")}`));
    write(`${BASE}/flows/Case_Flow.flow-meta.xml`, flowOn("Case"));
    write(`${BASE}/classes/Q.cls`, apexClass("Q", "List<Account> a = [SELECT Name FROM Account];"));
    write(`${BASE}/classes/Q.cls-meta.xml`, clsMeta);
    await full();
    const snapshot = (): string[] => store.db.query<{ x: string }, []>(
      `SELECT e.edge_type || ' ' || s.qualified_name || ' -> ' || d.label || ':' || d.qualified_name x
       FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes d ON d.id = e.target_id ORDER BY 1`,
    ).all().map((r) => r.x);
    const nodeSet = (): string[] => store.db.query<{ x: string }, []>("SELECT label || ':' || qualified_name x FROM nodes ORDER BY 1").all().map((r) => r.x);
    const before = snapshot();
    const beforeNodes = nodeSet();
    write(`${BASE}/classes/Q.cls`, apexClass("Q", "List<Account> a = [SELECT Name FROM Account]; // touched"));
    await incremental();
    expect(snapshot()).toEqual(before);
    expect(nodeSet()).toEqual(beforeNodes);
  });

  test("a SOQL relationship path that needs relationship metadata creates no field placeholder", async () => {
    write(`${BASE}/classes/Q.cls`, apexClass("Q", "List<Account> a = [SELECT Owner.Name, Name FROM Account];"));
    write(`${BASE}/classes/Q.cls-meta.xml`, clsMeta);
    await full();
    expect(nodes("Field").map((n) => n.qualified_name)).toEqual(["Account.Name"]);
    expect(edges("REFERENCES_FIELD")).toEqual(["Q.run() -> Field:Account.Name"]);
  });
});
