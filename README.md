# Dep Jump

在 `package.json`（以及兼容的 `packages.json`）里，对 `dependencies`、`devDependencies`、`peerDependencies`、`optionalDependencies` 中的依赖名执行 `F12` / `Ctrl+Click`，即可跳转到对应依赖。

支持两类解析：

- 普通依赖：按当前 `package.json` 所在目录的 Node.js 解析路径逐级查找 `node_modules`，并用 semver 校验已安装版本是否满足声明版本。
- alias 依赖：支持 `npm:` 别名写法，例如 `npm:@universe-design/icons@3.186.1`，会按别名目录查找，但用真实包名和版本做校验。
- `workspace:*` 依赖：在当前 VS Code 工作区内查找同名 package，并优先跳到源码入口（如 `source`、`src/index.ts` 等），否则回退到该 package 的 `package.json`。

交互方式：

- `Cmd/Ctrl + Click`：优先走插件提供的文档链接，打开目标包的 `package.json`（兼容 `packages.json`）并自动在 Explorer 中执行 reveal。
- `F12`：走 VS Code 的 Go to Definition，同样会打开目标包的 `package.json`（兼容 `packages.json`）。
- Hover：悬停依赖名时会显示解析后的真实包名、版本信息、将打开的清单文件，以及解析到的入口文件。

## 开发

```bash
npm install
npm run compile
```

按 `F5` 启动 Extension Development Host 进行调试。

## 发布

先把 `package.json` 中的 `publisher`、`repository`、`homepage`、`bugs` 替换成你自己的真实值。

本地手动打包：

```bash
npm run package
```

生成 `.vsix` 后可本地安装验证；确认无误后再发布：

```bash
npm run publish:patch
```

GitHub Actions 自动发布：

- 在 GitHub 仓库的 `Settings > Secrets and variables > Actions` 中新增 `VSCE_PAT`
- 把 `package.json` 里的版本号改好
- 推送一个形如 `v0.0.1` 的 tag，且必须和 `package.json.version` 一致
- workflow 会自动打包并发布，同时把 `.vsix` 作为 artifact 上传

也可以在 GitHub Actions 页面手动触发 `Publish Extension`，将 `publish` 勾选为 `true`。
