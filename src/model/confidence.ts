// Edge-resolution confidence tiers. See section 5.4 of the design doc.
// Use the named constants instead of bare numbers so the meaning is obvious at the call site.

export const Confidence = {
  // Fully resolved with type info (e.g., static method call where target class is in-project).
  Resolved: 1.0,
  // Resolved via heuristic (e.g., LWC <c-foo-bar> matched to LwcBundle "fooBar" by case conversion).
  Heuristic: 0.8,
  // Regex match without full parser (e.g., v1 SOQL extraction).
  Regex: 0.6,
  // Ambiguous (e.g., instance method call with multiple candidate classes defining the name).
  Ambiguous: 0.4,
  // Reserved: not emitted. Unresolved references are logged for diagnostics, not stored.
  Unresolved: 0.0,
} as const;

export type ConfidenceValue = (typeof Confidence)[keyof typeof Confidence];

// Default minimum confidence for query filters when the caller does not specify one.
export const DEFAULT_MIN_CONFIDENCE = Confidence.Regex;
