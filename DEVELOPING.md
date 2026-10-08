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

DistroKid 的 `/potato/` 歌词同步页面使用 WaveSurfer Web Audio，没有 HTML audio 元素。工具栏入口会先在该页面的 MAIN world 注入 `page-clock-main.js`，再加载隔离环境中的面板。`page-clock.js` 通过同步 DOM 事件读取实际播放器时间，供原有调度器使用，不根据点击时刻推算时间。桥接只允许读取状态、暂停已绑定播放器和清理监听；不接受任意脚本、URL 或属性路径。换歌、跳转进度或桥接失效都会停止对齐并释放输入。

运行 `python3 scripts/package.py` 生成安装包，输出到 `dist/`，仅包含扩展、歌词示例和本说明。
