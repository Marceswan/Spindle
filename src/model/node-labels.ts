// Single source of truth for graph node labels. See section 5.1 of the design doc.
// Add a new label here before emitting it from a parser.

export const NodeLabel = {
  Project: "Project",
  PackageDirectory: "PackageDirectory",

  ApexClass: "ApexClass",
  ApexTrigger: "ApexTrigger",
  ApexMethod: "ApexMethod",
  ApexProperty: "ApexProperty",
  ApexInterface: "ApexInterface",
  ApexEnum: "ApexEnum",

  LwcBundle: "LwcBundle",
  LwcModule: "LwcModule",
  LwcTemplate: "LwcTemplate",
  LwcMetaConfig: "LwcMetaConfig",

  AuraBundle: "AuraBundle",
  AuraComponent: "AuraComponent",
  AuraController: "AuraController",
  AuraHelper: "AuraHelper",

  SObject: "SObject",
  Field: "Field",
  RecordType: "RecordType",
  ValidationRule: "ValidationRule",

  Layout: "Layout",
  FlexiPage: "FlexiPage",

  PermissionSet: "PermissionSet",
  PermissionSetGroup: "PermissionSetGroup",
  Profile: "Profile",

  Flow: "Flow",

  CustomLabel: "CustomLabel",
  CustomMetadataType: "CustomMetadataType",
  StaticResource: "StaticResource",
  EmailTemplate: "EmailTemplate",
  NamedCredential: "NamedCredential",

  ExternalNamespace: "ExternalNamespace",

  // Visualforce — promoted from v1.1 to v0.2 per scope decision.
  VisualforcePage: "VisualforcePage",
  VisualforceComponent: "VisualforceComponent",
} as const;

export type NodeLabel = (typeof NodeLabel)[keyof typeof NodeLabel];
