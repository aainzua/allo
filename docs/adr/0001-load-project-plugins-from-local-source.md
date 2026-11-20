# Load project plugins from local source

Allo selects the nearest project profile by walking up from the working directory. An explicit `--profile <path>` selects a profile directly. Discovery reports the resolved profile path, and a missing profile produces a structured error.

Plugins use TypeScript and Cordis directly for composition. Allo supplies the operation registration contract and a minimal working example that consumes a service and registers a typed operation. Local edits take effect without a manual build step.

The runnable starter project includes a profile, a fixture ERP connection, and a plugin providing an inventory service. A coding agent uses this project to write the missing stock-by-warehouse lookup. Adding one TypeScript entry point path relative to the profile enables the new plugin on the next invocation.

Each CLI invocation loads the current code for the local plugin paths selected by the project. This lets a developer edit an operation and an agent discover and invoke it on its next call, without publishing or importing a release. The first milestone exercises the same path with a coding agent: at a developer's request, it writes and enables a missing plugin through ordinary file edits, discovers the new operation, and invokes it.
