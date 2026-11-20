# Make operations and services discoverable

Every plugin exposes its operations through a common contract with stable names, machine-readable input and result descriptions, and consistent failure reporting. Allo also lets an authoring agent inspect the services available to plugins and how to use them, so it can build a missing operation on an existing integration.

Operation names are plugin-qualified and stable across profiles and connection selections. Conflicting registrations make the affected name unavailable. The first version builds its catalog from runtime registrations. Discovery reports plugin failures, known missing services, and affected operations it can identify, while independent operations remain callable. If a plugin fails before registration, discovery can identify the configured plugin and its load error. Its intended operation names may be unknown. A separate declarative manifest is deferred until there is a concrete need for discovery before loading. The authoring milestone checks that an agent can diagnose a missing service, correct its dependency declaration, and retry through the CLI.

`allo discover` lists names, short descriptions, availability, and the resolved profile path. `allo describe operation <name>` returns the input and result schemas. `allo describe service <name>` provides the dependency declaration and a TypeScript usage example. An optional external agent skill could teach common workflows using these same commands and reduce the glue code callers write. This remains an idea for exploration.

`allo call <name>` accepts JSON on stdin or via `--input-file <path>`. Commands emit a single JSON document on stdout, including on failure. Diagnostics go to stderr. A successful command exits with zero and a failed command exits with a nonzero status.

Allo dispatches each invocation once. Plugins can distinguish a definite rejection from an unknown outcome after dispatch. For example, an `outcome_unknown` error after a Jira issue creation lets the caller check whether the issue exists before deciding whether to retry.

Discovery and description work before credentials are supplied. An agent can inspect an operation's inputs and required connection on a freshly restored machine. Calling an operation that lacks credentials returns a structured error identifying the connection to configure.
