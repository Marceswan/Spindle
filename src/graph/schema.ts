// Spindle graph schema DDL as a TypeScript string constant. See section 8.1 of
// sfdx-graph-mcp-design.md. The DDL is held in code rather than as a sibling .sql file
// so it gets bundled into the Bun-compiled binary (`bun build --compile` doesn't bundle
// arbitrary asset files, so `readFileSync("./schema.sql")` would fail in distribution).
//
// schema.sql at the same path mirrors this string verbatim for sql-shell convenience
// (it's the human-readable canonical) but is NOT loaded at runtime.

export const CURRENT_SCHEMA_VERSION = 1;

export const SCHEMA_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    indexed_at INTEGER,
    api_version TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT,
    start_line INTEGER,
    end_line INTEGER,
    properties TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (project_id, label, qualified_name),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id);

CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    edge_type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    properties TEXT NOT NULL DEFAULT '{}',
    source_file TEXT,
    source_line INTEGER,
    FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project_id);

CREATE TABLE IF NOT EXISTS file_hashes (
    project_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    indexed_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, file_path),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS file_backrefs (
    project_id INTEGER NOT NULL,
    target_file TEXT NOT NULL,
    referring_file TEXT NOT NULL,
    PRIMARY KEY (project_id, target_file, referring_file),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_backrefs_target ON file_backrefs(target_file);

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
);
`;
