// Pass 3: Cross-domain reference resolution — v0.1 stub.
// In v0.2+, this pass resolves:
//   - LWC_USES_APEX: @salesforce/apex imports -> @AuraEnabled ApexMethod nodes
//   - INVOCABLE_FROM_FLOW: Flow actionCalls -> @InvocableMethod ApexMethod nodes
//   - LWC_USES_FIELD / LWC_USES_SCHEMA: @salesforce/schema imports -> Field nodes
//   - Permission set grants -> Apex/SObject/Field target nodes
//
// For v0.1, this function logs how many refs would have been processed and returns
// immediately. The function signature matches what the orchestrator expects so
// future phases can drop in real logic without changing callers.

import type { UnresolvedRef } from "../parsers/apex/types.ts";
import type { GraphStore } from "../graph/store.ts";
import { logger } from "../util/logger.ts";

export type Pass3Diagnostics = {
  skippedCrossDomainCount: number;
};

export function runPass3(
  _projectId: number,
  unresolved: UnresolvedRef[],
  _store: GraphStore,
): Pass3Diagnostics {
  // In v0.1 the only unresolved refs that reach here are those not handled by pass 2
  // (instance calls with unknown receiver type, external namespace references, etc.).
  const skippedCrossDomainCount = unresolved.length;
  if (skippedCrossDomainCount > 0) {
    logger.debug(
      { skippedCrossDomainCount },
      "pass3: v0.1 stub — cross-domain refs deferred to v0.2",
    );
  }
  return { skippedCrossDomainCount };
}
