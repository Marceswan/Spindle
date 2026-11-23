---
type: regex
pattern: '(?=.*InvoiceController[^\n]{0,60}close\b)(?=.*BatchCloser[^\n]{0,60}closeAll\b)(?=.*RefundController[^\n]{0,60}submit\b)(?=.*ChargebackHandler[^\n]{0,60}reverse\b)(?=.*CreditScheduler[^\n]{0,60}runNightly\b)(?=.*DisputeController[^\n]{0,60}accept\b)(?=.*InvoiceService[^\n]{0,60}finalizeDisputed\b)(?=.*MigrationRunner[^\n]{0,60}backfill\b)'
flags: is
match: contains
target: last_message
---
