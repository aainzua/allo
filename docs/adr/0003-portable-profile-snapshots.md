# Preserve locally edited plugins in portable profile snapshots

A snapshot preserves the selected plugin revisions, including unpublished local edits, along with plugin settings, connection names, and non-secret connection settings. A recipient can restore an editable profile on another machine, supply credentials locally, and invoke its operations against current external data. Capturing the source behind a local path allows recovery even after a later edit breaks the plugin.

Restore creates a separate editable profile with its own local plugin sources by default. The snapshot records resolved dependency versions, integrity hashes, and the compatible Allo runtime version. Restore may download pinned dependencies and must identify any dependency it cannot recover.

If a snapshot connection name matches a local connection with a different destination, import succeeds and reports both destinations. Operations that need that connection return a structured error until the caller explicitly maps or configures it.

The first milestone exercises authoring and recovery end to end. A coding agent discovers a fixture ERP service, writes and enables a missing lookup, invokes it, and exports a snapshot. After the fixture stock changes, the agent restores into a clean project, supplies the connection, and invokes the recovered lookup. The result must contain the updated stock quantity.
