// Generates a larger SFDX project for the skill evals: a billing domain with about 200
// Apex classes plus objects, LWCs, flows, layouts and permission sets. The output is fixed
// (no random values), and the true answers to the eval questions are known by construction.
//
// Each question has decoys that a text search hits: a field with the same name on another
// object, a method with the same name in another class, and the target name in comments
// and strings. An answer is correct only if it has the true items and none of the decoys.
//
//   bun run scale-project.ts <directory>

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ScaleTruth = {
  // "Class.method" of each Apex method that reaches BillingCore.applyCredit, by call distance.
  callersHop1: string[];
  callersHop2: string[];
  callersHop3: string[];
  callerDecoys: string[];
  // Components that refer to the field Invoice__c.Balance__c.
  fieldUsers: { apex: string[]; lwc: string[]; flows: string[]; layouts: string[]; flexipages: string[]; validationRules: string[]; emailTemplates: string[] };
  fieldAccess: { edit: string[]; readOnly: string[] };
  fieldDecoys: string[];
};

const FILLER_CLASSES = 180;
const API_VERSION = "62.0";

const CLASS_META = `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>${API_VERSION}</apiVersion>
    <status>Active</status>
</ApexClass>
`;

// class -> method -> body lines. Each method is `public static void name()`, except where
// a signature is given.
type MethodSpec = { signature?: string; body: string[] };
const classes = new Map<string, Map<string, MethodSpec>>();
function method(className: string, name: string, body: string[], signature?: string): void {
  const methods = classes.get(className) ?? new Map<string, MethodSpec>();
  methods.set(name, { body, ...(signature ? { signature } : {}) });
  classes.set(className, methods);
}

// --- The call graph around BillingCore.applyCredit ------------------------------------

method("BillingCore", "applyCredit", [
  "Invoice__c inv = [SELECT Id, Balance__c FROM Invoice__c LIMIT 1];",
  "System.debug('credit ' + amount + ' on ' + inv.Id);",
], "public static void applyCredit(Decimal amount)");
// An unqualified call in the same class.
method("BillingCore", "applyBulk", ["applyCredit(10);"]);

const HOP1: [string, string][] = [
  ["InvoiceService", "finalize"], ["RefundProcessor", "issueRefund"],
  ["CreditNoteJob", "execute"], ["DisputeResolver", "settle"],
];
for (const [c, m] of HOP1) method(c, m, ["BillingCore.applyCredit(25);"]);
// finalize() also reads the field.
method("InvoiceService", "finalize", [
  "Invoice__c inv = [SELECT Id, Balance__c FROM Invoice__c WHERE Status__c = 'Open' LIMIT 1];",
  "BillingCore.applyCredit(inv.Balance__c);",
]);

// caller -> callee
const HOP2: [string, string, string, string][] = [
  ["InvoiceController", "close", "InvoiceService", "finalize"],
  ["BatchCloser", "closeAll", "InvoiceService", "finalize"],
  ["RefundController", "submit", "RefundProcessor", "issueRefund"],
  ["ChargebackHandler", "reverse", "RefundProcessor", "issueRefund"],
  ["CreditScheduler", "runNightly", "CreditNoteJob", "execute"],
  ["DisputeController", "accept", "DisputeResolver", "settle"],
  ["InvoiceService", "finalizeDisputed", "DisputeResolver", "settle"],
  ["MigrationRunner", "backfill", "BillingCore", "applyBulk"],
];
const HOP3: [string, string, string, string][] = [
  ["OrderPipeline", "complete", "InvoiceController", "close"],
  ["NightlyOps", "run", "BatchCloser", "closeAll"],
  ["SupportConsole", "refund", "RefundController", "submit"],
  ["BankFeedListener", "onChargeback", "ChargebackHandler", "reverse"],
  ["SupportConsole", "resolveDispute", "DisputeController", "accept"],
  ["InvoiceController", "closeDisputed", "InvoiceService", "finalizeDisputed"],
  ["AdminTools", "runMigration", "MigrationRunner", "backfill"],
];
for (const [c, m, targetClass, targetMethod] of [...HOP2, ...HOP3]) method(c, m, [`${targetClass}.${targetMethod}();`]);
// NightlyOps.run() reaches the target on a second path too.
method("NightlyOps", "run", ["BatchCloser.closeAll();", "CreditScheduler.runNightly();"]);
// A fourth hop: outside the question "within three calls".
method("QuarterEnd", "closeBooks", ["NightlyOps.run();"]);

// Decoys: a method with the same name in another class, and its callers.
method("LegacyBilling", "applyCredit", ["System.debug('legacy credit ' + amount);"], "public static void applyCredit(Decimal amount)");
method("LegacyInvoiceService", "finalize", ["LegacyBilling.applyCredit(5);"]);
method("OldRefunds", "issue", ["LegacyBilling.applyCredit(7);"]);
method("PaymentCore", "applyCredit", ["System.debug('payment credit');"]);
method("PaymentService", "settle", ["PaymentCore.applyCredit();"]);

// --- Apex that reads fields ------------------------------------------------------------

method("AgingReport", "build", [
  "List<Invoice__c> rows = [",
  "    select id, balance__c",
  "    from invoice__c",
  "    where status__c = 'Open'",
  "];",
  "System.debug(rows.size());",
]);
method("CollectionsQueue", "load", [
  "List<Invoice__c> due = [SELECT Id FROM Invoice__c WHERE Balance__c > 0];",
  "System.debug(due.size());",
]);
// Decoys: the same field name on Payment__c, and a field with a similar name on Invoice__c.
method("PaymentReconciler", "reconcile", [
  "List<Payment__c> rows = [SELECT Id, Balance__c FROM Payment__c];",
  "System.debug(rows.size());",
]);
method("DunningService", "run", [
  "List<Invoice__c> rows = [SELECT Id, Balance_Due__c FROM Invoice__c];",
  "System.debug(rows.size());",
]);

// --- Filler -----------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(3, "0");
for (let i = 1; i <= FILLER_CLASSES; i++) {
  const name = `Util${pad(i)}`;
  const next = `Util${pad((i % FILLER_CLASSES) + 1)}`;
  method(name, "run", ["step();", `${next}.finish();`]);
  method(name, "step", [
    i % 9 === 0 ? "// TODO: move this to BillingCore.applyCredit when the migration is done." : "// No billing logic here.",
    i % 14 === 0 ? "System.debug('BillingCore.applyCredit skipped for ' + UserInfo.getUserId());" : "System.debug('step');",
  ]);
  method(name, "finish", [i % 20 === 0 ? "LegacyBilling.applyCredit(1);" : "System.debug('done');"]);
  if (i % 30 === 0) method(name, "applyCredit", ["System.debug('local helper, not billing');"]);
  if (i % 25 === 0) method(name, "balanceOf", ["List<Payment__c> p = [SELECT Balance__c FROM Payment__c LIMIT 1];", "System.debug(p.size());"]);
}

// --- Writers ----------------------------------------------------------------------------

function write(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const xml = (rootTag: string, inner: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag} xmlns="http://soap.sforce.com/2006/04/metadata">\n${inner}\n</${rootTag}>\n`;

function field(root: string, object: string, name: string, type: string): void {
  const extra = type === "Currency" ? "\n    <precision>18</precision>\n    <scale>2</scale>" : type === "Text" ? "\n    <length>80</length>" : "";
  write(root, `force-app/main/default/objects/${object}/fields/${name}.field-meta.xml`,
    xml("CustomField", `    <fullName>${name}</fullName>\n    <label>${name.replace(/__c$/, "").replace(/_/g, " ")}</label>\n    <type>${type}</type>${extra}`));
}

function lwc(root: string, name: string, schemaImport: string, apexImport?: string): void {
  const className = name.charAt(0).toUpperCase() + name.slice(1);
  const apexLine = apexImport ? `import callApex from '@salesforce/apex/${apexImport}';\n` : "";
  write(root, `force-app/main/default/lwc/${name}/${name}.js`,
    `import { LightningElement, api, wire } from 'lwc';\nimport { getRecord } from 'lightning/uiRecordApi';\nimport BALANCE from '@salesforce/schema/${schemaImport}';\n${apexLine}\nexport default class ${className} extends LightningElement {\n    @api recordId;\n    @wire(getRecord, { recordId: '$recordId', fields: [BALANCE] })\n    record;\n}\n`);
  write(root, `force-app/main/default/lwc/${name}/${name}.html`, `<template>\n    <lightning-card title="${className}"></lightning-card>\n</template>\n`);
  write(root, `force-app/main/default/lwc/${name}/${name}.js-meta.xml`,
    xml("LightningComponentBundle", `    <apiVersion>${API_VERSION}</apiVersion>\n    <isExposed>true</isExposed>`));
}

function flow(root: string, name: string, object: string, fieldName: string): void {
  write(root, `force-app/main/default/flows/${name}.flow-meta.xml`, xml("Flow", [
    `    <apiVersion>${API_VERSION}</apiVersion>`,
    "    <status>Active</status>",
    "    <processType>AutoLaunchedFlow</processType>",
    `    <label>${name.replace(/_/g, " ")}</label>`,
    `    <start><object>${object}</object><triggerType>RecordAfterSave</triggerType><recordTriggerType>CreateAndUpdate</recordTriggerType></start>`,
    `    <decisions><name>Check_Amount</name><rules><name>Is_Positive</name><conditions><leftValueReference>$Record.${fieldName}</leftValueReference><operator>GreaterThan</operator><rightValue><numberValue>0.0</numberValue></rightValue></conditions></rules></decisions>`,
  ].join("\n")));
}

function layout(root: string, object: string, label: string, fields: string[]): void {
  const items = fields.map((f) => `            <layoutItems>\n                <field>${f}</field>\n                <behavior>Edit</behavior>\n            </layoutItems>`).join("\n");
  write(root, `force-app/main/default/layouts/${object}-${label}.layout-meta.xml`,
    xml("Layout", `    <layoutSections>\n        <label>Information</label>\n        <style>OneColumn</style>\n        <layoutColumns>\n${items}\n        </layoutColumns>\n    </layoutSections>`));
}

function permissionSet(root: string, kind: "permissionset" | "profile", name: string, grants: [string, boolean][]): void {
  const fieldPermissions = grants.map(([f, editable]) =>
    `    <fieldPermissions>\n        <field>${f}</field>\n        <readable>true</readable>\n        <editable>${editable}</editable>\n    </fieldPermissions>`).join("\n");
  const dir = kind === "profile" ? "profiles" : "permissionsets";
  const head = kind === "profile" ? "    <custom>true</custom>\n    <userLicense>Salesforce</userLicense>" : `    <label>${name.replace(/_/g, " ")}</label>\n    <hasActivationRequired>false</hasActivationRequired>`;
  write(root, `force-app/main/default/${dir}/${name}.${kind}-meta.xml`, xml(kind === "profile" ? "Profile" : "PermissionSet", `${head}\n${fieldPermissions}`));
}

export function generateScaleProject(root: string): ScaleTruth {
  write(root, "sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], sourceApiVersion: API_VERSION }, null, 2) + "\n");

  for (const [className, methods] of classes) {
    const body = [...methods].map(([name, spec]) =>
      `    ${spec.signature ?? `public static void ${name}()`} {\n${spec.body.map((line) => `        ${line}`).join("\n")}\n    }`).join("\n\n");
    write(root, `force-app/main/default/classes/${className}.cls`, `public with sharing class ${className} {\n${body}\n}\n`);
    write(root, `force-app/main/default/classes/${className}.cls-meta.xml`, CLASS_META);
  }

  for (const object of ["Invoice__c", "Payment__c"]) {
    write(root, `force-app/main/default/objects/${object}/${object}.object-meta.xml`,
      xml("CustomObject", `    <label>${object.replace("__c", "")}</label>\n    <pluralLabel>${object.replace("__c", "")}s</pluralLabel>\n    <sharingModel>ReadWrite</sharingModel>\n    <deploymentStatus>Deployed</deploymentStatus>`));
  }
  field(root, "Invoice__c", "Balance__c", "Currency");
  field(root, "Invoice__c", "Balance_Due__c", "Currency");
  field(root, "Invoice__c", "Status__c", "Text");
  field(root, "Payment__c", "Balance__c", "Currency");
  field(root, "Payment__c", "Amount__c", "Currency");

  write(root, "force-app/main/default/objects/Invoice__c/validationRules/Balance_Not_Negative.validationRule-meta.xml",
    xml("ValidationRule", "    <fullName>Balance_Not_Negative</fullName>\n    <active>true</active>\n    <errorConditionFormula>Balance__c &lt; 0</errorConditionFormula>\n    <errorMessage>The balance cannot be negative.</errorMessage>"));
  write(root, "force-app/main/default/objects/Payment__c/validationRules/Balance_Check.validationRule-meta.xml",
    xml("ValidationRule", "    <fullName>Balance_Check</fullName>\n    <active>true</active>\n    <errorConditionFormula>Balance__c &lt; 0</errorConditionFormula>\n    <errorMessage>The payment balance cannot be negative.</errorMessage>"));

  lwc(root, "invoicePanel", "Invoice__c.Balance__c", "InvoiceController.close");
  lwc(root, "agingChart", "Invoice__c.Balance__c");
  lwc(root, "paymentSummary", "Payment__c.Balance__c");
  lwc(root, "dunningBanner", "Invoice__c.Balance_Due__c");

  flow(root, "Invoice_Overdue_Alert", "Invoice__c", "Balance__c");
  flow(root, "Payment_Sync", "Payment__c", "Balance__c");
  flow(root, "Dunning_Reminder", "Invoice__c", "Balance_Due__c");

  layout(root, "Invoice__c", "Invoice Layout", ["Status__c", "Balance__c"]);
  layout(root, "Invoice__c", "Collections Layout", ["Status__c", "Balance_Due__c"]);
  layout(root, "Payment__c", "Payment Layout", ["Amount__c", "Balance__c"]);

  write(root, "force-app/main/default/flexipages/Invoice_Record_Page.flexipage-meta.xml",
    xml("FlexiPage", "    <masterLabel>Invoice Record Page</masterLabel>\n    <type>RecordPage</type>\n    <sobjectType>Invoice__c</sobjectType>\n    <flexiPageRegions>\n        <name>main</name>\n        <type>Region</type>\n        <itemInstances>\n            <fieldInstance>\n                <fieldItem>Record.Balance__c</fieldItem>\n                <uiBehavior>Readonly</uiBehavior>\n            </fieldInstance>\n        </itemInstances>\n    </flexiPageRegions>"));
  write(root, "force-app/main/default/flexipages/Payment_Record_Page.flexipage-meta.xml",
    xml("FlexiPage", "    <masterLabel>Payment Record Page</masterLabel>\n    <type>RecordPage</type>\n    <sobjectType>Payment__c</sobjectType>\n    <flexiPageRegions>\n        <name>main</name>\n        <type>Region</type>\n        <itemInstances>\n            <fieldInstance>\n                <fieldItem>Record.Balance__c</fieldItem>\n                <uiBehavior>Readonly</uiBehavior>\n            </fieldInstance>\n        </itemInstances>\n    </flexiPageRegions>"));

  write(root, "force-app/main/default/email/Billing/InvoiceReminder.email-meta.xml",
    xml("EmailTemplate", "    <available>true</available>\n    <encodingKey>UTF-8</encodingKey>\n    <name>Invoice Reminder</name>\n    <style>none</style>\n    <subject>Your invoice</subject>\n    <type>text</type>"));
  write(root, "force-app/main/default/email/Billing/InvoiceReminder.email", "Hello,\n\nYour open balance is {!Invoice__c.Balance__c}.\n");
  write(root, "force-app/main/default/email/Billing/PaymentReceipt.email-meta.xml",
    xml("EmailTemplate", "    <available>true</available>\n    <encodingKey>UTF-8</encodingKey>\n    <name>Payment Receipt</name>\n    <style>none</style>\n    <subject>Your payment</subject>\n    <type>text</type>"));
  write(root, "force-app/main/default/email/Billing/PaymentReceipt.email", "Hello,\n\nThe balance of your payment is {!Payment__c.Balance__c}.\n");

  permissionSet(root, "permissionset", "Billing_Admin", [["Invoice__c.Balance__c", true], ["Invoice__c.Balance_Due__c", true]]);
  permissionSet(root, "permissionset", "Collections_Agent", [["Invoice__c.Balance__c", true]]);
  permissionSet(root, "permissionset", "Billing_Agent", [["Invoice__c.Balance__c", false]]);
  permissionSet(root, "profile", "Finance_User", [["Invoice__c.Balance__c", false]]);
  permissionSet(root, "permissionset", "Payments_Admin", [["Payment__c.Balance__c", true]]);
  permissionSet(root, "permissionset", "Reporting_Viewer", [["Invoice__c.Balance_Due__c", false], ["Payment__c.Balance__c", false]]);
  for (let i = 1; i <= 12; i++) permissionSet(root, "permissionset", `Team_${pad(i)}_Access`, [["Payment__c.Amount__c", i % 2 === 0]]);

  const name = ([c, m]: readonly [string, string, ...string[]]): string => `${c}.${m}`;
  return {
    callersHop1: [...HOP1.map(name), "BillingCore.applyBulk"],
    callersHop2: HOP2.map(name),
    callersHop3: HOP3.map(name),
    callerDecoys: ["LegacyInvoiceService.finalize", "OldRefunds.issue", "PaymentService.settle"],
    fieldUsers: {
      apex: ["BillingCore.applyCredit", "InvoiceService.finalize", "AgingReport.build", "CollectionsQueue.load"],
      lwc: ["invoicePanel", "agingChart"],
      flows: ["Invoice_Overdue_Alert"],
      layouts: ["Invoice__c-Invoice Layout"],
      flexipages: ["Invoice_Record_Page"],
      validationRules: ["Balance_Not_Negative"],
      emailTemplates: ["InvoiceReminder"],
    },
    fieldAccess: { edit: ["Billing_Admin", "Collections_Agent"], readOnly: ["Billing_Agent", "Finance_User"] },
    fieldDecoys: ["PaymentReconciler", "paymentSummary", "Payment_Sync", "Payment Layout", "Payment_Record_Page", "Balance_Check", "PaymentReceipt", "Payments_Admin"],
  };
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write("usage: bun run scale-project.ts <directory>\n");
    process.exit(2);
  }
  generateScaleProject(target);
}
