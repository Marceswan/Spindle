---
type: regex
pattern: '(?=.*InvoiceService[^\n]{0,60}finalize\b)(?=.*RefundProcessor[^\n]{0,60}issueRefund\b)(?=.*CreditNoteJob[^\n]{0,60}execute\b)(?=.*DisputeResolver[^\n]{0,60}settle\b)(?=.*BillingCore[^\n]{0,60}applyBulk\b)'
flags: is
match: contains
target: last_message
---
