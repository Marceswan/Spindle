---
description: "A method rename: callers in Apex, LWC and Aura from the graph, and the references that only a text search finds"
tags: [blast-radius]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill]
---

The current directory is a Salesforce SFDX project.

I want to rename the Apex method `AccountService.cleanup()` to `AccountService.purgeStale()`. What is the blast radius? Which files must change with it?
