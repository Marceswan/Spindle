import * as Utils from '@/lib/utils';
import type { AgentContext, ExtendedContext, ContextResolver } from '@/types/globals';

// Tagged template literal — exercises gql template extraction.
const gql = (strings: TemplateStringsArray, ..._values: unknown[]) =>
  strings.join('');

export const GET_CUSTOMER_QUERY = gql`
  query InlineCustomer {
    Customer__c {
      Email__c
    }
  }
`;

// Member-expression call: Utils.cn(...) — exercises namespace-import resolution.
export function classNames(...parts: string[]): string {
  return Utils.cn(...parts);
}

// Class implementing an interface from .d.ts — exercises TS_IMPLEMENTS resolution.
export class ContextHolder implements ExtendedContext {
  recordId = '';
  filter: string | null = null;
  selection: string[] = [];
}

// Function whose parameter type is an interface — exercises TS_TYPE_REFERENCES (TS pass).
export function consumeContext(ctx: AgentContext, _resolver: ContextResolver): string {
  return ctx.recordId;
}
