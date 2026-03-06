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