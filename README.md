# Allo

Allo is a local CLI for agents. TypeScript plugins use [Cordis](https://github.com/cordiverse/cordis) to provide services to each other and register operations for callers.

## Run the starter

Use Node.js 22.18 or newer and npm. From this repository, install dependencies with `npm ci` and run `node src/cli.js --help`. To make `allo` available on your PATH from a checkout, run `npm link`.

Start the fixture ERP in one terminal with `node examples/erp/fixture.mjs`. In another terminal, change to `examples/erp/starter` and try these commands.

```sh
allo discover
allo describe service erp.inventory
allo describe operation summary.total-stock
```

Set `ALLO_FIXTURE_TOKEN` to `demo-token` in the calling shell. The fixture also accepts a different value when you set the same variable in both shells.

```sh
echo '{"sku":"A42"}' | allo call summary.total-stock
```

The operation returns a total quantity of 18. You can also put the JSON input in a file and pass `--input-file <path>`. Every command returns one JSON document with `ok` and either `result` or `error`. Errors exit nonzero. Plugin diagnostics go to stderr.

## Add a lookup

Ask a coding agent to add a stock-by-warehouse lookup to the starter project. It can discover `erp.inventory` and copy the registration pattern in [stock-summary.ts](examples/erp/starter/plugins/stock-summary.ts).

1. Write a TypeScript plugin that injects `allo` and `erp.inventory`. Call `inventory.lookup(sku)` and select the requested warehouse.
2. Register the operation with its qualified name, JSON Schema input and result, and required connection. Add the entry point path to the profile’s `plugins` array.
3. Run `allo discover` and `allo describe operation <name>` to check the registration. Then call the operation with SKU `A42` and warehouse `Bilbao`.

Allo looks for the nearest `allo.json` above the working directory. Use `--profile <path>` to select a specific profile. Plugin paths are relative to that file. Each invocation loads the current source. A plugin can be a path string or an object with `path` and `config`. Cordis resolves service dependencies even when the consumer is listed first.

## Save and restore

```sh
allo snapshot export monday.allo-snapshot.json
allo snapshot restore monday.allo-snapshot.json --to monday
allo discover --profile monday/allo.json
```

Restore creates a new editable project directory. It recovers plugin entry points, statically imported local runtime files, the profile, and the project’s npm dependency lock when present. List extra files such as assets and dynamic imports in the profile’s `snapshotFiles` array. Keep npm dependencies in a standalone `package.json` with a version 3 `package-lock.json`. Restore uses the recorded Allo release and installs registry dependencies by their pinned versions and integrity hashes with lifecycle scripts disabled.

Edit the quantity in `examples/erp/stock.json`, then call the restored lookup with `--profile monday/allo.json`. The fixture reads the file on every request, so the restored lookup returns the new quantity.

Connections store a destination URL and an optional `credentialEnv` variable name. Keep credentials in the environment and profile configuration limited to shareable settings. Local connection definitions can live in `~/.allo/connections.json` or a file selected via `--connections <path>`. Use the same connection object format as the profile. If a local name matches a profile name with a different destination, restore reports the conflict and operations requiring that connection wait for an explicit mapping such as `--map-connection erp-demo=erp-test`.

Run `npm test` to verify the authoring and recovery flow against the fixture ERP.

## Connect to Jira Cloud

The shipped [Jira plugin](src/plugins/jira.ts) is enabled by adding `{ "plugin": "jira", "config": { "connection": "jira" } }` to a profile’s `plugins` array. Copy [the example profile](examples/jira/allo.example.json) to `examples/jira/allo.json` and set `connections.jira.destination` to your Atlassian Cloud site URL. For a scoped Atlassian API token, use `https://api.atlassian.com/ex/jira/<cloudId>/` as the destination. Allo snapshots include a copy of the bundled Jira source pinned by its SHA-256 digest. [Atlassian REST API authentication and URI formats](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/#authentication-and-authorization)

On Windows, log in once per named connection. Allo verifies the account with Jira before saving the token in Windows Credential Manager. This PowerShell example reads the token with a masked prompt. [Atlassian API token setup](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/)

```powershell
Set-Location examples/jira
$email = Read-Host 'Atlassian account email'
(Get-Credential -UserName $email -Message 'Enter your Jira API token').GetNetworkCredential().Password | allo.cmd login jira --email $email
allo.cmd status jira
allo.cmd discover
'{"key":"PROJ-123"}' | allo.cmd call jira.get-issue
'{"jql":"assignee = currentUser() ORDER BY updated DESC","maxResults":10}' | allo.cmd call jira.search-issues
```

For a temporary session or CI, supply both `ALLO_JIRA_EMAIL` and `ALLO_JIRA_TOKEN` in the environment. A connection can name a different token variable with `credentialEnv`. A complete pair takes precedence over the saved login. `allo logout jira` removes the saved entry for the selected connection and destination.

Use `allo describe operation <name>` to inspect schemas. Allo exposes the following Jira operations.

- Read issues with `jira.get-issue` or `jira.search-issues`. Search one page at a time with `nextPageToken`, or use `jira.search-all` for up to 1,000 issues per call. Its count is the number retrieved in this call, and its `complete` flag indicates whether it reached the final page.
- Inspect form requirements with `jira.list-issue-types`, `jira.create-fields`, and `jira.edit-fields`. Then use `jira.create-issue` or `jira.update-issue`. Pass custom values in `fields` keyed by Jira field ID.
- Use `jira.find-assignees` and `jira.assign-issue` to assign by account ID. Use `jira.list-comments` and `jira.add-comment` for discussion.
- Use `jira.list-transitions` to inspect valid transitions, their target status, and any required fields. Pass the selected transition ID and fields to `jira.transition-issue`.

Descriptions and comments accept plain text or Atlassian Document Format. If a write returns `outcome_unknown`, check the issue in Jira before retrying.
