import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as semver from 'semver';
import * as vscode from 'vscode';

const DEPENDENCY_SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

type JsonTokenType =
  | 'braceL'
  | 'braceR'
  | 'bracketL'
  | 'bracketR'
  | 'colon'
  | 'comma'
  | 'string'
  | 'literal';

interface JsonToken {
  type: JsonTokenType;
  start: number;
  end: number;
  value?: unknown;
}

interface DependencyEntry {
  name: string;
  spec: string;
  section: string;
  keyStart: number;
  keyEnd: number;
}

interface ParsedPackageJson {
  value: unknown;
  dependencies: DependencyEntry[];
}

interface LoadedManifest {
  filePath: string;
  dirPath: string;
  value: Record<string, unknown>;
}

interface ResolvedTarget {
  uri: vscode.Uri;
  selectionRange: vscode.Range;
  manifestUri: vscode.Uri;
  manifestSelectionRange: vscode.Range;
  resolvedPackageName: string;
  resolvedVersion?: string;
}

interface DependencyExpectation {
  lookupName: string;
  packageName: string;
  versionSpec: string;
}

interface NpmAliasSpec {
  packageName: string;
  versionSpec: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = [
    { language: 'json', pattern: '**/package.json' },
    { language: 'jsonc', pattern: '**/package.json' },
    { language: 'json', pattern: '**/packages.json' },
    { language: 'jsonc', pattern: '**/packages.json' },
  ];

  const provider = new PackageDependencyDefinitionProvider();
  const linkProvider = new PackageDependencyDocumentLinkProvider();
  const hoverProvider = new PackageDependencyHoverProvider();

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, provider));
  context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(selector, linkProvider));
  context.subscriptions.push(vscode.languages.registerHoverProvider(selector, hoverProvider));
  context.subscriptions.push(
    vscode.commands.registerCommand('depJump.openDependency', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      await openDependencyFromDocument(editor.document, editor.document.offsetAt(editor.selection.active));
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('depJump.openDependencyLink', async (documentUri: string, offset: number) => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(documentUri));
      await openDependencyFromDocument(document, offset);
    }),
  );
}

export function deactivate(): void {}

class PackageDependencyDefinitionProvider implements vscode.DefinitionProvider {
  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
  ): Promise<vscode.DefinitionLink[] | undefined> {
    const offset = document.offsetAt(position);
    const entry = getDependencyEntryAtOffset(document, offset);

    if (!entry) {
      return undefined;
    }

    const resolved = await resolveDependency(document.uri.fsPath, entry, token);
    if (!resolved) {
      return undefined;
    }

    const originSelectionRange = new vscode.Range(
      document.positionAt(entry.keyStart),
      document.positionAt(entry.keyEnd),
    );

    return [
      {
        originSelectionRange,
        targetUri: resolved.manifestUri,
        targetRange: resolved.manifestSelectionRange,
        targetSelectionRange: resolved.manifestSelectionRange,
      },
    ];
  }
}

class PackageDependencyDocumentLinkProvider implements vscode.DocumentLinkProvider {
  public provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const parsed = parsePackageJson(document.getText());
    if (!parsed) {
      return [];
    }

    return parsed.dependencies.map((entry) => {
      const range = new vscode.Range(
        document.positionAt(entry.keyStart),
        document.positionAt(entry.keyEnd),
      );
      const args = encodeURIComponent(JSON.stringify([document.uri.toString(), entry.keyStart]));
      const link = new vscode.DocumentLink(
        range,
        vscode.Uri.parse(`command:depJump.openDependencyLink?${args}`),
      );
      link.tooltip = 'Open dependency and reveal it in Explorer';
      return link;
    });
  }
}

class PackageDependencyHoverProvider implements vscode.HoverProvider {
  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const offset = document.offsetAt(position);
    const entry = getDependencyEntryAtOffset(document, offset);
    if (!entry) {
      return undefined;
    }

    const resolved = await resolveDependency(document.uri.fsPath, entry, token);
    if (!resolved) {
      return undefined;
    }

    const expectation = getDependencyExpectation(entry);
    const range = new vscode.Range(
      document.positionAt(entry.keyStart),
      document.positionAt(entry.keyEnd),
    );
    const markdown = new vscode.MarkdownString(undefined, true);

    markdown.appendMarkdown(`**Dependency:** \`${entry.name}\`\n\n`);
    markdown.appendMarkdown(`**Resolved Package:** \`${resolved.resolvedPackageName}\`\n\n`);
    markdown.appendMarkdown(`**Requested Version:** \`${expectation.versionSpec || '(any)'}\`\n\n`);
    markdown.appendMarkdown(`**Resolved Version:** \`${resolved.resolvedVersion ?? '(unknown)'}\`\n\n`);
    markdown.appendMarkdown(`**Will Open:** \`${resolved.manifestUri.fsPath}\`\n\n`);

    if (resolved.uri.fsPath !== resolved.manifestUri.fsPath) {
      markdown.appendMarkdown(`**Entry File:** \`${resolved.uri.fsPath}\`\n\n`);
    }

    markdown.isTrusted = false;
    return new vscode.Hover(markdown, range);
  }
}

async function openDependencyFromDocument(
  document: vscode.TextDocument,
  offset: number,
): Promise<void> {
  const entry = getDependencyEntryAtOffset(document, offset);
  if (!entry) {
    return;
  }

  const resolved = await resolveDependency(document.uri.fsPath, entry);
  if (!resolved) {
    return;
  }

  const editor = await vscode.window.showTextDocument(resolved.manifestUri, { preview: false });
  editor.selection = new vscode.Selection(
    resolved.manifestSelectionRange.start,
    resolved.manifestSelectionRange.end,
  );
  editor.revealRange(resolved.manifestSelectionRange, vscode.TextEditorRevealType.InCenter);
  await vscode.commands.executeCommand('revealInExplorer', resolved.manifestUri);
}

async function resolveDependency(
  currentManifestPath: string,
  entry: DependencyEntry,
  token?: vscode.CancellationToken,
): Promise<ResolvedTarget | undefined> {
  if (token?.isCancellationRequested) {
    return undefined;
  }

  const currentPackageDir = path.dirname(currentManifestPath);
  const fileLike = await resolveFileLikeDependency(currentPackageDir, entry.spec);
  if (fileLike) {
    return fileLike;
  }

  if (isWorkspaceProtocol(entry.spec)) {
    const workspaceMatch = await resolveWorkspaceDependency(currentManifestPath, entry, token);
    if (workspaceMatch) {
      return workspaceMatch;
    }
  }

  return resolveNodeModulesDependency(currentPackageDir, entry, token);
}

async function resolveWorkspaceDependency(
  currentManifestPath: string,
  entry: DependencyEntry,
  token?: vscode.CancellationToken,
): Promise<ResolvedTarget | undefined> {
  const expectation = getDependencyExpectation(entry);
  const folders = vscode.workspace.workspaceFolders ?? [];

  for (const folder of folders) {
    if (token?.isCancellationRequested) {
      return undefined;
    }

    const manifests = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/package.json'),
      '**/node_modules/**',
    );

    for (const manifestUri of manifests) {
      if (token?.isCancellationRequested) {
        return undefined;
      }

      if (manifestUri.fsPath === currentManifestPath) {
        continue;
      }

      if (pathSegments(manifestUri.fsPath).includes('node_modules')) {
        continue;
      }

      const manifest = await loadManifest(manifestUri.fsPath);
      if (!manifest) {
        continue;
      }

      const manifestName = asString(manifest.value.name);
      if (manifestName !== expectation.packageName) {
        continue;
      }

      const manifestVersion = asString(manifest.value.version);
      if (!workspaceSpecMatches(expectation.versionSpec, manifestVersion)) {
        continue;
      }

      return buildManifestTarget(manifest, true);
    }
  }

  return undefined;
}

async function resolveNodeModulesDependency(
  currentPackageDir: string,
  entry: DependencyEntry,
  token?: vscode.CancellationToken,
): Promise<ResolvedTarget | undefined> {
  const expectation = getDependencyExpectation(entry);
  const candidates: LoadedManifest[] = [];
  const packagePathParts = expectation.lookupName.split('/');

  let cursor = currentPackageDir;
  while (true) {
    if (token?.isCancellationRequested) {
      return undefined;
    }

    const manifestPath = path.join(cursor, 'node_modules', ...packagePathParts, 'package.json');
    const manifest = await loadManifest(manifestPath);
    if (manifest) {
      candidates.push(manifest);
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }

    cursor = parent;
  }

  if (candidates.length === 0) {
    return undefined;
  }

  const verified = candidates.find((candidate) => {
    const installedName = asString(candidate.value.name);
    const installedVersion = asString(candidate.value.version);
    return (
      installedName === expectation.packageName &&
      dependencySpecMatches(expectation.versionSpec, installedVersion)
    );
  });

  if (verified) {
    return buildManifestTarget(verified, false);
  }

  const nearest = candidates.find(
    (candidate) => asString(candidate.value.name) === expectation.packageName,
  );
  return buildManifestTarget(nearest ?? candidates[0], false);
}

async function resolveFileLikeDependency(
  currentPackageDir: string,
  spec: string,
): Promise<ResolvedTarget | undefined> {
  const trimmed = spec.trim();
  const prefix = ['file:', 'link:'].find((candidate) => trimmed.startsWith(candidate));
  if (!prefix) {
    return undefined;
  }

  const rawTarget = decodeURIComponent(trimmed.slice(prefix.length));
  const resolved = path.resolve(currentPackageDir, rawTarget);
  const target = await resolveFileOrDirectoryTarget(resolved, true);
  if (!target) {
    return undefined;
  }

  const manifestPath = await resolveManifestLikePath(resolved);
  const manifest = await loadManifest(manifestPath);

  return {
    uri: vscode.Uri.file(target),
    selectionRange: zeroRange(),
    manifestUri: vscode.Uri.file(manifestPath),
    manifestSelectionRange: zeroRange(),
    resolvedPackageName: asString(manifest?.value.name) ?? path.basename(path.dirname(target)),
    resolvedVersion: asString(manifest?.value.version),
  };
}

function isWorkspaceProtocol(spec: string): boolean {
  return spec.trim().startsWith('workspace:');
}

function workspaceSpecMatches(spec: string, version: string | undefined): boolean {
  const workspaceRange = spec.trim().slice('workspace:'.length).trim();
  if (!workspaceRange || workspaceRange === '*' || workspaceRange === '^' || workspaceRange === '~') {
    return true;
  }

  if (!version) {
    return false;
  }

  const validRange = semver.validRange(workspaceRange, { loose: true });
  if (!validRange) {
    return true;
  }

  return semver.satisfies(version, validRange, {
    includePrerelease: true,
    loose: true,
  });
}

function dependencySpecMatches(spec: string, version: string | undefined): boolean {
  if (!version) {
    return false;
  }

  const trimmed = spec.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'latest') {
    return true;
  }

  if (trimmed.startsWith('workspace:')) {
    return workspaceSpecMatches(trimmed, version);
  }

  const range = semver.validRange(trimmed, { loose: true });
  if (!range) {
    return true;
  }

  return semver.satisfies(version, range, {
    includePrerelease: true,
    loose: true,
  });
}

function getDependencyEntryAtOffset(
  document: vscode.TextDocument,
  offset: number,
): DependencyEntry | undefined {
  const parsed = parsePackageJson(document.getText());
  if (!parsed) {
    return undefined;
  }

  return parsed.dependencies.find(
    (candidate) => offset >= candidate.keyStart && offset < candidate.keyEnd,
  );
}

function getDependencyExpectation(entry: DependencyEntry): DependencyExpectation {
  const aliasSpec = parseNpmAliasSpec(entry.spec);

  return {
    lookupName: entry.name,
    packageName: aliasSpec?.packageName ?? entry.name,
    versionSpec: aliasSpec?.versionSpec ?? entry.spec,
  };
}

function parseNpmAliasSpec(spec: string): NpmAliasSpec | undefined {
  const trimmed = spec.trim();
  if (!trimmed.startsWith('npm:')) {
    return undefined;
  }

  const target = trimmed.slice('npm:'.length).trim();
  if (!target) {
    return undefined;
  }

  if (target.startsWith('@')) {
    const versionSeparator = target.lastIndexOf('@');
    if (versionSeparator <= 0) {
      return {
        packageName: target,
        versionSpec: '',
      };
    }

    return {
      packageName: target.slice(0, versionSeparator),
      versionSpec: target.slice(versionSeparator + 1),
    };
  }

  const versionSeparator = target.indexOf('@');
  if (versionSeparator <= 0) {
    return {
      packageName: target,
      versionSpec: '',
    };
  }

  return {
    packageName: target.slice(0, versionSeparator),
    versionSpec: target.slice(versionSeparator + 1),
  };
}

async function buildManifestTarget(
  manifest: LoadedManifest,
  preferSource: boolean,
): Promise<ResolvedTarget> {
  const targetPath = (await resolveManifestTargetPath(manifest, preferSource)) ?? manifest.filePath;
  const manifestPath = await resolveManifestLikePath(manifest.dirPath);

  return {
    uri: vscode.Uri.file(targetPath),
    selectionRange: zeroRange(),
    manifestUri: vscode.Uri.file(manifestPath),
    manifestSelectionRange: zeroRange(),
    resolvedPackageName: asString(manifest.value.name) ?? path.basename(manifest.dirPath),
    resolvedVersion: asString(manifest.value.version),
  };
}

async function resolveManifestTargetPath(
  manifest: LoadedManifest,
  preferSource: boolean,
): Promise<string | undefined> {
  const prioritizedFields = preferSource
    ? ['source', 'types', 'typings', 'module', 'main']
    : ['types', 'typings', 'module', 'main', 'source'];

  for (const field of prioritizedFields) {
    const value = asString(manifest.value[field]);
    if (!value) {
      continue;
    }

    const resolved = await resolvePackageEntryPath(
      manifest.dirPath,
      value,
      preferSource && field === 'source',
    );
    if (resolved) {
      return resolved;
    }
  }

  const fallbackCandidates = preferSource
    ? [
        'src/index.ts',
        'src/index.tsx',
        'src/index.js',
        'src/index.jsx',
        'src/index.mts',
        'src/index.cts',
        'index.ts',
        'index.tsx',
        'index.js',
        'index.jsx',
        'package.json',
      ]
    : ['index.d.ts', 'index.js', 'index.mjs', 'index.cjs', 'package.json'];

  for (const candidate of fallbackCandidates) {
    const absolutePath = path.join(manifest.dirPath, candidate);
    if (await fileExists(absolutePath)) {
      return absolutePath;
    }
  }

  return undefined;
}

async function resolvePackageEntryPath(
  dirPath: string,
  entry: string,
  preferSource: boolean,
): Promise<string | undefined> {
  const rawPath = entry.startsWith('file:') ? decodeURIComponent(entry.slice('file:'.length)) : entry;
  const candidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(dirPath, rawPath);

  const direct = await resolveFileOrDirectoryTarget(candidate, preferSource);
  if (direct) {
    return direct;
  }

  if (path.extname(candidate)) {
    return undefined;
  }

  for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts']) {
    const withExtension = await resolveFileOrDirectoryTarget(`${candidate}${extension}`, preferSource);
    if (withExtension) {
      return withExtension;
    }
  }

  return undefined;
}

async function resolveFileOrDirectoryTarget(
  candidatePath: string,
  preferSource: boolean,
): Promise<string | undefined> {
  const stats = await statSafe(candidatePath);
  if (!stats) {
    return undefined;
  }

  if (stats.isFile()) {
    return candidatePath;
  }

  if (!stats.isDirectory()) {
    return undefined;
  }

  const manifest = await loadManifest(path.join(candidatePath, 'package.json'));
  if (manifest) {
    return (await resolveManifestTargetPath(manifest, preferSource)) ?? manifest.filePath;
  }

  const indexCandidates = preferSource
    ? ['src/index.ts', 'src/index.tsx', 'src/index.js', 'index.ts', 'index.tsx', 'index.js']
    : ['index.d.ts', 'index.ts', 'index.js'];

  for (const relativePath of indexCandidates) {
    const fullPath = path.join(candidatePath, relativePath);
    if (await fileExists(fullPath)) {
      return fullPath;
    }
  }

  return undefined;
}

async function resolveManifestLikePath(dirPath: string): Promise<string> {
  const stats = await statSafe(dirPath);
  const baseDir = stats?.isDirectory() ? dirPath : path.dirname(dirPath);

  const packageJsonPath = path.join(baseDir, 'package.json');
  if (await fileExists(packageJsonPath)) {
    return packageJsonPath;
  }

  const packagesJsonPath = path.join(baseDir, 'packages.json');
  if (await fileExists(packagesJsonPath)) {
    return packagesJsonPath;
  }

  return packageJsonPath;
}

async function loadManifest(filePath: string): Promise<LoadedManifest | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = parsePackageJson(content);
    if (!parsed || !isObject(parsed.value)) {
      return undefined;
    }

    return {
      filePath,
      dirPath: path.dirname(filePath),
      value: parsed.value,
    };
  } catch {
    return undefined;
  }
}

function parsePackageJson(text: string): ParsedPackageJson | undefined {
  try {
    const parser = new JsonLikeParser(text);
    return parser.parse();
  } catch {
    return undefined;
  }
}

class JsonLikeParser {
  private readonly tokens: JsonToken[];

  private index = 0;

  private readonly dependencies: DependencyEntry[] = [];

  constructor(text: string) {
    this.tokens = tokenize(text);
  }

  public parse(): ParsedPackageJson {
    const value = this.parseValue([]);
    return {
      value: value.value,
      dependencies: this.dependencies,
    };
  }

  private parseValue(pathSegments: string[]): { value: unknown } {
    const token = this.peek();
    if (!token) {
      throw new Error('Unexpected end of file');
    }

    switch (token.type) {
      case 'braceL':
        return this.parseObject(pathSegments);
      case 'bracketL':
        return this.parseArray(pathSegments);
      case 'string':
      case 'literal':
        this.index += 1;
        return { value: token.value };
      default:
        throw new Error(`Unexpected token: ${token.type}`);
    }
  }

  private parseObject(pathSegments: string[]): { value: Record<string, unknown> } {
    this.expect('braceL');

    const result: Record<string, unknown> = {};
    if (this.match('braceR')) {
      this.expect('braceR');
      return { value: result };
    }

    while (true) {
      const keyToken = this.expect('string');
      const key = String(keyToken.value);

      this.expect('colon');
      const child = this.parseValue([...pathSegments, key]);
      result[key] = child.value;

      if (DEPENDENCY_SECTIONS.has(pathSegments[0]) && pathSegments.length === 1 && typeof child.value === 'string') {
        this.dependencies.push({
          name: key,
          spec: child.value,
          section: pathSegments[0],
          keyStart: keyToken.start,
          keyEnd: keyToken.end,
        });
      }

      if (this.match('comma')) {
        this.expect('comma');
        if (this.match('braceR')) {
          this.expect('braceR');
          break;
        }
      } else {
        this.expect('braceR');
        break;
      }
    }

    return { value: result };
  }

  private parseArray(pathSegments: string[]): { value: unknown[] } {
    this.expect('bracketL');

    const result: unknown[] = [];
    let itemIndex = 0;
    if (this.match('bracketR')) {
      this.expect('bracketR');
      return { value: result };
    }

    while (true) {
      const child = this.parseValue([...pathSegments, String(itemIndex)]);
      result.push(child.value);
      itemIndex += 1;

      if (this.match('comma')) {
        this.expect('comma');
        if (this.match('bracketR')) {
          this.expect('bracketR');
          break;
        }
      } else {
        this.expect('bracketR');
        break;
      }
    }

    return { value: result };
  }

  private peek(): JsonToken | undefined {
    return this.tokens[this.index];
  }

  private match(type: JsonTokenType): boolean {
    return this.peek()?.type === type;
  }

  private expect(type: JsonTokenType): JsonToken {
    const token = this.peek();
    if (!token || token.type !== type) {
      throw new Error(`Expected ${type}`);
    }

    this.index += 1;
    return token;
  }
}

function tokenize(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    if (char === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index + 1 < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }

    if (char === '"') {
      const start = index;
      index += 1;

      while (index < text.length) {
        const current = text[index];
        if (current === '\\') {
          index += 2;
          continue;
        }

        index += 1;
        if (current === '"') {
          break;
        }
      }

      const raw = text.slice(start, index);
      tokens.push({
        type: 'string',
        start,
        end: index,
        value: JSON.parse(raw),
      });
      continue;
    }

    const punctuation = singleCharToken(char);
    if (punctuation) {
      tokens.push({
        type: punctuation,
        start: index,
        end: index + 1,
      });
      index += 1;
      continue;
    }

    const start = index;
    while (index < text.length && !isValueBoundary(text[index])) {
      index += 1;
    }

    const raw = text.slice(start, index);
    tokens.push({
      type: 'literal',
      start,
      end: index,
      value: JSON.parse(raw),
    });
  }

  return tokens;
}

function singleCharToken(char: string): JsonTokenType | undefined {
  switch (char) {
    case '{':
      return 'braceL';
    case '}':
      return 'braceR';
    case '[':
      return 'bracketL';
    case ']':
      return 'bracketR';
    case ':':
      return 'colon';
    case ',':
      return 'comma';
    default:
      return undefined;
  }
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

function isValueBoundary(char: string): boolean {
  return (
    isWhitespace(char) ||
    char === ',' ||
    char === ':' ||
    char === '{' ||
    char === '}' ||
    char === '[' ||
    char === ']'
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function zeroRange(): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
}

function pathSegments(targetPath: string): string[] {
  return targetPath.split(path.sep).filter(Boolean);
}

async function fileExists(targetPath: string): Promise<boolean> {
  const stats = await statSafe(targetPath);
  return Boolean(stats?.isFile());
}

async function statSafe(targetPath: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(targetPath);
  } catch {
    return undefined;
  }
}
