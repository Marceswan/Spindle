// Shared XML reader for the metadata parsers.
//
// Every text value stays a string exactly as written (after the `trimValues` trim). The
// library's value conversion is OFF: it turned "001" into 1, "1e3" into 1000, "0x1F" into 31
// and "true" into a boolean, which broke picklist values, labels, formulas and names.
// Booleans and numbers are read at the point of use with the typed helpers below, so each
// property has one defined type. Turning boolean conversion off as well (instead of keeping
// it and converting back to text) means a leaf is never anything but a string; there is no
// per-field "may already be a boolean" case to forget.

import { XMLParser } from "fast-xml-parser";

export type XmlParserOptions = {
  /** Tag names that always parse to an array. Default: none. */
  isArray?: (name: string) => boolean;
  /** Keep attributes (prefix `@_`). Default: false. */
  attributes?: boolean;
  /** Keep document order (array-of-nodes output). Default: false. */
  preserveOrder?: boolean;
};

export function createXmlParser(options: XmlParserOptions = {}): XMLParser {
  const isArray = options.isArray;
  return new XMLParser({
    ignoreAttributes: options.attributes !== true,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    trimValues: true,
    isArray: isArray === undefined ? () => false : (name) => isArray(name),
    preserveOrder: options.preserveOrder === true,
  });
}

/** Text of a leaf element, or undefined when absent or not a leaf. */
export function xmlText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Boolean of a leaf element. Only the exact text "true" or "false" counts; else undefined. */
export function xmlBool(value: unknown): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Finite number of a leaf element, or null when absent, empty or not a number. */
export function xmlNumber(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
