# dsh-utils

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)（DSH）Web UI 插件：**工作区文件管理器**。

安装一次、重启 `dsh web` 即生效，所有功能都挂在官方插件机制上（profile bundle + Typert Remote），不修改 DSH 源码。

> opencode 用量徽章已拆分为独立插件 [opencode-usage-badge](../opencode-usage-badge)，本插件只包含文件管理器。

---

## 功能特性

侧边栏"工作区"标题行的 **文件图标**（与搜索 / 视图 / 添加工作区图标排在一起）打开右侧文件面板：

- **文件树**：懒加载目录、目录优先排序、隐藏 `.git`、多级展开
- **类型图标**：按扩展名显示彩色文件图标（内嵌 [material-icon-theme](https://github.com/PKief/vscode-material-icon-theme)，140+ 扩展名映射）
- **文件名搜索**：实时搜索（精确 > 前缀 > 子串排序，自动跳过 `.git` / `node_modules`）
- **代码预览**：语法高亮（[highlight.js](https://github.com/highlightjs/highlight.js) + GitHub Dark 主题，31 种语言，自动识别）
- **图片预览**：png / jpg / gif / webp / svg / ico / bmp / avif 直接预览
- **编辑保存**：修改后保存，带 mtime 冲突保护（文件在磁盘上被改动会拒绝覆盖）
- **新建文件 / 删除**：文件右键菜单或预览页按钮删除，删除前弹确认框；Windows 下移入**系统回收站**（Linux / macOS 为永久删除，host 端已注明）；拒绝操作根目录和 `.git` 路径
- **拖动移动**：把文件 / 文件夹直接拖到目标文件夹上即可移动（拖到空白处移回工作区根目录；同名冲突会拒绝并提示）；目录懒加载状态自动刷新
- **在终端中打开**：文件夹右键菜单直接打开宿主机终端并以该目录为工作目录；**头部终端按钮**或**文件树空白处右键**则以当前工作区根目录打开——Windows 优先 Windows Terminal（不可用时回退 `cmd`），macOS 用 Terminal.app，Linux 依次尝试 gnome-terminal / konsole / xfce4-terminal / alacritty / kitty / xterm；`.git` 路径与工作区外路径一律拒绝
- **多工作区**：下拉切换，记住上次选择（localStorage）
- **安全边界**：所有文件操作在 host 端强制校验——根必须是已注册工作区，相对路径防穿越（realpath + 符号链接防护），浏览器永远访问不到工作区以外的文件

---

## 安装

```sh
# 方式一：本地 tarball（构建产物）
dsh plugin --profile web add ./dsh-utils-0.5.0.tgz

# 方式二：发布到 npm 后
dsh plugin --profile web add dsh-utils
```

安装后**重启 `dsh web`**，侧边栏出现文件图标即生效。

> 首次安装若提示 `ERR_PNPM_IGNORED_BUILDS`，把 pnpm 打印的包键加入 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后重新执行即可。

---

## 开发与构建

```sh
pnpm install          # 安装构建依赖（esbuild、highlight.js，仅开发用）
```

```sh
node build.mjs        # 构建 client bundle（src/client.js → lib/client.js）
node gen-icons.mjs <material-icons.json> <icons-dir> src/client.js   # 重新生成文件类型图标数据
pnpm pack             # 打包 tarball
```

### 目录结构

```
├── src/            # client 源码（浏览器端，esbuild 构建）
├── lib/            # 构建产物（host 插件 + client bundle）
│   ├── index.js    # host 端：workspaceFiles Typert Remote
│   └── client.js   # client 端：文件管理器（含图标与高亮数据）
├── build.mjs       # client 构建脚本
├── gen-icons.mjs   # 文件类型图标数据生成脚本
├── cordis.patch.yml
└── dsh.plugin.json
```

---

## 兼容性

- 依赖 DSH 的 profile bundle / client plugin 机制（`dsh plugin` 安装）
- 前端 DOM 结构适配基于 CSS Module 类名后缀与 `data-slot` 属性，若 DSH Web UI 大规模改版可能需要微调注入选择器
- Node.js >= 22（host 端使用 `node:fs/promises`、`AbortSignal.timeout` 等）

---

## 协议与致谢

- 本项目：MIT（见 [LICENSE](LICENSE)）
- 文件类型图标：[vscode-material-icon-theme](https://github.com/PKief/vscode-material-icon-theme)（MIT, PKief）
- 语法高亮：[highlight.js](https://github.com/highlightjs/highlight.js)（BSD-3-Clause）
- 文件面板设计参考：[dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)（BSD-3-Clause, zhu1090093659）
