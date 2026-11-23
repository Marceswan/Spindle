import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { discoverApexFiles } from "../../src/pipeline/discover.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";

setDefaultTimeout(30_000);

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

describe("discoverApexFiles layouts", () => {
  let dir: string;

  const put = (rel: string, body = ""): void => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  const manifest = (...paths: string[]): void =>
    put("sfdx-project.json", JSON.stringify({ packageDirectories: paths.map(path => ({ path })) }));
  const pairs = async (): Promise<string[]> =>
    (await discoverApexFiles(dir)).map(f => `${f.kind} ${f.relativePath}`).sort();

  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), "spindle-disc-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("finds a class under a package directory with a different inner layout", async () => {
    manifest("force-app");
    put("force-app/feature-x/classes/Foo.cls", "public class Foo {}");
    expect(await pairs()).toEqual(["apex-class force-app/feature-x/classes/Foo.cls"]);
  });

  test("finds a class in a subfolder of the classes folder", async () => {
    manifest("force-app");
    put("force-app/main/default/classes/services/Foo.cls", "public class Foo {}");
    expect(await pairs()).toEqual(["apex-class force-app/main/default/classes/services/Foo.cls"]);
  });

  test("finds a class when the package directory has no main/default", async () => {
    manifest("src");
    put("src/classes/A.cls", "public class A {}");
    expect(await pairs()).toEqual(["apex-class src/classes/A.cls"]);
  });

  test("an LWC bundle with __tests__ is one bundle and the test file is not a bundle file", async () => {
    manifest("force-app");
    put("force-app/main/default/lwc/card/card.js", "export default class Card {}");
    put("force-app/main/default/lwc/card/card.html", "<template></template>");
    put("force-app/main/default/lwc/card/__tests__/card.test.js", "test");
    const files = await discoverApexFiles(dir);
    expect(files).toHaveLength(1);
    const bundle = files[0]!;
    expect(bundle.kind).toBe("lwc-bundle");
    expect(bundle.bundleName).toBe("card");
    expect(bundle.bundleFiles?.map(f => f.fileName).sort()).toEqual(["card.html", "card.js"]);
  });

  test("does not read a classes folder inside node_modules or a dot directory", async () => {
    manifest("force-app");
    put("force-app/node_modules/pkg/classes/Bad1.cls");
    put("force-app/.sfdx/classes/Bad2.cls");
    put("force-app/main/default/classes/Good.cls");
    expect(await pairs()).toEqual(["apex-class force-app/main/default/classes/Good.cls"]);
  });

  test("overlapping package directories give each file once", async () => {
    manifest("force-app", "force-app/main");
    put("force-app/main/default/classes/Foo.cls");
    const files = await discoverApexFiles(dir);
    expect(files.map(f => f.relativePath)).toEqual(["force-app/main/default/classes/Foo.cls"]);
  });

  test("email templates in nested folders carry the folder path in parentSObject", async () => {
    manifest("force-app");
    put("force-app/main/default/email/Top/T.email-meta.xml", "<x/>");
    put("force-app/main/default/email/a/b/N.email-meta.xml", "<x/>");
    put("force-app/main/default/email/a/b/N.email", "body");
    const files = (await discoverApexFiles(dir)).sort((x, y) => (x.relativePath < y.relativePath ? -1 : 1));
    expect(files.map(f => [f.relativePath, f.parentSObject])).toEqual([
      ["force-app/main/default/email/Top/T.email-meta.xml", "Top"],
      ["force-app/main/default/email/a/b/N.email-meta.xml", "a/b"],
    ]);
  });

  test("an email body edit changes the content hash", async () => {
    manifest("force-app");
    put("force-app/main/default/email/F/N.email-meta.xml", "<x/>");
    put("force-app/main/default/email/F/N.email", "one");
    const before = (await discoverApexFiles(dir))[0]!.contentHash;
    put("force-app/main/default/email/F/N.email", "two");
    expect((await discoverApexFiles(dir))[0]!.contentHash).not.toBe(before);
  });

  test("object children keep parentSObject and are not mistaken for type folders", async () => {
    manifest("force-app");
    put("force-app/main/default/objects/Foo__c/Foo__c.object-meta.xml");
    put("force-app/main/default/objects/Foo__c/fields/Bar__c.field-meta.xml");
    const files = await discoverApexFiles(dir);
    expect(files.map(f => `${f.kind} ${f.parentSObject ?? "-"}`).sort()).toEqual([
      "field-meta Foo__c",
      "sobject-meta -",
    ]);
  });

  test("result order is deterministic", async () => {
    manifest("force-app");
    for (const n of ["C", "A", "B"]) put(`force-app/main/default/classes/${n}.cls`);
    const first = (await discoverApexFiles(dir)).map(f => f.relativePath);
    expect(first).toEqual([...first].sort());
  });

  test("the sample project yields exactly the expected files", async () => {
    const files = await discoverApexFiles(FIXTURE_DIR);
    const base = "force-app/main/default";
    const expected = [
      ["aura-bundle", `${base}/aura/customerPanel`],
      ["apex-class", `${base}/classes/AccountService.cls`],
      ["apex-class", `${base}/classes/BaseService.cls`],
      ["apex-class", `${base}/classes/Cleanable.cls`],
      ["apex-class", `${base}/classes/CustomerLookup.cls`],
      ["apex-class", `${base}/classes/Orchestrator.cls`],
      ["email-template", `${base}/email/Marketing/CustomerWelcome.email-meta.xml`],
      ["flexipage", `${base}/flexipages/Customer_Record_Page.flexipage-meta.xml`],
      ["flow", `${base}/flows/Customer_Onboarding.flow-meta.xml`],
      ["custom-labels", `${base}/labels/CustomLabels.labels-meta.xml`],
      ["layout", `${base}/layouts/Customer__c-Customer Layout.layout-meta.xml`],
      ["lwc-bundle", `${base}/lwc/customerCard`],
      ["sobject-meta", `${base}/objects/Customer__c/Customer__c.object-meta.xml`],
      ["field-meta", `${base}/objects/Customer__c/fields/Email__c.field-meta.xml`],
      ["field-meta", `${base}/objects/Customer__c/fields/Tier__c.field-meta.xml`],
      ["validation-rule-meta", `${base}/objects/Customer__c/validationRules/Email_Required.validationRule-meta.xml`],
      ["vf-page", `${base}/pages/CustomerEditor.page`],
      ["permission-set-group", `${base}/permissionsetgroups/Spindle_PowerUsers.permissionsetgroup-meta.xml`],
      ["permission-set", `${base}/permissionsets/Spindle_Editor.permissionset-meta.xml`],
      ["permission-set", `${base}/permissionsets/Spindle_Reader.permissionset-meta.xml`],
      ["profile", `${base}/profiles/Spindle_Test_User.profile-meta.xml`],
      ["static-resource", `${base}/staticresources/CompanyLogo.resource-meta.xml`],
      ["apex-trigger", `${base}/triggers/AccountTrigger.trigger`],
    ];
    expect(files.map(f => [f.kind, f.relativePath]).sort()).toEqual([...expected].sort());
    expect(files).toHaveLength(23);
  });

  test("indexProject creates the ApexClass node for a class in a non-default layout", async () => {
    manifest("force-app");
    put("force-app/feature-x/classes/Foo.cls", "public class Foo { public void run() {} }");
    const store = new GraphStore(":memory:");
    try {
      await indexProject(dir, store, { mode: "full" });
      const rows = store.db
        .query<{ qualified_name: string }, []>("SELECT qualified_name FROM nodes WHERE label = 'ApexClass'")
        .all();
      expect(rows.map(r => r.qualified_name)).toEqual(["Foo"]);
    } finally {
      store.close();
    }
  });
});
