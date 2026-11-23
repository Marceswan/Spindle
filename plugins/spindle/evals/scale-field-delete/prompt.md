---
description: "A field delete in a larger project, where another object has a field with the same name and the same object has a field with a similar name"
tags: [scale]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill]
---

The current directory is a Salesforce SFDX project with about 200 Apex classes.

I plan to delete the field `Invoice__c.Balance__c`. List every component that refers to this field, and every permission set and profile that grants access to it. Do not list components that only use other fields.
