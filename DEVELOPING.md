# 开发维护

以下工具仅用于维护代码。安装和使用扩展无需 Node.js、Python 或第三方依赖，`extension/` 中已包含可直接运行的全部文件。

运行测试与构建脚本需要 Node.js 22 或更新版本。测试与检查无需下载 npm 包：

```sh
npm test
npm run check
```

- `extension/`：可直接加载的扩展。
- `ui/`：界面源码，修改后运行 `npm run build:ui`。
- `assets/icon.svg`：图标源码。运行 `npm ci` 后，用 `npm run build:icons` 生成各尺寸图标。Sharp 仅为开发依赖。
- `tests/`：解析、输入、媒体识别、运行状态与面板位置测试。

运行 `python3 scripts/package.py` 生成安装包，输出到 `dist/`，仅包含扩展、歌词示例和本说明。

