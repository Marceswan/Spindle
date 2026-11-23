---
type: llm
weight: 3
---

The true references to Invoice__c.Balance__c are: Apex BillingCore.applyCredit, InvoiceService.finalize, AgingReport.build, CollectionsQueue.load; LWC invoicePanel and agingChart; flow Invoice_Overdue_Alert; layout "Invoice__c-Invoice Layout"; FlexiPage Invoice_Record_Page; validation rule Balance_Not_Negative; email template InvoiceReminder. Access: Billing_Admin, Collections_Agent, Billing_Agent, Finance_User.

These do NOT refer to Invoice__c.Balance__c. They use Payment__c.Balance__c or Invoice__c.Balance_Due__c: PaymentReconciler, DunningService, paymentSummary, dunningBanner, Payment_Sync, Dunning_Reminder, "Payment Layout", "Collections Layout", Payment_Record_Page, Balance_Check, PaymentReceipt, Payments_Admin, Reporting_Viewer, and the Util classes.

PASS if the response presents none of the second group as a component that refers to, or grants access to, Invoice__c.Balance__c. The response may name them to say that they are not affected, or as code that reads the Invoice__c object with no reference to this field.
FAIL if the response lists one or more of the second group as affected by the delete of Invoice__c.Balance__c.
