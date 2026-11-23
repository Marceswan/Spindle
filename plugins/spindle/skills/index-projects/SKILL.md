---
name: index-projects
description: Use at the start of a session in a workspace that has Salesforce SFDX projects (a sfdx-project.json file or a force-app directory), when the user asks to index, refresh or prepare Spindle, and when a Spindle tool reports that a project is not indexed or returns results that do not agree with the files.
argument-hint: "[directory to search; default is the working directory]"
---

# Index the SFDX projects of a workspace

Spindle answers only for projects that are in its graph. The SessionStart hook indexes one project: the one at or above the working directory. A workspace can hold more than one SFDX project, and each one is a separate graph with its own `project_id`.

## Steps

1. **Find the projects.** Glob for `**/sfdx-project.json` below the workspace root (or the directory in the argument). Ignore a file that is in `node_modules` or in a directory whose name starts with `.`. Each remaining file marks one project root: the directory that contains it.
2. **Compare with the graph.** Call `list_projects`. Match each root with `rootPath`. The graph stores the real path, so a symlinked path can look different.
3. **Tell the user what you found**, in one table: project, path, and status (`not indexed`, or `indexed` with the node count).
4. **Index.**
   - Five projects or fewer: call `index_project` for each one that is not indexed. Use the absolute path. The default mode (`incremental`) is correct.
   - More than five: ask the user which ones to index.
   - A project that is already indexed: call `index_project` too. It takes milliseconds when no file changed, and it starts the file watcher for this session.
5. **Report.** Give one table: `project_id`, name, root, nodes, edges. Then add these two sentences if there is more than one project: each project is a separate graph, so each question must name a `project_id`; the same metadata name can exist in more than one project.

## Notes

- `files_parsed: 0` with nonzero node and edge counts means that the index was current. The counts are graph totals.
- If a result does not agree with the files after an incremental index, run `index_project` with `mode: "full"` one time.
- `project_root` must be absolute. A relative path is refused.
- Indexing reads the project and writes only to the Spindle cache. It changes no project file.
