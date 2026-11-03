// Ambient type declarations — exercises .d.ts indexing.

export interface AgentContext {
  recordId: string;
  filter: string | null;
}

export interface ExtendedContext extends AgentContext {
  selection: string[];
}

export type ContextResolver = (ctx: AgentContext) => Promise<string>;

declare function legacyHelper(input: string): number;

declare module 'sfdc:foo' {
  export const FOO: string;
}
