// Synthetic SFDX corpus generator for Spindle Phase B benchmarks.
// Produces a real SFDX project layout that the Spindle indexer can ingest.
// Uses a seeded linear congruential generator for deterministic output.
//
// Usage:
//   import { generateCorpus } from "./corpus.ts";
//   const corpus = generateCorpus({ rootDir: "/tmp/spindle-bench-100", classCount: 100, seed: 42 });

import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GenerateOpts = {
  rootDir: string;
  classCount: number;
  seed: number;
  triggerObjects?: string[];
};

export type GeneratedCorpus = {
  rootDir: string;
  classCount: number;
  triggerCount: number;
  totalFiles: number;
  manifest: { classes: string[]; triggers: string[] };
};

// ---------------------------------------------------------------------------
// Seeded linear congruential generator (no external dep)
// Parameters from Knuth MMIX / Newlib: m=2^64, a=6364136223846793005, c=1442695040888963407
// We operate mod 2^32 for simplicity.
// ---------------------------------------------------------------------------

class Rng {
  private state: number;

  constructor(seed: number) {
    // Keep seed in 32-bit unsigned range.
    this.state = seed >>> 0;
  }

  /** Returns a pseudo-random 32-bit unsigned integer. */
  next(): number {
    // Numeric values chosen for good distribution in 32-bit space.
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state;
  }

  /** Returns an integer in [0, max). */
  nextInt(max: number): number {
    return this.next() % max;
  }

  /** Returns true with the given probability (0.0 – 1.0). */
  nextBool(probability: number): boolean {
    return this.next() / 0xffffffff < probability;
  }
}

// ---------------------------------------------------------------------------
// Content templates
// ---------------------------------------------------------------------------

const SOBJECTS = ["Account", "Contact", "Opportunity", "Lead"] as const;
type SObject = (typeof SOBJECTS)[number];

function pickSObject(rng: Rng): SObject {
  return SOBJECTS[rng.nextInt(SOBJECTS.length)] as SObject;
}

type MethodSpec = {
  name: string;
  isPublic: boolean;
  isStatic: boolean;
  arity: number;
};

// Deterministic method names to make grep patterns meaningful.
const METHOD_NAMES = [
  "execute",
  "process",
  "validate",
  "transform",
  "resolve",
  "fetch",
  "sync",
  "calculate",
  "dispatch",
  "initialize",
] as const;

function generateMethods(classIndex: number, rng: Rng): MethodSpec[] {
  const count = 5 + rng.nextInt(6); // 5-10 methods
  const methods: MethodSpec[] = [];
  for (let i = 0; i < count; i++) {
    methods.push({
      name: `${METHOD_NAMES[i % METHOD_NAMES.length] as string}_${classIndex}`,
      isPublic: rng.nextBool(0.6),
      isStatic: rng.nextBool(0.4),
      arity: rng.nextInt(4),
    });
  }
  return methods;
}

function buildParams(arity: number): string {
  if (arity === 0) return "";
  const params: string[] = [];
  const types = ["String", "Integer", "Boolean", "Id", "List<String>"];
  for (let i = 0; i < arity; i++) {
    params.push(`${types[i % types.length] as string} param${i + 1}`);
  }
  return params.join(", ");
}

function generateClassSource(
  classIndex: number,
  classCount: number,
  rng: Rng,
): string {
  const className = `Class${classIndex}`;

  // Deterministically choose a peer class to reference.
  const peerIndex = ((classIndex + Math.floor(classCount / 3)) % classCount) + 1;
  const peerClass = `Class${peerIndex}`;

  // 30% of classes extend another class.
  const extendsClause = rng.nextBool(0.3) ? ` extends ${peerClass}` : "";

  // SObject for SOQL.
  const soqlObject = pickSObject(rng);

  // Methods
  const methods = generateMethods(classIndex, rng);

  const lines: string[] = [];
  lines.push(`// Generated synthetic class for Spindle benchmark.`);
  lines.push(`public with sharing class ${className}${extendsClause} {`);
  lines.push(``);

  // Instantiation field so the INSTANTIATES edge fires.
  lines.push(`    private ${peerClass} peer = new ${peerClass}();`);
  lines.push(``);

  for (const method of methods) {
    const vis = method.isPublic ? "public" : "private";
    const stat = method.isStatic ? " static" : "";
    const params = buildParams(method.arity);
    lines.push(`    ${vis}${stat} void ${method.name}(${params}) {`);

    // One SOQL per class (inside the first method only to keep line count down).
    if (method === methods[0]) {
      lines.push(
        `        List<${soqlObject}> recs = [SELECT Id, Name FROM ${soqlObject} WHERE IsDeleted = FALSE];`,
      );
      lines.push(`        System.debug('${className} fetched ' + recs.size());`);
    }

    // Cross-class call: call a method on the peer class deterministically.
    if (method === methods[1]) {
      const peerMethodName = `execute_${peerIndex}`;
      if (method.isStatic) {
        lines.push(`        ${peerClass}.${peerMethodName}();`);
      } else {
        lines.push(`        peer.${peerMethodName}();`);
      }
    }

    // 20% of methods reference a method that could be an overriding extends call.
    if (!method.isStatic && extendsClause !== "" && method === methods[2]) {
      lines.push(`        super.${METHOD_NAMES[0]}_${peerIndex}();`);
    }

    lines.push(`    }`);
    lines.push(``);
  }

  lines.push(`}`);

  return lines.join("\n");
}

function generateClassMetaXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <status>Active</status>
</ApexClass>
`;
}

function generateTriggerSource(objectName: string): string {
  const handlerClass = `${objectName}Handler`;
  // The handler class is Class1 (always generated as part of the class set).
  // We reference the handler by name so the INSTANTIATES / CALLS edges fire.
  return `trigger ${objectName}Trigger on ${objectName} (before insert, after update) {
    new ${handlerClass}().run_1();
}
`;
}

function generateTriggerMetaXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <status>Active</status>
</ApexTrigger>
`;
}

// A minimal handler class so the trigger's INSTANTIATES reference resolves.
// Named <Object>Handler; generated into the classes directory.
function generateHandlerSource(objectName: string, classCount: number, rng: Rng): string {
  const soqlObject = pickSObject(rng);
  const peerIndex = rng.nextInt(classCount) + 1;
  const peerClass = `Class${peerIndex}`;
  return `// Handler for ${objectName}Trigger — generated by Spindle corpus generator.
public with sharing class ${objectName}Handler {
    private ${peerClass} peer = new ${peerClass}();

    public void run_1() {
        List<${soqlObject}> recs = [SELECT Id, Name FROM ${soqlObject} WHERE IsDeleted = FALSE];
        peer.execute_${peerIndex}();
        System.debug('${objectName}Handler processed ' + recs.size());
    }
}
`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function generateCorpus(opts: GenerateOpts): GeneratedCorpus {
  const { rootDir, classCount, seed } = opts;
  const triggerObjects = opts.triggerObjects ?? ["Account", "Contact"];

  const rng = new Rng(seed);

  // Clean and recreate rootDir.
  if (existsSync(rootDir)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
  mkdirSync(rootDir, { recursive: true });

  // sfdx-project.json
  const sfdxProject = {
    packageDirectories: [{ path: "force-app", default: true }],
    sourceApiVersion: "62.0",
  };
  writeFileSync(join(rootDir, "sfdx-project.json"), JSON.stringify(sfdxProject, null, 2) + "\n");

  const classesDir = join(rootDir, "force-app", "main", "default", "classes");
  const triggersDir = join(rootDir, "force-app", "main", "default", "triggers");
  mkdirSync(classesDir, { recursive: true });
  mkdirSync(triggersDir, { recursive: true });

  const classNames: string[] = [];
  const triggerNames: string[] = [];

  // Emit Apex classes Class1 … Class<N>.
  for (let i = 1; i <= classCount; i++) {
    const name = `Class${i}`;
    classNames.push(name);
    const src = generateClassSource(i, classCount, rng);
    const meta = generateClassMetaXml();
    writeFileSync(join(classesDir, `${name}.cls`), src);
    writeFileSync(join(classesDir, `${name}.cls-meta.xml`), meta);
  }

  // Emit handler classes and triggers.
  for (const obj of triggerObjects) {
    const handlerName = `${obj}Handler`;
    classNames.push(handlerName);
    const handlerSrc = generateHandlerSource(obj, classCount, rng);
    const handlerMeta = generateClassMetaXml();
    writeFileSync(join(classesDir, `${handlerName}.cls`), handlerSrc);
    writeFileSync(join(classesDir, `${handlerName}.cls-meta.xml`), handlerMeta);

    const trigSrc = generateTriggerSource(obj);
    const trigMeta = generateTriggerMetaXml();
    const trigName = `${obj}Trigger`;
    triggerNames.push(trigName);
    writeFileSync(join(triggersDir, `${trigName}.trigger`), trigSrc);
    writeFileSync(join(triggersDir, `${trigName}.trigger-meta.xml`), trigMeta);
  }

  // totalFiles = .cls + .cls-meta.xml + .trigger + .trigger-meta.xml + sfdx-project.json
  const totalFiles =
    classNames.length * 2 + triggerNames.length * 2 + 1;

  return {
    rootDir,
    classCount: classNames.length,
    triggerCount: triggerNames.length,
    totalFiles,
    manifest: { classes: classNames, triggers: triggerNames },
  };
}
