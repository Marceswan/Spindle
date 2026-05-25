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
} as const;

export type EdgeType = (typeof EdgeType)[keyof typeof EdgeType];
