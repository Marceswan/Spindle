---
type: regex
pattern: '(?=.*OrderPipeline[^\n]{0,60}complete\b)(?=.*NightlyOps[^\n]{0,60}run\b)(?=.*SupportConsole[^\n]{0,60}refund\b)(?=.*BankFeedListener[^\n]{0,60}onChargeback\b)(?=.*SupportConsole[^\n]{0,60}resolveDispute\b)(?=.*InvoiceController[^\n]{0,60}closeDisputed\b)(?=.*AdminTools[^\n]{0,60}runMigration\b)'
flags: is
match: contains
target: last_message
---
