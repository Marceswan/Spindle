---
description: "Callers within three calls in a larger project, where other classes have a method with the same name and the target name is in comments and strings"
tags: [scale]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill]
---

The current directory is a Salesforce SFDX project with about 200 Apex classes.

Which Apex methods reach `BillingCore.applyCredit` within three calls? I mean its direct callers, the callers of those, and one more level. Give the full list, grouped by distance, with each method as `Class.method`.
