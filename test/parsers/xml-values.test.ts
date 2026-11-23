// XML value typing: text stays text, flags are booleans, numeric properties are numbers.
import { describe, expect, test } from "bun:test";

import { parseCustomLabels } from "../../src/parsers/metadata-xml/custom-labels.ts";
import { parseEmailTemplate } from "../../src/parsers/metadata-xml/email-template.ts";
import { parseFieldMeta } from "../../src/parsers/metadata-xml/field.ts";
import { parseFlexiPage } from "../../src/parsers/metadata-xml/flexipage.ts";
import { parseFlow } from "../../src/parsers/metadata-xml/flow.ts";
import { parseLayout } from "../../src/parsers/metadata-xml/layout.ts";
import { parseObjectMeta } from "../../src/parsers/metadata-xml/object.ts";
import { parsePermissionSetGroup } from "../../src/parsers/metadata-xml/permission-set-group.ts";
import { parsePermissionSetOrProfile } from "../../src/parsers/metadata-xml/permission-set.ts";
import { parseRecordTypeMeta } from "../../src/parsers/metadata-xml/record-type.ts";
import { parseStaticResource } from "../../src/parsers/metadata-xml/static-resource.ts";
import { parseValidationRuleMeta } from "../../src/parsers/metadata-xml/validation-rule.ts";

const xml = (root: string, body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="http://soap.sforce.com/2006/04/metadata">${body}</${root}>`;

describe("field values", () => {
  test("picklist values stay text exactly as written", () => {
    const body = ["001", "1e3", "0x1F", "true"]
      .map((v) => `<value><fullName>${v}</fullName><label>${v}</label></value>`)
      .join("");
    const src = xml(
      "CustomField",
      `<fullName>Pick__c</fullName><type>Picklist</type><valueSet><valueSetDefinition><sorted>false</sorted>${body}</valueSetDefinition></valueSet>`,
    );
    const node = parseFieldMeta("/x/Pick__c.field-meta.xml", src, "Obj__c").nodes[0];
    expect(node?.properties?.picklistValues).toEqual(["001", "1e3", "0x1F", "true"]);
  });

  test("length, precision, scale are numbers and flags are booleans", () => {
    const src = xml(
      "CustomField",
      "<fullName>N__c</fullName><type>Number</type><length>255</length><precision>18</precision><scale>2</scale><required>true</required><unique>false</unique>",
    );
    const p = parseFieldMeta("/x/N__c.field-meta.xml", src, "Obj__c").nodes[0]?.properties;
    expect(p?.length).toBe(255);
    expect(p?.precision).toBe(18);
    expect(p?.scale).toBe(2);
    expect(p?.required).toBe(true);
    expect(p?.unique).toBe(false);
    expect(p?.externalId).toBe(false);
  });

  test("absent numerics are null", () => {
    const src = xml("CustomField", "<fullName>T__c</fullName><type>Text</type>");
    const p = parseFieldMeta("/x/T__c.field-meta.xml", src, "Obj__c").nodes[0]?.properties;
    expect(p?.length).toBeNull();
    expect(p?.precision).toBeNull();
    expect(p?.scale).toBeNull();
  });

  test("a numeric formula is text and marks the field as formula", () => {
    const src = xml("CustomField", "<fullName>F__c</fullName><type>Number</type><formula>1</formula>");
    const p = parseFieldMeta("/x/F__c.field-meta.xml", src, "Obj__c").nodes[0]?.properties;
    expect(p?.formula).toBe("1");
    expect(p?.isFormula).toBe(true);
  });

  test("text properties that look like numbers stay text", () => {
    const src = xml(
      "CustomField",
      "<fullName>D__c</fullName><label>2024</label><type>Text</type><description>007</description>",
    );
    const p = parseFieldMeta("/x/D__c.field-meta.xml", src, "Obj__c").nodes[0]?.properties;
    expect(p?.label).toBe("2024");
  });
});

describe("validation rule values", () => {
  test("formula that is only true does not throw and stays text", () => {
    const src = xml(
      "ValidationRule",
      "<fullName>Always</fullName><active>true</active><errorConditionFormula>true</errorConditionFormula><errorMessage>no</errorMessage>",
    );
    const r = parseValidationRuleMeta("/x/Always.validationRule-meta.xml", src, "Obj__c");
    expect(r.warnings).toEqual([]);
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]?.properties?.formula).toBe("true");
  });

  test("numeric formula and message stay text", () => {
    const src = xml(
      "ValidationRule",
      "<fullName>Num</fullName><errorConditionFormula>1</errorConditionFormula><errorMessage>404</errorMessage>",
    );
    const r = parseValidationRuleMeta("/x/Num.validationRule-meta.xml", src, "Obj__c");
    expect(r.nodes[0]?.properties?.formula).toBe("1");
    expect(r.nodes[0]?.properties?.errorMessage).toBe("404");
  });

  test("active false is the boolean false; absent active defaults to true", () => {
    const off = parseValidationRuleMeta(
      "/x/Off.validationRule-meta.xml",
      xml("ValidationRule", "<fullName>Off</fullName><active>false</active><errorConditionFormula>A__c</errorConditionFormula>"),
      "Obj__c",
    );
    expect(off.nodes[0]?.properties?.active).toBe(false);
    const dflt = parseValidationRuleMeta(
      "/x/D.validationRule-meta.xml",
      xml("ValidationRule", "<fullName>D</fullName><errorConditionFormula>A__c</errorConditionFormula>"),
      "Obj__c",
    );
    expect(dflt.nodes[0]?.properties?.active).toBe(true);
  });
});

describe("custom label values", () => {
  test("numeric and boolean looking values are text", () => {
    const src = xml(
      "CustomLabels",
      "<labels><fullName>Hundred</fullName><value>100</value><language>en_US</language><protected>false</protected><shortDescription>1</shortDescription></labels>" +
        "<labels><fullName>Yes</fullName><value>true</value><language>en_US</language><protected>true</protected></labels>",
    );
    const nodes = parseCustomLabels("/x/CustomLabels.labels-meta.xml", src).nodes;
    expect(nodes[0]?.properties?.value).toBe("100");
    expect(nodes[0]?.properties?.shortDescription).toBe("1");
    expect(nodes[0]?.properties?.protected).toBe(false);
    expect(nodes[1]?.properties?.value).toBe("true");
    expect(nodes[1]?.properties?.protected).toBe(true);
  });

  test("a numeric label name is kept as text", () => {
    const src = xml("CustomLabels", "<labels><fullName>007</fullName><value>x</value></labels>");
    const node = parseCustomLabels("/x/CustomLabels.labels-meta.xml", src).nodes[0];
    expect(node?.name).toBe("007");
    expect(node?.qualifiedName).toBe("c.007");
  });
});

describe("permission set values", () => {
  const src = xml(
    "PermissionSet",
    "<label>2024</label><description>true</description><hasActivationRequired>false</hasActivationRequired>" +
      "<classAccesses><apexClass>Svc</apexClass><enabled>true</enabled></classAccesses>" +
      "<objectPermissions><object>Obj__c</object><allowRead>true</allowRead><allowCreate>false</allowCreate></objectPermissions>" +
      "<fieldPermissions><field>Obj__c.F__c</field><readable>true</readable><editable>false</editable></fieldPermissions>" +
      "<userPermissions><name>ApiEnabled</name><enabled>true</enabled></userPermissions>",
  );
  const r = parsePermissionSetOrProfile("/x/PS.permissionset-meta.xml", src, "permission-set");

  test("label and description are text", () => {
    expect(r.nodes[0]?.properties?.label).toBe("2024");
    expect(r.nodes[0]?.properties?.description).toBe("true");
    expect(r.nodes[0]?.properties?.hasActivationRequired).toBe(false);
  });

  test("access flags on edges are booleans", () => {
    const cls = r.edges.find((e) => e.toQName === "Svc");
    expect(cls?.properties?.enabled).toBe(true);
    const obj = r.edges.find((e) => e.toQName === "Obj__c");
    expect(obj?.properties?.read).toBe(true);
    expect(obj?.properties?.create).toBe(false);
    expect(obj?.properties?.edit).toBe(false);
    const fld = r.edges.find((e) => e.toQName === "Obj__c.F__c");
    expect(fld?.properties?.read).toBe(true);
    expect(fld?.properties?.edit).toBe(false);
    expect(r.nodes[0]?.properties?.userPermissions).toEqual([{ name: "ApiEnabled", enabled: true }]);
  });

  test("permission set group description is text and numeric member names stay text", () => {
    const g = parsePermissionSetGroup(
      "/x/G.permissionsetgroup-meta.xml",
      xml("PermissionSetGroup", "<description>123</description><permissionSets>007</permissionSets><status>Updated</status>"),
    );
    expect(g.nodes[0]?.properties?.description).toBe("123");
    expect(g.edges[0]?.toQName).toBe("007");
  });
});

describe("object, record type, static resource values", () => {
  test("object text and flags", () => {
    const r = parseObjectMeta(
      "/x/Obj__c.object-meta.xml",
      xml("CustomObject", "<label>2024</label><description>1</description><enableHistory>true</enableHistory><enableSearch>false</enableSearch>"),
      "Obj__c",
    );
    const p = r.nodes[0]?.properties;
    expect(p?.label).toBe("2024");
    expect(p?.description).toBe("1");
    expect(p?.enableHistory).toBe(true);
    expect(p?.enableSearch).toBe(false);
    expect(p?.enableReports).toBeNull();
  });

  test("record type label is text and active is boolean", () => {
    const r = parseRecordTypeMeta(
      "/x/RT.recordType-meta.xml",
      xml("RecordType", "<fullName>RT</fullName><label>100</label><active>false</active><description>true</description>"),
      "Obj__c",
    );
    const p = r.nodes[0]?.properties;
    expect(p?.label).toBe("100");
    expect(p?.active).toBe(false);
    expect(p?.description).toBe("true");
  });

  test("static resource description is text", () => {
    const r = parseStaticResource(
      "/x/Res.resource-meta.xml",
      xml("StaticResource", "<contentType>application/zip</contentType><cacheControl>Private</cacheControl><description>2</description>"),
    );
    expect(r.nodes[0]?.properties?.description).toBe("2");
  });
});

describe("flow values", () => {
  test("apiVersion is a number; label and trigger text stay text", () => {
    const r = parseFlow(
      "/x/F.flow-meta.xml",
      xml("Flow", "<apiVersion>60.0</apiVersion><label>2024</label><status>Active</status><processType>AutoLaunchedFlow</processType>"),
    );
    const p = r.nodes[0]?.properties;
    expect(p?.apiVersion).toBe(60);
    expect(p?.label).toBe("2024");
  });

  test("absent apiVersion is null", () => {
    const r = parseFlow("/x/F.flow-meta.xml", xml("Flow", "<label>L</label>"));
    expect(r.nodes[0]?.properties?.apiVersion).toBeNull();
  });

  test("numeric-looking reference values are not field references", () => {
    const r = parseFlow(
      "/x/F.flow-meta.xml",
      xml(
        "Flow",
        "<start><object>Account</object><triggerType>RecordAfterSave</triggerType></start>" +
          "<recordUpdates><name>U</name><object>Account</object><inputAssignments><field>001</field><value><elementReference>1.5</elementReference></value></inputAssignments></recordUpdates>",
      ),
    );
    expect(r.edges.filter((e) => e.edgeType === "FLOW_USES_FIELD")).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("layout values", () => {
  test("empty space items are skipped and field names stay text", () => {
    const r = parseLayout(
      "/x/Obj__c-Layout.layout-meta.xml",
      xml(
        "Layout",
        "<layoutSections><layoutColumns>" +
          "<layoutItems><emptySpace>true</emptySpace></layoutItems>" +
          "<layoutItems><behavior>Edit</behavior><field>Name</field></layoutItems>" +
          "</layoutColumns></layoutSections>",
      ),
    );
    expect(r.edges.map((e) => e.toQName)).toEqual(["Obj__c.Name"]);
  });
});

describe("flexipage and email template values", () => {
  test("flexipage master label is text", () => {
    const r = parseFlexiPage(
      "/x/Page.flexipage-meta.xml",
      xml("FlexiPage", "<masterLabel>2024</masterLabel><type>RecordPage</type><sobjectType>Obj__c</sobjectType>"),
    );
    expect(r.nodes[0]?.properties?.masterLabel).toBe("2024");
  });

  test("email template subject and name are text; apiVersion is a number; available is boolean", () => {
    const r = parseEmailTemplate(
      "/nonexistent/T.email-meta.xml",
      xml("EmailTemplate", "<name>100</name><subject>2024</subject><apiVersion>60.0</apiVersion><available>true</available><type>html</type>"),
      "Folder",
    );
    const p = r.nodes[0]?.properties;
    expect(p?.label).toBe("100");
    expect(p?.subject).toBe("2024");
    expect(p?.apiVersion).toBe(60);
    expect(p?.available).toBe(true);
  });
});
