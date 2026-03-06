# Dep Jump

Dep Jump is a VS Code extension that makes dependency navigation inside `package.json` fast and reliable.

When your cursor is on a dependency name, Dep Jump resolves where that dependency actually comes from and opens the matching package manifest file.

![Dep Jump Demo](./static/demo_show.gif)

## What This Extension Solves

In real projects, dependency names are not always a 1:1 mapping to a single package location:

- Multiple versions of the same package can exist in nested `node_modules`.
- Alias dependencies can point to a different real package name.
- Monorepos can use `workspace:*` and resolve to local source packages.

Dep Jump handles these cases so navigation still lands in the correct target.

## Key Features

- Works in `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`.
- Resolves dependency targets using Node-style lookup from the current package directory.
- Validates resolved versions against semver ranges.
- Supports `npm:` alias dependencies (maps alias name to real package name/version).
- Supports `workspace:*` dependencies and jumps to the local workspace package manifest.
- Supports `file:` and `link:` local dependencies.
- Shows hover details: resolved package, requested version, resolved version, target manifest path, and entry file.

## Demo Dependency Cases

```json
{
  "dependencies": {
    "react": "^18.2.0",
    "@demo/icons-peer": "npm:@demo-scope/icons@3.2.1",
    "@demo/workspace-ui": "workspace:*"
  }
}
```

Behavior:

- `react` resolves to the matching installed version in `node_modules`.
- `@demo/icons-peer` resolves by alias directory but validates against `@demo-scope/icons@3.2.1`.
- `@demo/workspace-ui` resolves to the local monorepo package.

## How To Use

- `Cmd/Ctrl + Click` on a dependency name to open its resolved package manifest and reveal it in Explorer.
- Press `F12` on a dependency name to go to the same resolved package manifest.
- Hover a dependency name to inspect resolution details.

## License

[MIT License](./LICENSE)
