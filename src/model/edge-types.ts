// Single source of truth for graph edge types. See section 5.3 of the design doc.
// Add a new edge type here before emitting it from a parser or pipeline stage.

export const EdgeType = {
  // Structural
  Contains: "CONTAINS",
  DefinesMethod: "DEFINES_METHOD",
  DefinesProperty: "DEFINES_PROPERTY",

  // Apex inheritance
  Extends: "EXTENDS",
  Implements: "IMPLEMENTS",

  // Apex call graph
  Calls: "CALLS",
  Instantiates: "INSTANTIATES",
  Throws: "THROWS",

  // Apex data access
  SoqlQueries: "SOQL_QUERIES",
  SoslQueries: "SOSL_QUERIES",
  DmlOn: "DML_ON",

  // Cross-domain field/label/metadata references
  ReferencesField: "REFERENCES_FIELD",
  ReferencesLabel: "REFERENCES_LABEL",
  ReferencesMetadata: "REFERENCES_METADATA",

  // Triggers
  TriggersOn: "TRIGGERS_ON",

  // LWC
  LwcUsesApex: "LWC_USES_APEX",
  LwcUsesField: "LWC_USES_FIELD",
  LwcUsesLabel: "LWC_USES_LABEL",
  LwcUsesResource: "LWC_USES_RESOURCE",
  LwcTemplateBinds: "LWC_TEMPLATE_BINDS",
  LwcIncludesComponent: "LWC_INCLUDES_COMPONENT",

  // Aura
  AuraUsesApex: "AURA_USES_APEX",
  AuraIncludesComponent: "AURA_INCLUDES_COMPONENT",

  // Flow
  InvocableFromFlow: "INVOCABLE_FROM_FLOW",
  FlowUsesField: "FLOW_USES_FIELD",
  FlowReferencesField: "FLOW_REFERENCES_FIELD", // Flow -> Field (per-field, authoritative)
  FlowDmlOn: "FLOW_DML_ON",
  FlowInvokesFlow: "FLOW_INVOKES_FLOW",

  // Layouts / FlexiPages
  LayoutIncludesField: "LAYOUT_INCLUDES_FIELD",
  LayoutIncludesButton: "LAYOUT_INCLUDES_BUTTON",
  FlexipageIncludesComponent: "FLEXIPAGE_INCLUDES_COMPONENT",
  FlexipageReferencesField: "FLEXIPAGE_REFERENCES_FIELD",

  // Formulas and validation rules
  ValidationReferencesField: "VALIDATION_REFERENCES_FIELD",
  FormulaReferencesField: "FORMULA_REFERENCES_FIELD",

  // Permission grants
  GrantsApexAccess: "GRANTS_APEX_ACCESS",
  GrantsObjectAccess: "GRANTS_OBJECT_ACCESS",
  GrantsFieldAccess: "GRANTS_FIELD_ACCESS",
  GrantsVisualforceAccess: "GRANTS_VISUALFORCE_ACCESS",
  GrantsRecordTypeAccess: "GRANTS_RECORDTYPE_ACCESS",
  IncludesPermset: "INCLUDES_PERMSET",

  // Email templates
  EmailReferencesField: "EMAIL_REFERENCES_FIELD",

  // External namespaces (managed packages)
  DependsOnExternal: "DEPENDS_ON_EXTERNAL",

  // Visualforce — promoted from v1.1 to v0.2.
  VfUsesApex: "VF_USES_APEX",
  VfUsesField: "VF_USES_FIELD",
  VfIncludesComponent: "VF_INCLUDES_COMPONENT",

  // uiBundle — modern React/TS apps under force-app/.../uiBundles/. Added v0.6.
  // Intra-bundle edges (TsModule -> TsModule | Ts* | ReactComponent | ExternalNamespace).
  TsImports: "TS_IMPORTS",
  TsCalls: "TS_CALLS",
  TsRenders: "TS_RENDERS",
  TsExtends: "TS_EXTENDS",
  // Cross-domain edges (uiBundle -> SFDX metadata; pass 2 resolves to existing nodes).
  // The four LWC-compatible @salesforce/* import patterns. platform-sdk / agentforce / other
  // @salesforce/* packages fall through to DependsOnExternal -> ExternalNamespace.
  UiBundleUsesApex: "UI_BUNDLE_USES_APEX",
  UiBundleUsesField: "UI_BUNDLE_USES_FIELD",
  UiBundleUsesLabel: "UI_BUNDLE_USES_LABEL",
  UiBundleUsesResource: "UI_BUNDLE_USES_RESOURCE",

  // v0.7: type-level relationships and GraphQL.
  TsImplements: "TS_IMPLEMENTS",          // class -> interface
  TsTypeExtends: "TS_TYPE_EXTENDS",        // interface -> interface
  TsTypeReferences: "TS_TYPE_REFERENCES",   // module/declaration -> ambient type
  // GraphQL: cross-domain to existing SFDX nodes when types map (CRM GraphQL maps Object__c
  // to a GraphQL type; field selections map to Field nodes).
  GraphqlUsesField: "GRAPHQL_USES_FIELD",
  GraphqlUsesType: "GRAPHQL_USES_TYPE",
  GraphqlDefinedIn: "GRAPHQL_DEFINED_IN",  // GraphqlOperation -> TsModule (containment)
} as const;

export type EdgeType = (typeof EdgeType)[keyof typeof EdgeType];
