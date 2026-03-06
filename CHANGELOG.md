# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [0.0.2] - 2026-03-06

### Fixed

- Fixed GitHub publish workflow VSIX filename computation step.
- Aligned `@types/vscode` with `engines.vscode` to satisfy `vsce` packaging checks.

## [0.0.1] - 2026-03-04

### Added

- Initial VS Code extension scaffold for dependency navigation from `package.json` and `packages.json`.
- Jump support for `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`.
- Resolution for installed packages in `node_modules`, including version matching with `semver`.
- Resolution for `workspace:*` monorepo dependencies to local package manifests.
- Support for `npm:` alias dependencies and `file:` / `link:` local dependencies.
- Hover details showing resolved package metadata and target file.
