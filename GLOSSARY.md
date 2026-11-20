# Allo

Allo is a local CLI through which agents discover and invoke operations available in a project.

## Language

**Plugin**

An extension that contributes operations, services for other plugins, or both.
_Avoid_: Module as a synonym in Allo documentation.

**Operation**

A named action an agent can discover and invoke. Its description tells the agent its purpose, the inputs it accepts, and the shape of its result.

**Service**

A capability one plugin makes available to another. For example, an ERP plugin can supply order lookup to a plugin that coordinates work across ERP and Jira.

**Connection**

A named configuration for accessing a particular external system or account. One ERP plugin can use distinct test and production connections.

**Profile**

An editable selection of plugins, their settings, and the connections they use.

**Snapshot**

A portable record of a profile at a particular point in time, including the plugin revisions and local edits needed to recover it.
