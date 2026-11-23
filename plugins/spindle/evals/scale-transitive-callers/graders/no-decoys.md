---
type: llm
weight: 2
---

Twenty methods reach BillingCore.applyCredit within three calls.
Distance 1: InvoiceService.finalize, RefundProcessor.issueRefund, CreditNoteJob.execute, DisputeResolver.settle, BillingCore.applyBulk.
Distance 2: InvoiceController.close, BatchCloser.closeAll, RefundController.submit, ChargebackHandler.reverse, CreditScheduler.runNightly, DisputeController.accept, InvoiceService.finalizeDisputed, MigrationRunner.backfill.
Distance 3: OrderPipeline.complete, NightlyOps.run, SupportConsole.refund, BankFeedListener.onChargeback, SupportConsole.resolveDispute, InvoiceController.closeDisputed, AdminTools.runMigration.

These do NOT reach it: LegacyInvoiceService.finalize, OldRefunds.issue and the Util classes call LegacyBilling.applyCredit, a different class. PaymentService.settle calls PaymentCore.applyCredit. Some Util classes only name BillingCore.applyCredit in a comment or a string.

PASS if the response lists none of LegacyInvoiceService.finalize, OldRefunds.issue, PaymentService.settle or a Util class method as a method that reaches BillingCore.applyCredit. The response may name them to say that they are excluded. QuarterEnd.closeBooks is at distance 4: it is acceptable only if the response marks it as outside the three-call limit.
FAIL if one of those is listed as reaching BillingCore.applyCredit within three calls.
