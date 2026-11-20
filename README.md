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
