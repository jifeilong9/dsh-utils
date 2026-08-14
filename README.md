# dsh-utils

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)（DSH）Web UI 实用插件集合：**opencode 用量徽章** + **工作区文件管理器**。

安装一次、重启 `dsh web` 即生效，所有功能都挂在官方插件机制上（profile bundle + Typert Remote），不修改 DSH 源码。

---

## 功能特性

### 1. opencode 用量徽章

当会话使用的模型来自 `opencode-go` 提供方时，徽章显示在模型选择器左侧：

- **常显**：`用量 8% · 周 5%`（滚动 + 周用量百分比）
- **悬停**：月用量 + 三个窗口的重置倒计时（`滚动 10分钟 · 周 2天 · 月 29天`）
- **点击**：立即刷新；自动刷新每 10 分钟一次
- **颜色预警**：`<70%` 正常 · `70–89%` 橙色 · `≥90%` 红色
- **断网兜底**：请求失败自动重试（3 次），仍失败时回退显示上次成功数据并标注"缓存数据"

### 2. 工作区文件管理器

侧边栏"工作区"标题行的 **文件图标**（与搜索 / 视图 / 添加工作区图标排在一起）打开右侧文件面板：

- **文件树**：懒加载目录、目录优先排序、隐藏 `.git`、多级展开
- **类型图标**：按扩展名显示彩色文件图标（内嵌 [material-icon-theme](https://github.com/PKief/vscode-material-icon-theme)，140+ 扩展名映射）
- **文件名搜索**：实时搜索（精确 > 前缀 > 子串排序，自动跳过 `.git` / `node_modules`）
- **代码预览**：语法高亮（[highlight.js](https://github.com/highlightjs/highlight.js) + GitHub Dark 主题，31 种语言，自动识别）
- **图片预览**：png / jpg / gif / webp / svg / ico / bmp / avif 直接预览
- **编辑保存**：修改后保存，带 mtime 冲突保护（文件在磁盘上被改动会拒绝覆盖）
- **新建文件 / 删除**：文件右键菜单或预览页按钮删除，删除前弹确认框；Windows 下移入**系统回收站**（Linux / macOS 为永久删除，host 端已注明）；拒绝操作根目录和 `.git` 路径
- **拖动移动**：把文件 / 文件夹直接拖到目标文件夹上即可移动（拖到空白处移回工作区根目录；同名冲突会拒绝并提示）；目录懒加载状态自动刷新
- **多工作区**：下拉切换，记住上次选择（localStorage）
- **安全边界**：所有文件操作在 host 端强制校验——根必须是已注册工作区，相对路径防穿越（realpath + 符号链接防护），浏览器永远访问不到工作区以外的文件

---

## 安装

```sh
# 方式一：本地 tarball（构建产物）
dsh plugin --profile web add ./dsh-utils-0.4.4.tgz

# 方式二：发布到 npm 后
dsh plugin --profile web add dsh-utils
```

安装后**重启 `dsh web`**，侧边栏出现文件图标、模型选择器旁出现用量徽章即生效。

> 首次安装若提示 `ERR_PNPM_IGNORED_BUILDS`，把 pnpm 打印的包键加入 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后重新执行即可。

---

## 用量接口与 API Key

用量徽章从 `https://opencode.ai/zen/go/v1/usage` 读取数据（通过 host 端代理，**Key 不进入浏览器**）。

**插件包内不包含任何 API Key**，运行时按以下链路解析（与模型路由共用同一份配置）：

1. 模型配置 `llm-pi-ai.providers.<provider>.apiKeyEnv` 声明的**引用名**（如 `OPENCODE_GO_API_KEY`）
2. 该引用通过 DSH 凭据服务解析（web 的 Models 页面写入 `~/.dsh/.credentials.yaml`）
3. 环境变量兜底

非常规部署可通过 profile patch 覆盖：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-utils
  config:
    apiKey: sk-...      # 可选：覆盖模型配置查找
    endpoint: https://opencode.ai/zen/go/v1/usage  # 可选：默认即此地址
```

### 单独使用用量查询

不想装插件也可以直接用 `examples/opencode-usage.mjs`（零依赖，Node.js 18+，内置 fetch）：

```sh
node examples/opencode-usage.mjs --key <你的 key>
OPENCODE_GO_API_KEY=<你的 key> node examples/opencode-usage.mjs --json
```

输出示例：

```
opencode go 用量报告
rolling   5%   重置于 2026-08-14T08:17:35.587Z（28分钟后）
weekly    8%   重置于 2026-08-17T00:00:00.587Z（2天16小时后）
monthly   4%   重置于 2026-09-12T02:12:28.587Z（28天18小时后）
```

也可以作为库 import：`fetchUsageReport(apiKey)` 返回 `{ rolling, weekly, monthly }` 三个时间窗（各含 `status` / `percent` / `resetsAt`），带 3 次重试 + 30s 超时与结构校验。

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
│   ├── index.js    # host 端：opencodeUsage / workspaceFiles Typert Remote
│   └── client.js   # client 端：用量徽章 + 文件管理器（含图标与高亮数据）
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
