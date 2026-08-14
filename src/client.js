"use strict";

/**
 * dsh-utils client plugin: the browser half.
 *
 * Workspace file manager: a "文件" entry below the sidebar New Session
 * button toggles a right-side file panel: file tree (lazy directories),
 * filename search, image preview, syntax-highlighted text preview,
 * edit-and-save with mtime conflict protection, delete with confirm,
 * drag-and-drop move, and open-in-terminal. All operations go through the
 * workspace-gated `workspaceFiles` Remote.
 *
 * This file is the esbuild source; build.mjs wraps it in the ModuleLoader
 * handshake into lib/client.js. highlight.js and the theme CSS are bundled
 * in; react / react-dom / @deepseek-ai/* stay external.
 */
const React = require("react");
const { createRoot } = require("react-dom/client");
const hljs = require("highlight.js/lib/core");
// highlight.js 11 language modules do NOT self-register; register explicitly.
const useLang = (name, mod) => hljs.registerLanguage(name, typeof mod === "function" ? mod : mod.default);
useLang("bash", require("highlight.js/lib/languages/bash"));
useLang("c", require("highlight.js/lib/languages/c"));
useLang("cpp", require("highlight.js/lib/languages/cpp"));
useLang("csharp", require("highlight.js/lib/languages/csharp"));
useLang("css", require("highlight.js/lib/languages/css"));
useLang("diff", require("highlight.js/lib/languages/diff"));
useLang("dockerfile", require("highlight.js/lib/languages/dockerfile"));
useLang("go", require("highlight.js/lib/languages/go"));
useLang("graphql", require("highlight.js/lib/languages/graphql"));
useLang("ini", require("highlight.js/lib/languages/ini"));
useLang("java", require("highlight.js/lib/languages/java"));
useLang("javascript", require("highlight.js/lib/languages/javascript"));
useLang("json", require("highlight.js/lib/languages/json"));
useLang("kotlin", require("highlight.js/lib/languages/kotlin"));
useLang("less", require("highlight.js/lib/languages/less"));
useLang("lua", require("highlight.js/lib/languages/lua"));
useLang("makefile", require("highlight.js/lib/languages/makefile"));
useLang("markdown", require("highlight.js/lib/languages/markdown"));
useLang("php", require("highlight.js/lib/languages/php"));
useLang("plaintext", require("highlight.js/lib/languages/plaintext"));
useLang("powershell", require("highlight.js/lib/languages/powershell"));
useLang("python", require("highlight.js/lib/languages/python"));
useLang("ruby", require("highlight.js/lib/languages/ruby"));
useLang("rust", require("highlight.js/lib/languages/rust"));
useLang("scss", require("highlight.js/lib/languages/scss"));
useLang("shell", require("highlight.js/lib/languages/shell"));
useLang("sql", require("highlight.js/lib/languages/sql"));
useLang("swift", require("highlight.js/lib/languages/swift"));
useLang("typescript", require("highlight.js/lib/languages/typescript"));
useLang("xml", require("highlight.js/lib/languages/xml"));
useLang("yaml", require("highlight.js/lib/languages/yaml"));
const themeCss = require("./theme.css");

/** Locale namespace owned by this plugin. */
const NS = "dsh-utils";

const zh = {
  filesEntry: "文件",
  filesTitle: "工作区文件",
  filesWorkspace: "工作区",
  filesRefresh: "刷新",
  filesClose: "关闭",
  filesSearch: "搜索文件名…",
  filesLoading: "加载中…",
  filesEmpty: "（空）",
  filesPreview: "预览",
  filesEdit: "编辑",
  filesSave: "保存",
  filesCancel: "取消",
  filesDelete: "删除",
  filesDeleteConfirm: "确定删除 {path}？\n（将移入电脑回收站）",
  filesRecycleHint: "将移入电脑回收站",
  filesMoved: "已移动",
  filesMoveConflict: "目标位置已存在同名文件",
  filesTerminal: "在终端中打开",
  filesTerminalRoot: "在终端中打开工作区根目录",
  filesBinary: "二进制文件，暂不支持预览",
  filesTruncated: "（内容过长，仅显示前 200000 字符）",
  filesSaved: "已保存",
  filesWriteConflict: "文件已在磁盘上被修改，请重新加载后再保存",
  filesError: "操作失败：{message}",
  filesNoWorkspace: "暂无工作区",
  filesSelectWorkspace: "选择工作区",
  filesNewFile: "新建文件",
  filesNewFileName: "输入文件名…",
  filesCreate: "创建",
};

const en = {
  filesEntry: "Files",
  filesTitle: "Workspace Files",
  filesWorkspace: "Workspace",
  filesRefresh: "Refresh",
  filesClose: "Close",
  filesSearch: "Search file names…",
  filesLoading: "Loading…",
  filesEmpty: "(empty)",
  filesPreview: "Preview",
  filesEdit: "Edit",
  filesSave: "Save",
  filesCancel: "Cancel",
  filesDelete: "Delete",
  filesDeleteConfirm: "Delete {path}?\n(It will be moved to the recycle bin)",
  filesRecycleHint: "Moved to the recycle bin",
  filesMoved: "Moved",
  filesMoveConflict: "A file with the same name already exists at the destination",
  filesTerminal: "Open in Terminal",
  filesTerminalRoot: "Open workspace root in terminal",
  filesBinary: "Binary file, preview not supported",
  filesTruncated: "(content truncated to the first 200000 chars)",
  filesSaved: "Saved",
  filesWriteConflict: "file changed on disk; reload it before saving again",
  filesError: "Operation failed: {message}",
  filesNoWorkspace: "No workspace",
  filesSelectWorkspace: "Select workspace",
  filesNewFile: "New file",
  filesNewFileName: "Enter a file name…",
  filesCreate: "Create",
};

/** Passthrough wire codec (the strict registry only requires parse()). */
const PASS_SCHEMA = { parse: (value) => value };

/** One JSON parameter descriptor (passthrough codec). */
function jsonParam(name, acceptsUndefined = false) {
  return {
    name,
    wire: name,
    source: "json",
    ...(acceptsUndefined ? { acceptsUndefined: true } : {}),
    codec: { mode: "strict", typeSymbol: "dsh-utils#" + name, schema: PASS_SCHEMA },
  };
}

/** The workspaceFiles Remote namespace's client contribution. */
const WORKSPACE_FILES_REMOTE = {
  package: "dsh-utils",
  descriptors: [
    {
      id: "dsh-utils#workspaceFiles/workspaces",
      service: "workspaceFiles",
      namespace: "workspaceFiles",
      method: "workspaces",
      invocation: { kind: "direct" },
      parameters: [],
      cancellation: { parameter: "signal" },
      result: { mode: "strict", typeSymbol: "dsh-utils#WorkspaceList", schema: PASS_SCHEMA },
    },
    {
      id: "dsh-utils#workspaceFiles/list",
      service: "workspaceFiles",
      namespace: "workspaceFiles",
      method: "list",
      invocation: { kind: "direct" },
      parameters: [jsonParam("root"), jsonParam("rel")],
      cancellation: { parameter: "signal" },
      result: { mode: "strict", typeSymbol: "dsh-utils#DirListing", schema: PASS_SCHEMA },
    },
    {
      id: "dsh-utils#workspaceFiles/read",
      service: "workspaceFiles",
      namespace: "workspaceFiles",
      method: "read",
      invocation: { kind: "direct" },
      parameters: [jsonParam("root"), jsonParam("rel")],
      cancellation: { parameter: "signal" },
      result: { mode: "strict", typeSymbol: "dsh-utils#FileRead", schema: PASS_SCHEMA },
    },
    {
      id: "dsh-utils#workspaceFiles/write",
      service: "workspaceFiles",
      namespace: "workspaceFiles",
      method: "write",
      invocation: { kind: "direct" },
      parameters: [jsonParam("root"), jsonParam("rel"), jsonParam("content"), jsonParam("baseMtime", true)],
      cancellation: { parameter: "signal" },
      result: { mode: "strict", typeSymbol: "dsh-utils#WriteResult", schema: PASS_SCHEMA },
    },
    {
      id: "dsh-utils#workspaceFiles/delete",
      service: "workspaceFiles",
      namespace: "workspaceFiles",
      method: "delete",
      invocation: { kind: "direct" },
      parameters: [jsonParam("root"), jsonParam("rel")],
      cancellation: { parameter: "signal" },
      result: { mode: "strict", typeSymbol: "dsh-utils#DeleteResult", schema: PASS_SCHEMA },
    },
    {
      id: "dsh-utils#workspaceFiles/move",
      service: "workspaceFiles",
      namespace: "workspaceFiles",
      method: "move",
      invocation: { kind: "direct" },
      parameters: [jsonParam("root"), jsonParam("from"), jsonParam("to")],
      cancellation: { parameter: "signal" },
      result: { mode: "strict", typeSymbol: "dsh-utils#MoveResult", schema: PASS_SCHEMA },
    },
    {
      id: "dsh-utils#workspaceFiles/openTerminal",
      service: "workspaceFiles",
      namespace: "workspaceFiles",
      method: "openTerminal",
      invocation: { kind: "direct" },
      parameters: [jsonParam("root"), jsonParam("rel")],
      cancellation: { parameter: "signal" },
      result: { mode: "strict", typeSymbol: "dsh-utils#TerminalOpen", schema: PASS_SCHEMA },
    },
    {
      id: "dsh-utils#workspaceFiles/search",
      service: "workspaceFiles",
      namespace: "workspaceFiles",
      method: "search",
      invocation: { kind: "direct" },
      parameters: [jsonParam("root"), jsonParam("query")],
      cancellation: { parameter: "signal" },
      result: { mode: "strict", typeSymbol: "dsh-utils#SearchView", schema: PASS_SCHEMA },
    },
  ],
};

// File-type icons embedded from material-icon-theme (MIT, PKief/vscode-material-icon-theme).
// Regenerate with: node gen-icons.mjs <material-icons.json> <icons-dir> <client-js>
// File-type icons embedded from material-icon-theme (MIT, PKief/vscode-material-icon-theme).
// Regenerate with: node gen-icons.mjs <material-icons.json> <icons-dir> <client-js>
const FILE_ICONS = {"svgs":["<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><path fill=\"#ffca28\" d=\"M2 2v12h12V2zm6 6h1v4a1.003 1.003 0 0 1-1 1H7a1.003 1.003 0 0 1-1-1v-1h1v1h1zm3 0h2v1h-2v1h1a1.003 1.003 0 0 1 1 1v1a1.003 1.003 0 0 1-1 1h-2v-1h2v-1h-1a1.003 1.003 0 0 1-1-1V9a1.003 1.003 0 0 1 1-1\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#00bcd4\" d=\"M16 12c7.444 0 12 2.59 12 4s-4.556 4-12 4-12-2.59-12-4 4.556-4 12-4m0-2c-7.732 0-14 2.686-14 6s6.268 6 14 6 14-2.686 14-6-6.268-6-14-6\"/><path fill=\"#00bcd4\" d=\"M16 14a2 2 0 1 0 2 2 2 2 0 0 0-2-2\"/><path fill=\"#00bcd4\" d=\"M10.458 5.507c2.017 0 5.937 3.177 9.006 8.493 3.722 6.447 3.757 11.687 2.536 12.392a.9.9 0 0 1-.457.1c-2.017 0-5.938-3.176-9.007-8.492C8.814 11.553 8.779 6.313 10 5.608a.9.9 0 0 1 .458-.1m-.001-2A2.87 2.87 0 0 0 9 3.875C6.13 5.532 6.938 12.304 10.804 19c3.284 5.69 7.72 9.493 10.74 9.493A2.87 2.87 0 0 0 23 28.124c2.87-1.656 2.062-8.428-1.804-15.124-3.284-5.69-7.72-9.493-10.74-9.493Z\"/><path fill=\"#00bcd4\" d=\"M21.543 5.507a.9.9 0 0 1 .457.1c1.221.706 1.186 5.946-2.536 12.393-3.07 5.316-6.99 8.493-9.007 8.493a.9.9 0 0 1-.457-.1C8.779 25.686 8.814 20.446 12.536 14c3.07-5.316 6.99-8.493 9.007-8.493m0-2c-3.02 0-7.455 3.804-10.74 9.493C6.939 19.696 6.13 26.468 9 28.124a2.87 2.87 0 0 0 1.457.369c3.02 0 7.455-3.804 10.74-9.493C25.061 12.304 25.87 5.532 23 3.876a2.87 2.87 0 0 0-1.457-.369\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" xml:space=\"preserve\" viewBox=\"0 0 16 16\"><path fill=\"#0288d1\" d=\"M2 2v12h12V2zm4 6h3v1H8v4H7V9H6zm5 0h2v1h-2v1h1a1.003 1.003 0 0 1 1 1v1a1.003 1.003 0 0 1-1 1h-2v-1h2v-1h-1a1.003 1.003 0 0 1-1-1V9a1.003 1.003 0 0 1 1-1\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#0288d1\" d=\"M16 12c7.444 0 12 2.59 12 4s-4.556 4-12 4-12-2.59-12-4 4.556-4 12-4m0-2c-7.732 0-14 2.686-14 6s6.268 6 14 6 14-2.686 14-6-6.268-6-14-6\"/><path fill=\"#0288d1\" d=\"M16 14a2 2 0 1 0 2 2 2 2 0 0 0-2-2\"/><path fill=\"#0288d1\" d=\"M10.458 5.507c2.017 0 5.937 3.177 9.006 8.493 3.722 6.447 3.757 11.687 2.536 12.392a.9.9 0 0 1-.457.1c-2.017 0-5.938-3.176-9.007-8.492C8.814 11.553 8.779 6.313 10 5.608a.9.9 0 0 1 .458-.1m-.001-2A2.87 2.87 0 0 0 9 3.875C6.13 5.532 6.938 12.304 10.804 19c3.284 5.69 7.72 9.493 10.74 9.493A2.87 2.87 0 0 0 23 28.124c2.87-1.656 2.062-8.428-1.804-15.124-3.284-5.69-7.72-9.493-10.74-9.493Z\"/><path fill=\"#0288d1\" d=\"M21.543 5.507a.9.9 0 0 1 .457.1c1.221.706 1.186 5.946-2.536 12.393-3.07 5.316-6.99 8.493-9.007 8.493a.9.9 0 0 1-.457-.1C8.779 25.686 8.814 20.446 12.536 14c3.07-5.316 6.99-8.493 9.007-8.493m0-2c-3.02 0-7.455 3.804-10.74 9.493C6.939 19.696 6.13 26.468 9 28.124a2.87 2.87 0 0 0 1.457.369c3.02 0 7.455-3.804 10.74-9.493C25.061 12.304 25.87 5.532 23 3.876a2.87 2.87 0 0 0-1.457-.369\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 -960 960 960\"><path fill=\"#f9a825\" d=\"M560-160v-80h120q17 0 28.5-11.5T720-280v-80q0-38 22-69t58-44v-14q-36-13-58-44t-22-69v-80q0-17-11.5-28.5T680-720H560v-80h120q50 0 85 35t35 85v80q0 17 11.5 28.5T840-560h40v160h-40q-17 0-28.5 11.5T800-360v80q0 50-35 85t-85 35zm-280 0q-50 0-85-35t-35-85v-80q0-17-11.5-28.5T120-400H80v-160h40q17 0 28.5-11.5T160-600v-80q0-50 35-85t85-35h120v80H280q-17 0-28.5 11.5T240-680v80q0 38-22 69t-58 44v14q36 13 58 44t22 69v80q0 17 11.5 28.5T280-240h120v80z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#e65100\" d=\"m4 4 2 22 10 2 10-2 2-22Zm19.72 7H11.28l.29 3h11.86l-.802 9.335L15.99 25l-6.635-1.646L8.93 19h3.02l.19 2 3.86.77 3.84-.77.29-4H8.84L8 8h16Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#7e57c2\" d=\"M20 18h-2v-2h-2v2c0 .193 0 .703 1.254 1.033A3.345 3.345 0 0 1 20 22h2v2h2v-2c0-.388-.562-.851-1.254-1.034C20.356 20.34 20 18.84 20 18m-3.254 2.966C14.356 20.34 14 18.84 14 18h-2v-2h-2v8h2v-2h4v2h2v-2c0-.388-.562-.851-1.254-1.034\"/><path fill=\"#7e57c2\" d=\"M24 4H4v20a4 4 0 0 0 4 4h16.16A3.84 3.84 0 0 0 28 24.16V8a4 4 0 0 0-4-4m2 14h-2v-2h-2v2c0 .193 0 .703 1.254 1.033A3.345 3.345 0 0 1 26 22v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1 2-2h2a2 2 0 0 1 2 2Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#ec407a\" d=\"M27.837 5.673a4.33 4.33 0 0 0-2.293-2.701c-2.362-1.261-6.11-1.298-9.548-.092a26.3 26.3 0 0 0-8.76 4.966c-2.752 2.542-3.438 4.925-3.189 6.194.523 2.668 3.274 4.539 5.485 6.042.418.284.822.559 1.175.816-1.429.76-4.261 2.444-5.088 4.248a3.88 3.88 0 0 0-.118 3.332A2.37 2.37 0 0 0 6.869 29.8a5.6 5.6 0 0 0 1.49.2 6.35 6.35 0 0 0 5.19-2.856 6.74 6.74 0 0 0 .864-5.382 7.3 7.3 0 0 1 2.044-.03 3.92 3.92 0 0 1 2.816 1.311 1.82 1.82 0 0 1 .423 1.262 1.55 1.55 0 0 1-.772 1.05c-.234.14-.586.355-.504.803.036.194.198.633.894.512a2.93 2.93 0 0 0 2.145-2.651 4 4 0 0 0-1.197-2.904 5.94 5.94 0 0 0-4.396-1.626 10.6 10.6 0 0 0-2.672.304 20 20 0 0 0-2.203-1.846c-1.712-1.3-3.33-2.529-3.235-4.26.125-2.263 2.468-4.532 6.964-6.744 4.016-1.976 7.254-2.037 8.944-1.438a2 2 0 0 1 1.204.883 2.77 2.77 0 0 1-.36 2.47 9.71 9.71 0 0 1-7.425 4.304 3.86 3.86 0 0 1-3.238-.757c-.278-.302-.593-.645-1.074-.383q-.565.31-.225 1.189a3.9 3.9 0 0 0 2.407 1.92 11.7 11.7 0 0 0 7.128-.671c3.527-1.35 6.681-5.202 5.756-8.787M11.895 24.475a4 4 0 0 1-.192.468 4.5 4.5 0 0 1-.753 1.081 2.83 2.83 0 0 1-2.533 1.107c-.056-.032-.078-.146-.085-.193a3.28 3.28 0 0 1 1.076-2.284 11.3 11.3 0 0 1 2.644-1.933 3.85 3.85 0 0 1-.157 1.754\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#0277bd\" d=\"M8 3a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2H3v2h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2v-2H8v-5a2 2 0 0 0-2-2 2 2 0 0 0 2-2V5h2V3m6 0a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1v2h-1a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2v-2h2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5h-2V3z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#42a5f5\" d=\"m14 10-4 3.5L6 10H4v12h4v-6l2 2 2-2v6h4V10zm12 6v-6h-4v6h-4l6 8 6-8z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#ffca28\" d=\"m14 10-4 3.5L6 10H4v12h4v-6l2 2 2-2v6h4V10zm12 6v-6h-4v6h-4l6 8 6-8z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\" viewBox=\"0 0 24 24\"><path d=\"M0 0h24v24H0z\"/><path fill=\"#42a5f5\" d=\"M8 16h8v2H8zm0-4h8v2H8zm6-10H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8zm4 18H6V4h7v5h5z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#0288d1\" d=\"M9.86 2A2.86 2.86 0 0 0 7 4.86v1.68h4.29c.39 0 .71.57.71.96H4.86A2.86 2.86 0 0 0 2 10.36v3.781a2.86 2.86 0 0 0 2.86 2.86h1.18v-2.68a2.85 2.85 0 0 1 2.85-2.86h5.25c1.58 0 2.86-1.271 2.86-2.851V4.86A2.86 2.86 0 0 0 14.14 2zm-.72 1.61c.4 0 .72.12.72.71s-.32.891-.72.891c-.39 0-.71-.3-.71-.89s.32-.711.71-.711\"/><path fill=\"#fdd835\" d=\"M17.959 7v2.68a2.85 2.85 0 0 1-2.85 2.859H9.86A2.85 2.85 0 0 0 7 15.389v3.75a2.86 2.86 0 0 0 2.86 2.86h4.28A2.86 2.86 0 0 0 17 19.14v-1.68h-4.291c-.39 0-.709-.57-.709-.96h7.14A2.86 2.86 0 0 0 22 13.64V9.86A2.86 2.86 0 0 0 19.14 7zM8.32 11.513l-.004.004.038-.004zm6.54 7.276c.39 0 .71.3.71.89a.71.71 0 0 1-.71.71c-.4 0-.72-.12-.72-.71s.32-.89.72-.89\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#757575\" d=\"M15 2H6a2.006 2.006 0 0 0-2 2v22a2.006 2.006 0 0 0 2 2h16a2 2 0 0 0 2-2V11Zm3 22H6v-2h12Zm0-4H6v-2h12Zm0-4H6v-2h12Zm-4-4V4l8 8Z\"/><path fill=\"#fbc02d\" d=\"M30.714 16H28v5h-9v7.714A1.286 1.286 0 0 0 20.286 30h6.428A1.286 1.286 0 0 0 28 28.714V26h-6v-1h8.714A1.286 1.286 0 0 0 32 23.714v-6.428A1.286 1.286 0 0 0 30.714 16M24 28h3v1h-3Z\" style=\"isolation:isolate\"/><path fill=\"#0288d1\" d=\"M25.714 12h-6.428A1.286 1.286 0 0 0 18 13.286V16h6v1h-8.714A1.286 1.286 0 0 0 14 18.286v6.428A1.286 1.286 0 0 0 15.286 26H18v-6h9v-6.714A1.286 1.286 0 0 0 25.714 12M22 14h-3v-1h3Z\" style=\"isolation:isolate\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#f57c00\" d=\"M6.2 18a22.7 22.7 0 0 0 9.8 2 22.7 22.7 0 0 0 9.8-2 10.002 10.002 0 0 1-19.6 0m19.6-4a22.7 22.7 0 0 0-9.8-2 22.7 22.7 0 0 0-9.8 2 10.002 10.002 0 0 1 19.6 0\"/><circle cx=\"27\" cy=\"5\" r=\"3\" fill=\"#757575\"/><circle cx=\"5\" cy=\"27\" r=\"3\" fill=\"#9e9e9e\"/><circle cx=\"5\" cy=\"5\" r=\"3\" fill=\"#616161\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#00acc1\" d=\"M2 12h4v2H2zm-2 4h6v2H0zm4 4h2v2H4zm16.954-5H14v3h3.239a4.42 4.42 0 0 1-3.531 2 2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 15.292 13a2.73 2.73 0 0 1 1.749.584l2.962-1.185A5.6 5.6 0 0 0 15.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 6.4 6.4 0 0 0 .003-1.5\"/><path fill=\"#00acc1\" d=\"M26.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 5.614 5.614 0 0 0-5.659-6.5m2.681 6.137A4.515 4.515 0 0 1 24.708 20a2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 26.292 13a2.65 2.65 0 0 1 2.053.858 2.86 2.86 0 0 1 .628 2.28Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#ff7043\" d=\"m30 12-4-2V6h-4l-2-4-4 2-4-2-2 4H6v4l-4 2 2 4-2 4 4 2v4h4l2 4 4-2 4 2 2-4h4v-4l4-2-2-4ZM6 16a9.9 9.9 0 0 1 .842-4H10v8H6.842A9.9 9.9 0 0 1 6 16m10 10a9.98 9.98 0 0 1-7.978-4H16v-2h-2v-2h4c.819.819.297 2.308 1.179 3.37a1.89 1.89 0 0 0 1.46.63h3.34A9.98 9.98 0 0 1 16 26m-2-12v-2h4a1 1 0 0 1 0 2Zm11.158 6H24a2.006 2.006 0 0 1-2-2 2 2 0 0 0-2-2 3 3 0 0 0 3-3q0-.08-.004-.161A3.115 3.115 0 0 0 19.83 10H8.022a9.986 9.986 0 0 1 17.136 10\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#f44336\" d=\"M4 26h24v2H4zM28 4H7a1 1 0 0 0-1 1v13a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-4h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 8h-4V6h4Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#1e88e5\" d=\"M4 26h24v2H4zM28 4H7a1 1 0 0 0-1 1v13a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-4h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 8h-4V6h4Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#f44336\" d=\"M22 10h2v4h-2z\"/><path fill=\"#f44336\" d=\"M28 2H4a2 2 0 0 0-2 2v24a2 2 0 0 0 2 2h24a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2m-2 12a2 2 0 0 1-2 2h-2v4a4 4 0 0 1-4 4h-8a4 4 0 0 1-4-4V8h18a2 2 0 0 1 2 2Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#0288d1\" d=\"M19.563 22A5.57 5.57 0 0 1 14 16.437v-2.873A5.57 5.57 0 0 1 19.563 8H24V2h-4.437A11.563 11.563 0 0 0 8 13.563v2.873A11.564 11.564 0 0 0 19.563 28H24v-6Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#0288d1\" d=\"M18.5 11a5.49 5.49 0 0 0-4.5 2.344V4H8v24h6V17a2 2 0 0 1 4 0v11h6V16.5a5.5 5.5 0 0 0-5.5-5.5\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#0288d1\" d=\"M28 14v-4h-2v4h-6v-4h-2v4h-4v2h4v4h2v-4h6v4h2v-4h4v-2z\"/><path fill=\"#0288d1\" d=\"M13.563 22A5.57 5.57 0 0 1 8 16.437v-2.873A5.57 5.57 0 0 1 13.563 8H18V2h-4.437A11.563 11.563 0 0 0 2 13.563v2.873A11.564 11.564 0 0 0 13.563 28H18v-6Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#0288d1\" d=\"M28 6V2h-2v4h-6V2h-2v4h-4v2h4v4h2V8h6v4h2V8h4V6zm-15.5 5A5.49 5.49 0 0 0 8 13.344V4H2v24h6V17a2 2 0 0 1 4 0v11h6V16.5a5.5 5.5 0 0 0-5.5-5.5\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#0288d1\" d=\"M30 14v-2h-2V8h-2v4h-2V8h-2v4h-2v2h2v2h-2v2h2v4h2v-4h2v4h2v-4h2v-2h-2v-2Zm-4 2h-2v-2h2Zm-12.437 6A5.57 5.57 0 0 1 8 16.437v-2.873A5.57 5.57 0 0 1 13.563 8H18V2h-4.437A11.563 11.563 0 0 0 2 13.563v2.873A11.564 11.564 0 0 0 13.563 28H18v-6Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#ab47bc\" d=\"m22 11.8-5.7 4.584L22 20.8zM7.24 23.68 4 21.64v-10.8l3.6-1.2 5.16 3.996L23.2 4 28 7v18.6L22 28l-9.192-8.808zm.36-5.28 2.232-2.064L7.6 14.2Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 500 500\"><path fill=\"#0288d1\" d=\"m236.249 36.066-213.94 213.94 213.94 213.94v-84.36l-129.7-129.7 129.7-129.7z\"/><path fill=\"#0288d1\" d=\"m236.249 156.017-93.622 93.62 93.622 93.622z\"/><path fill=\"#00b8d4\" d=\"m263.759 36.047 213.94 213.94-213.94 213.94v-84.36l129.7-129.7-129.7-129.7z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 24 24\"><defs><linearGradient id=\"a\" x1=\"1.725\" x2=\"22.185\" y1=\"22.67\" y2=\"1.982\" gradientTransform=\"translate(1.306 1.129)scale(.89324)\" gradientUnits=\"userSpaceOnUse\"><stop offset=\"0\" stop-color=\"#7c4dff\"/><stop offset=\".5\" stop-color=\"#d500f9\"/><stop offset=\"1\" stop-color=\"#ef5350\"/></linearGradient></defs><path fill=\"url(#a)\" d=\"M2.975 2.976v18.048h18.05v-.03l-4.478-4.511-4.48-4.515 4.48-4.515 4.443-4.477z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ff6e40\" d=\"M17.087 19.721c-2.36 1.36-5.59 1.5-8.86.1a13.8 13.8 0 0 1-6.23-5.32c.67.55 1.46 1 2.3 1.4 3.37 1.57 6.73 1.46 9.1 0-3.37-2.59-6.24-5.96-8.37-8.71-.45-.45-.78-1.01-1.12-1.51 8.28 6.05 7.92 7.59 2.41-1.01 4.89 4.94 9.43 7.74 9.43 7.74.16.09.25.16.36.22.1-.25.19-.51.26-.78.79-2.85-.11-6.12-2.08-8.81 4.55 2.75 7.25 7.91 6.12 12.24-.03.11-.06.22-.05.39 2.24 2.83 1.64 5.78 1.35 5.22-1.21-2.39-3.48-1.65-4.62-1.17\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#f44336\" d=\"M18.041 3.177c2.24.382 2.879 1.919 2.843 3.527V6.67l-1.013 13.266-13.132.897h.008c-1.093-.044-3.518-.151-3.634-3.545l1.217-2.222 2.462 5.74 2.097-6.77-.045.009.018-.018 6.85 2.186L13.945 9.3l6.53-.409-5.144-4.212 2.71-1.51v.009M3.113 17.252v.017zM6.916 6.874c2.63-2.622 6.033-4.168 7.34-2.844 1.297 1.306-.072 4.523-2.702 7.135-2.666 2.613-6.015 4.248-7.322 2.933-1.306-1.324.036-4.612 2.675-7.224z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#1e88e5\" d=\"M12 18.08c-6.63 0-12-2.72-12-6.08s5.37-6.08 12-6.08S24 8.64 24 12s-5.37 6.08-12 6.08m-5.19-7.95c.54 0 .91.1 1.09.31.18.2.22.56.13 1.03-.1.53-.29.87-.58 1.09q-.42.33-1.29.33h-.87l.53-2.76zm-3.5 5.55h1.44l.34-1.75h1.23c.54 0 .98-.06 1.33-.17.35-.12.67-.31.96-.58.24-.22.43-.46.58-.73.15-.26.26-.56.31-.88.16-.78.05-1.39-.33-1.82-.39-.44-.99-.65-1.82-.65H4.59zm7.25-8.33-1.28 6.58h1.42l.74-3.77h1.14c.36 0 .6.06.71.18s.13.34.07.66l-.57 2.93h1.45l.59-3.07c.13-.62.03-1.07-.27-1.36-.3-.27-.85-.4-1.65-.4h-1.27L12 7.35zM18 10.13c.55 0 .91.1 1.09.31.18.2.22.56.13 1.03-.1.53-.29.87-.57 1.09-.29.22-.72.33-1.3.33h-.85l.5-2.76zm-3.5 5.55h1.44l.34-1.75h1.22c.55 0 1-.06 1.35-.17.35-.12.65-.31.95-.58.24-.22.44-.46.58-.73.15-.26.26-.56.32-.88.15-.78.04-1.39-.34-1.82-.36-.44-.99-.65-1.82-.65h-2.75z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ef5350\" d=\"M12 15.385a5.1 5.1 0 0 0 1.862 1.693L12 18.94l-1.862-1.862A5.04 5.04 0 0 0 12 15.385m4.232-4.063a1.693 1.693 0 0 0-1.693 1.693 1.693 1.693 0 0 0 1.693 1.693 1.693 1.693 0 0 0 1.693-1.693c0-.94-.762-1.693-1.693-1.693m-8.464 0a1.693 1.693 0 0 0-1.693 1.693 1.693 1.693 0 0 0 1.693 1.693 1.693 1.693 0 0 0 1.693-1.693c0-.94-.762-1.693-1.693-1.693m8.464-2.116a3.385 3.385 0 0 1 3.385 3.386 3.385 3.385 0 0 1-3.385 3.385 3.385 3.385 0 0 1-3.386-3.385 3.385 3.385 0 0 1 3.386-3.386m-8.464 0a3.385 3.385 0 0 1 3.386 3.386 3.385 3.385 0 0 1-3.386 3.385 3.385 3.385 0 0 1-3.385-3.385 3.385 3.385 0 0 1 3.385-3.386M3.74 2.69c1.49 3.132.415 5.468-.584 7.787a5.1 5.1 0 0 0-.465 2.116 5.08 5.08 0 0 0 5.078 5.078 6 6 0 0 0 .533-.042l2.506 2.505L12 21.31l1.194-1.177 2.505-2.505c.178.025.355.034.533.042a5.08 5.08 0 0 0 5.078-5.078 5.1 5.1 0 0 0-.465-2.116c-.999-2.319-2.074-4.655-.584-7.787-2.235 1.744-5.417 3.123-8.26 3.132-2.845-.008-6.027-1.388-8.261-3.132z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ba68c8\" d=\"M11.057 2.981c.537.735.028 1.653.141 2.472a3.42 3.42 0 0 1-1.03 2.415c-1.414 1.625-3.165 3.038-4.097 5.03a5.28 5.28 0 0 0 1.412 5.847c.706.735 1.54 1.342 2.472 1.738.17.805-1.088.184-1.455 0A6.7 6.7 0 0 1 4.361 16.4a5.44 5.44 0 0 1 .904-5.368c1.272-1.61 3.136-2.543 4.662-3.857.565-.55 1.003-1.3.932-2.119.156-.678-.254-1.469.212-2.09zm-.07 18.929c-.17.198-.467.325-.495.24-.042-.085.212-.127.381-.325.17-.183.127-.522.24-.522.1 0 .043.395-.14.607zm2.16 0c.17.198.453.31.495.24.028-.085-.212-.141-.395-.339-.156-.184-.113-.523-.24-.523-.085 0-.029.41.14.608zm-1.03.48c-.1 0-.071-.296-.071-.65 0-.367-.028-.663.07-.663.085 0 .057.296.057.663 0 .354.014.65-.057.65m-.495-20.765c.34.24.254 2.077.254 3.136 0 1.653.184 3.376-.805 4.916-.96 1.497-2.048 3.108-1.95 4.972.1 1.837.99 3.504 2.148 5.043.664.876-.353.509-.876.085a7.2 7.2 0 0 1-2.755-5.664c.142-1.907 1.597-3.348 2.628-4.803.805-1.13 1.186-1.879 1.215-3.645.028-1.412-.142-3.531.042-3.983.014-.043.07-.1.099-.057m.537 2.232c-.085 0-.043.396.028.72.424 2.26-.198 4.52-.749 6.682a12.77 12.77 0 0 0 .283 7.826c.607 1.568 1.71.791 2.161 1.568.34.593 1.272.198 1.978-.141 2.232-1.102 4.012-3.108 4.11-5.566.029-.494 0-.989-.07-1.497-.283-1.837-1.78-3.065-3.15-4.083-1.215-.89-2.74-1.483-3.659-2.613-.523-.65-.297-1.638-.381-2.458-.043-.452-.255-.042-.382-.268-.084-.127-.14-.17-.17-.17zm.72 3.616c.057 0 .17.071.325.226a20 20 0 0 0 2.161 1.921c1.272.961 2.43 2.091 2.967 3.504.339.875.339 1.836.226 2.74-.184 1.384-1.187 2.444-2.119 3.404-.339.354-1.06.791-1.074.678-.084-.367.763-1.172 1.159-1.695A5.93 5.93 0 0 0 16 10.962c-1.102-1.214-2.317-1.907-2.995-3.08-.14-.253-.183-.409-.113-.409z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><path fill=\"#ff7043\" d=\"M2 2a1 1 0 0 0-1 1v10c0 .554.446 1 1 1h12c.554 0 1-.446 1-1V3a1 1 0 0 0-1-1zm0 3h12v8H2zm1 2 2 2-2 2 1 1 3-3-3-3zm5 3.5V12h5v-1.5z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#03a9f4\" d=\"M29.07 6H7.677A1.535 1.535 0 0 0 6.24 7.113l-4.2 17.774A.852.852 0 0 0 2.93 26h21.393a1.535 1.535 0 0 0 1.436-1.113L29.96 7.112A.852.852 0 0 0 29.07 6M8.626 23.797a1.4 1.4 0 0 1-1.814-.31l-.007-.009a1.075 1.075 0 0 1 .315-1.599l9.6-6.061-6.102-5.852-.01-.01a1.068 1.068 0 0 1 .084-1.625l.037-.03a1.38 1.38 0 0 1 1.8.07l7.233 6.957a1.1 1.1 0 0 1 .236.739 1.08 1.08 0 0 1-.412.79c-.074.04-.146.119-10.951 6.935ZM24 22.94A1.135 1.135 0 0 1 22.803 24h-5.634a1.061 1.061 0 1 1 .001-2.112h5.633A1.134 1.134 0 0 1 24 22.938Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#42a5f5\" d=\"M30 6a3.86 3.86 0 0 1-1.167 2.833 4.024 4.024 0 0 1-5.666 0A3.86 3.86 0 0 1 22 6a3.86 3.86 0 0 1 1.167-2.833 4.024 4.024 0 0 1 5.666 0A3.86 3.86 0 0 1 30 6m-9.208 5.208A10.6 10.6 0 0 0 13 8a10.6 10.6 0 0 0-7.792 3.208A10.6 10.6 0 0 0 2 19a10.6 10.6 0 0 0 3.208 7.792A10.6 10.6 0 0 0 13 30a10.6 10.6 0 0 0 7.792-3.208A10.6 10.6 0 0 0 24 19a10.6 10.6 0 0 0-3.208-7.792m-1.959 7.625a4.024 4.024 0 0 1-5.666 0 4.024 4.024 0 0 1 0-5.666 4.024 4.024 0 0 1 5.666 0 4.024 4.024 0 0 1 0 5.666\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#1976d2\" d=\"M11.956 4.05c-5.694 0-10.354 3.106-10.354 6.947 0 3.396 3.686 6.212 8.531 6.813v2.205h3.53V17.82c.88-.093 1.699-.259 2.475-.497l1.43 2.692h3.996l-2.402-4.048c1.936-1.263 3.147-3.034 3.147-4.97 0-3.841-4.659-6.947-10.354-6.947m1.584 2.712c4.349 0 7.558 1.45 7.558 4.753 0 1.77-.952 3.013-2.505 3.779a1 1 0 0 1-.228-.156c-.373-.165-.994-.352-.994-.352s3.085-.227 3.085-3.302-3.23-3.127-3.23-3.127h-7.092v7.413c-2.64-.766-4.462-2.392-4.462-4.255 0-2.63 3.52-4.753 7.868-4.753m.156 4.12h2.143s.983-.05.983.974c0 1.004-.983 1.004-.983 1.004h-2.143v-1.977m-.031 4.566h.952c.186 0 .28.052.445.207.135.103.28.3.404.476-.57.073-1.17.104-1.801.104z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#f44336\" d=\"m6.457 9.894 12.523 5.163-.456 1.211L6 11.105Zm7.02-3.091L26 11.966l-.457 1.21L13.02 8.015ZM6.465 18.885l12.524 5.163-.457 1.21L6.01 20.097Zm7.007-3.086 12.524 5.163-.456 1.21-12.524-5.162Z\"/><path fill=\"#f44336\" d=\"M6 24.07V30l19.997-3.106V20.96zM6 5.11v5.99l20-3.11V2zm0 9.96v5.03l20-3.11v-5.03z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\"><path fill=\"#64dd17\" d=\"M123.456 129.975a507 507 0 0 0-3.54 7.846c-4.406 9.981-9.284 22.127-11.066 29.908-.64 2.77-1.037 6.205-1.03 10.013 0 1.506.081 3.09.21 4.702a58.1 58.1 0 0 0 19.98 3.559 58.2 58.2 0 0 0 18.29-2.98c-1.352-1.237-2.642-2.554-3.816-4.038-7.796-9.942-12.146-24.512-19.028-49.01m-28.784-49.39C79.782 91.08 70.039 108.387 70.002 128c.037 19.32 9.487 36.403 24.002 46.94 3.56-14.83 12.485-28.41 25.868-55.63a219 219 0 0 0-2.714-7.083c-3.708-9.3-9.059-20.102-13.834-24.993-2.435-2.555-5.389-4.763-8.652-6.648\"/><path fill=\"#7cb342\" d=\"M178.532 194.535c-7.683-.963-14.023-2.124-19.57-4.081a69.4 69.4 0 0 1-30.958 7.249c-38.491 0-69.693-31.198-69.698-69.7 0-20.891 9.203-39.62 23.764-52.392-3.895-.94-7.956-1.49-12.104-1.482-20.45.193-42.037 11.51-51.025 42.075-.84 4.45-.64 7.813-.64 11.8 0 60.591 49.12 109.715 109.705 109.715 37.104 0 69.882-18.437 89.732-46.633-10.736 2.675-21.06 3.955-29.902 3.982-3.314 0-6.425-.177-9.305-.53\"/><path fill=\"#29b6f6\" d=\"M157.922 173.271c.678.336 2.213.884 4.35 1.49 14.375-10.553 23.717-27.552 23.754-46.764h-.005c-.055-32.03-25.974-57.945-58.011-58.009a58.2 58.2 0 0 0-18.213 2.961c11.779 13.426 17.443 32.613 22.922 53.6l.01.025c.01.017 1.752 5.828 4.743 13.538 2.97 7.7 7.203 17.231 11.818 24.178 3.03 4.655 6.363 8 8.632 8.981\"/><path fill=\"#1e88e5\" d=\"M128.009 18.29c-36.746 0-69.25 18.089-89.16 45.826 10.361-6.49 20.941-8.83 30.174-8.747 12.753.037 22.779 3.991 27.589 6.696a51 51 0 0 1 3.345 2.131 69.4 69.4 0 0 1 28.049-5.894c38.496.004 69.703 31.202 69.709 69.698h-.006c0 19.409-7.938 36.957-20.736 49.594 3.142.352 6.492.571 9.912.554 12.15.006 25.284-2.675 35.13-10.956 6.42-5.408 11.798-13.327 14.78-25.199.584-4.586.92-9.247.92-13.991 0-60.588-49.116-109.715-109.705-109.715\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#9575cd\" d=\"M12.173 22.681c-3.86 0-6.99-3.64-6.99-8.13 0-3.678 2.773-8.172 4.916-10.91 1.014-1.296 2.93-2.322 2.93-2.322s-.982 5.239 1.683 7.319c2.366 1.847 4.106 4.25 4.106 6.363 0 4.232-2.784 7.68-6.645 7.68\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 30 30\"><path fill=\"#f44336\" d=\"M5.207 4.33q-.072.075-.143.153Q1.5 8.476 1.5 15.33c0 4.418 1.155 7.862 3.459 10.34h19.415c2.553-1.152 4.127-3.43 4.127-3.43l-3.147-2.52L23.9 21.1c-.867.773-.845.931-2.315 1.78-1.495.674-3.04.966-4.634.966-2.515 0-4.423-.909-5.723-2.059-1.286-1.15-1.985-4.511-2.096-6.68l17.458.067-.183-1.472s-.847-7.129-2.541-9.372zm8.76.846c1.565 0 3.22.535 3.961 1.471.74.937.931 1.667.973 3.524H9.11c.112-1.955.436-2.81 1.373-3.698.936-.887 2.03-1.297 3.484-1.297\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#41b883\" d=\"M1.791 3.851 12 21.471 22.209 3.936V3.85H18.24l-6.18 10.616L5.906 3.851z\"/><path fill=\"#35495e\" d=\"m5.907 3.851 6.152 10.617L18.24 3.851h-3.723L12.084 8.03 9.66 3.85z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 300 300\"><path fill=\"#ff5722\" d=\"M175.94 24.328c-13.037.252-26.009 3.872-37.471 11.174L79.912 72.818a67.13 67.13 0 0 0-30.355 44.906 70.8 70.8 0 0 0 6.959 45.445 67.2 67.2 0 0 0-10.035 25.102 71.54 71.54 0 0 0 12.236 54.156c23.351 33.41 69.468 43.311 102.81 22.07l58.559-37.158a67.36 67.36 0 0 0 30.355-44.906 70.77 70.77 0 0 0-6.982-45.422 67.65 67.65 0 0 0 10.059-25.102 71.63 71.63 0 0 0-12.236-54.156v-.18c-15.324-21.925-40.453-33.727-65.342-33.246zm5.137 28.68a46.5 46.5 0 0 1 36.09 19.969 42.98 42.98 0 0 1 7.365 32.557 45 45 0 0 1-1.393 5.455l-1.123 3.37-2.986-2.247a75.9 75.9 0 0 0-22.902-11.45l-2.244-.651.201-2.246a13.16 13.16 0 0 0-2.379-8.711 13.99 13.99 0 0 0-14.953-5.412 12.8 12.8 0 0 0-3.594 1.572l-58.578 37.25a12.24 12.24 0 0 0-5.502 8.15 13.1 13.1 0 0 0 2.246 9.834 14.03 14.03 0 0 0 14.93 5.569 13.5 13.5 0 0 0 3.594-1.573l22.453-14.234a41.8 41.8 0 0 1 11.898-5.232 46.48 46.48 0 0 1 49.914 18.502 43.02 43.02 0 0 1 7.363 32.557 40.42 40.42 0 0 1-18.254 27.078l-58.58 37.316a43 43 0 0 1-11.898 5.23A46.545 46.545 0 0 1 82.81 227.14a42.98 42.98 0 0 1-7.341-32.557 38 38 0 0 1 1.39-5.41l1.102-3.37 3.008 2.246a75.9 75.9 0 0 0 22.836 11.361l2.244.65-.201 2.247a13.25 13.25 0 0 0 2.447 8.644 14.03 14.03 0 0 0 15.043 5.569 13.1 13.1 0 0 0 3.592-1.573l58.467-37.316a12.17 12.17 0 0 0 5.502-8.173 12.96 12.96 0 0 0-2.246-9.811 14.03 14.03 0 0 0-15.043-5.568 12.8 12.8 0 0 0-3.592 1.57l-22.453 14.258a42.9 42.9 0 0 1-11.877 5.209 46.52 46.52 0 0 1-49.846-18.5 43.02 43.02 0 0 1-7.297-32.557A40.42 40.42 0 0 1 96.798 96.98l58.646-37.316a42.8 42.8 0 0 1 11.811-5.21 46.5 46.5 0 0 1 13.822-1.444z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#7c4dff\" d=\"M12.106 25.849c-1.262-1.156-1.63-3.586-1.105-5.346a5.18 5.18 0 0 0 3.484 1.66 9.68 9.68 0 0 0 5.882-.734c.215-.106.413-.247.648-.39a3.5 3.5 0 0 1 .16 1.555 4.26 4.26 0 0 1-1.798 3.021c-.404.3-.832.569-1.25.852a2.613 2.613 0 0 0-1.15 3.372l.048.161a3.4 3.4 0 0 1-1.5-1.285 3.6 3.6 0 0 1-.578-1.962 9 9 0 0 0-.05-1.037c-.114-.831-.504-1.204-1.238-1.225a1.45 1.45 0 0 0-1.507 1.18c-.012.056-.028.112-.046.178M4.901 20a17.75 17.75 0 0 1 7.4-2l2.913-8.38a.765.765 0 0 1 1.527 0L19.7 18a14.24 14.24 0 0 1 7.399 2S20.704 2.877 20.692 2.842C20.51 2.33 20.202 2 19.787 2h-7.619c-.415 0-.71.33-.904.842z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#ec407a\" d=\"M6 20h20v2H6z\"/><circle cx=\"7\" cy=\"21\" r=\"3\" fill=\"#ec407a\"/><circle cx=\"16\" cy=\"27\" r=\"3\" fill=\"#ec407a\"/><circle cx=\"25\" cy=\"21\" r=\"3\" fill=\"#ec407a\"/><path fill=\"#ec407a\" d=\"M6 10h20v2H6z\"/><circle cx=\"7\" cy=\"11\" r=\"3\" fill=\"#ec407a\"/><circle cx=\"16\" cy=\"5\" r=\"3\" fill=\"#ec407a\"/><circle cx=\"25\" cy=\"11\" r=\"3\" fill=\"#ec407a\"/><path fill=\"#ec407a\" d=\"M6 12h2v10H6zm18-2h2v12h-2z\"/><path fill=\"#ec407a\" d=\"m5.014 19.41 11.674 6.866L15.674 28 4 21.134z\"/><path fill=\"#ec407a\" d=\"M26.688 21.724 15.014 28.59 14 26.866 25.674 20zM5.124 10.382l11.415-7.29 1.077 1.686L6.2 12.068z\"/><path fill=\"#ec407a\" d=\"m25.798 12.067-11.415-7.29 1.077-1.685 11.415 7.29zM6.2 19.932l11.416 7.29-1.077 1.686-11.415-7.29z\"/><path fill=\"#ec407a\" d=\"m26.875 21.619-11.415 7.29-1.077-1.687 11.415-7.289zM5.877 22.6 16.04 3.686l1.762.946L7.638 23.546z\"/><path fill=\"#ec407a\" d=\"M24.361 23.545 14.197 4.633l1.761-.947 10.165 18.913z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#00bfa5\" d=\"m27.777 22.617-.459-.946L18.43 3.26a2.25 2.25 0 0 0-1.914-1.256A2 2 0 0 0 16.379 2a2.23 2.23 0 0 0-1.891 1.042L4.348 19.056a2.2 2.2 0 0 0 .025 2.417l4.957 7.488A2.34 2.34 0 0 0 11.29 30a2.4 2.4 0 0 0 .655-.092l14.387-4.149a2.32 2.32 0 0 0 1.458-1.234 2.21 2.21 0 0 0-.013-1.908m-3.538.604-11.268 3.25 4.075-19.033 7.568 15.671-.376.098Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ff5252\" d=\"M13 9h5.5L13 3.5zM6 2h8l6 6v12c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2m12 16v-2H9v2zm-4-4v-2H6v2z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><path fill=\"#cfd8dc\" d=\"M4 6V4h8v2H9v7H7V6z\"/><path fill=\"#ef5350\" d=\"M4 1v1H2v12h2v1H1V1zm8 0v1h2v12h-2v1h3V1z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\" viewBox=\"0 0 24 24\"><path d=\"M0 0h24v24H0z\"/><path fill=\"#42a5f5\" d=\"M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.6.6 0 0 0-.18-.03c-.17 0-.34.09-.43.25l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1q.09.03.18.03c.17 0 .34-.09.43-.25l2-3.46c.12-.22.07-.49-.12-.64zm-1.98-1.71c.04.31.05.52.05.73s-.02.43-.05.73l-.14 1.13.89.7 1.08.84-.7 1.21-1.27-.51-1.04-.42-.9.68c-.43.32-.84.56-1.25.73l-1.06.43-.16 1.13-.2 1.35h-1.4l-.19-1.35-.16-1.13-1.06-.43c-.43-.18-.83-.41-1.23-.71l-.91-.7-1.06.43-1.27.51-.7-1.21 1.08-.84.89-.7-.14-1.13c-.03-.31-.05-.54-.05-.74s.02-.43.05-.73l.14-1.13-.89-.7-1.08-.84.7-1.21 1.27.51 1.04.42.9-.68c.43-.32.84-.56 1.25-.73l1.06-.43.16-1.13.2-1.35h1.39l.19 1.35.16 1.13 1.06.43c.43.18.83.41 1.23.71l.91.7 1.06-.43 1.27-.51.7 1.21-1.07.85-.89.7zM12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4m0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#fbc02d\" d=\"M12 10h10v2H12z\"/><path fill=\"#fbc02d\" d=\"M16 4h2v8h-2zm4 18h10v2H20zm4 2h2v4h-2zm0-20h2v14h-2zM2 18h10v2H2z\"/><path fill=\"#fbc02d\" d=\"M6 18h2v10H6zM6 4h2v10H6zm10 12h2v12h-2z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#ffca28\" d=\"M16 24c-5.525 0-10-.9-10-2v4c0 1.1 4.475 2 10 2s10-.9 10-2v-4c0 1.1-4.475 2-10 2m0-8c-5.525 0-10-.9-10-2v4c0 1.1 4.475 2 10 2s10-.9 10-2v-4c0 1.1-4.475 2-10 2m0-12C10.477 4 6 4.895 6 6v4c0 1.1 4.475 2 10 2s10-.9 10-2V6c0-1.105-4.477-2-10-2\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#ffd54f\" d=\"M25 12h-3V8a6 6 0 0 0-12 0v4H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V13a1 1 0 0 0-1-1M14 8a2 2 0 0 1 4 0v4h-4Zm2 17a4 4 0 1 1 4-4 4 4 0 0 1-4 4\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#8bc34a\" d=\"M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4c0-1.11.89-2 2-2m.12 13.5 3.74 3.74 1.42-1.41-2.33-2.33 2.33-2.33-1.42-1.41zm11.16 0-3.74-3.74-1.42 1.41 2.33 2.33-2.33 2.33 1.42 1.41z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#ffb300\" d=\"M29.168 14.03a2.7 2.7 0 0 0-1.968-.83 2.51 2.51 0 0 0-1.929.8h-4.443l3.078-3.078a2.835 2.835 0 0 0 2.857-2.842 2.6 2.6 0 0 0-.831-1.969 2.82 2.82 0 0 0-2.014-.788 2.67 2.67 0 0 0-1.968.788 2.36 2.36 0 0 0-.812 1.922L18 11.17V6.726a2.51 2.51 0 0 0 .8-1.929 2.7 2.7 0 0 0-.832-1.968 2.745 2.745 0 0 0-3.936 0 2.7 2.7 0 0 0-.832 1.968 2.51 2.51 0 0 0 .8 1.93v4.443l-3.138-3.138a2.36 2.36 0 0 0-.812-1.922 2.66 2.66 0 0 0-1.968-.788 2.83 2.83 0 0 0-2.014.788 2.6 2.6 0 0 0-.831 1.969 2.74 2.74 0 0 0 .831 2.013 2.8 2.8 0 0 0 2.026.829l3.078 3.078H6.729a2.51 2.51 0 0 0-1.929-.8 2.7 2.7 0 0 0-1.968.831 2.745 2.745 0 0 0 0 3.937 2.7 2.7 0 0 0 1.968.832 2.51 2.51 0 0 0 1.929-.8h4.443l-3.078 3.077a2.835 2.835 0 0 0-2.857 2.842 2.6 2.6 0 0 0 .831 1.969 2.82 2.82 0 0 0 2.014.788 2.67 2.67 0 0 0 1.968-.788 2.36 2.36 0 0 0 .812-1.922L14 20.827v4.444a2.51 2.51 0 0 0-.8 1.929 2.784 2.784 0 0 0 4.768 1.968A2.7 2.7 0 0 0 18.8 27.2a2.51 2.51 0 0 0-.8-1.929v-4.444l3.138 3.138a2.36 2.36 0 0 0 .812 1.922 2.66 2.66 0 0 0 1.968.788 2.83 2.83 0 0 0 2.014-.788 2.6 2.6 0 0 0 .831-1.969 2.74 2.74 0 0 0-.831-2.013 2.8 2.8 0 0 0-2.026-.829L20.828 18h4.443a2.51 2.51 0 0 0 1.93.8 2.784 2.784 0 0 0 1.967-4.769Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><path fill=\"#26a69a\" d=\"M8.5 6h4l-4-4zM3.875 1H9.5l4 4v8.6c0 .773-.616 1.4-1.375 1.4h-8.25c-.76 0-1.375-.627-1.375-1.4V2.4c0-.777.612-1.4 1.375-1.4M4 13.6h8V8l-2.625 2.8L8 9.4zm1.25-7.7c-.76 0-1.375.627-1.375 1.4s.616 1.4 1.375 1.4c.76 0 1.375-.627 1.375-1.4S6.009 5.9 5.25 5.9\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ef5350\" d=\"M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m4.93 10.44c.41.9.93 1.64 1.53 2.15l.41.32c-.87.16-2.07.44-3.34.93l-.11.04.5-1.04c.45-.87.78-1.66 1.01-2.4m6.48 3.81c.18-.18.27-.41.28-.66.03-.2-.02-.39-.12-.55-.29-.47-1.04-.69-2.28-.69l-1.29.07-.87-.58c-.63-.52-1.2-1.43-1.6-2.56l.04-.14c.33-1.33.64-2.94-.02-3.6a.85.85 0 0 0-.61-.24h-.24c-.37 0-.7.39-.79.77-.37 1.33-.15 2.06.22 3.27v.01c-.25.88-.57 1.9-1.08 2.93l-.96 1.8-.89.49c-1.2.75-1.77 1.59-1.88 2.12-.04.19-.02.36.05.54l.03.05.48.31.44.11c.81 0 1.73-.95 2.97-3.07l.18-.07c1.03-.33 2.31-.56 4.03-.75 1.03.51 2.24.74 3 .74.44 0 .74-.11.91-.3m-.41-.71.09.11c-.01.1-.04.11-.09.13h-.04l-.19.02c-.46 0-1.17-.19-1.9-.51.09-.1.13-.1.23-.1 1.4 0 1.8.25 1.9.35M7.83 17c-.65 1.19-1.24 1.85-1.69 2 .05-.38.5-1.04 1.21-1.69zm3.02-6.91c-.23-.9-.24-1.63-.07-2.05l.07-.12.15.05c.17.24.19.56.09 1.1l-.03.16-.16.82z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#01579b\" d=\"M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zM7 13l1.5 7h2l1.5-3 1.5 3h2l1.5-7h1v-2h-4v2h1l-.9 4.2L13 15h-2l-1.1 2.2L9 13h1v-2H6v2z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#8bc34a\" d=\"M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zm4 7.5h-4v2h1l-2 1.67L10 13h1v-2H7v2h1l3 2.5L8 18H7v2h4v-2h-1l2-1.67L14 18h-1v2h4v-2h-1l-3-2.5 3-2.5h1z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#e64a19\" d=\"M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zM8 11v2h1v6H8v1h4v-1h-1v-2h2a3 3 0 0 0 3-3 3 3 0 0 0-3-3zm5 2a1 1 0 0 1 1 1 1 1 0 0 1-1 1h-2v-2z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#afb42b\" d=\"M14 17h-2v-2h-2v-2h2v2h2m0-6h-2v2h2v2h-2v-2h-2V9h2V7h-2V5h2v2h2m5-4H5c-1.11 0-2 .89-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#f44336\" d=\"M24 28h4L18 4h-4L4 28h4l8-19.422\"/><path fill=\"#f44336\" d=\"M8 20h16v4H8z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#ef5350\" d=\"M16 2a14 14 0 1 0 14 14A14 14 0 0 0 16 2m6 10h-4v8a4 4 0 1 1-4-4 3.96 3.96 0 0 1 2 .555V8h6Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#ff9800\" d=\"m24 6 2 6h-4l-2-6h-3l2 6h-4l-2-6h-3l2 6H8L6 6H5a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h22a3 3 0 0 0 3-3V6Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#7c4dff\" d=\"M22 18h4v4h-4z\"/><path fill=\"#7c4dff\" d=\"M20 2a4 4 0 0 1-8 0H2v28h28V2Zm-2 24h-2v2h-4v-2h-2v2H6v-2H4V16h2v10h4V16h2v10h4V16h2Zm10 2h-2v-4h-4v4h-2V18h2v-2h4v2h2Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#e64a19\" d=\"M28 4H4a2 2 0 0 0-2 2v20a2 2 0 0 0 2 2h24a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 22H4V10h24Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#42a5f5\" d=\"M6 2a2 2 0 0 0-2 2v16c0 1.11.89 2 2 2h6v-2H6V4h7v5h5v3h2V8l-6-6m4 12a.26.26 0 0 0-.26.21l-.19 1.32c-.3.13-.59.29-.85.47l-1.24-.5c-.11 0-.24 0-.31.13l-1 1.73c-.06.11-.04.24.06.32l1.06.82a4.2 4.2 0 0 0 0 1l-1.06.82a.26.26 0 0 0-.06.32l1 1.73c.06.13.19.13.31.13l1.24-.5c.26.18.54.35.85.47l.19 1.32c.02.12.12.21.26.21h2c.11 0 .22-.09.24-.21l.19-1.32c.3-.13.57-.29.84-.47l1.23.5c.13 0 .26 0 .33-.13l1-1.73a.26.26 0 0 0-.06-.32l-1.07-.82c.02-.17.04-.33.04-.5s-.01-.33-.04-.5l1.06-.82a.26.26 0 0 0 .06-.32l-1-1.73c-.06-.13-.19-.13-.32-.13l-1.23.5c-.27-.18-.54-.35-.85-.47l-.19-1.32A.236.236 0 0 0 20 14m-1 3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5c-.84 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\" viewBox=\"0 0 24 24\"><path d=\"M0 0h24v24H0z\"/><path fill=\"#8bc34a\" d=\"M4 6H2v14c0 1.1.9 2 2 2h14v-2H4zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m0 14H8V4h12zM10 9h8v2h-8zm0 3h4v2h-4zm0-6h8v2h-8z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#29b6f6\" d=\"M21 16.5c0 .38-.21.71-.53.88l-7.9 4.44c-.16.12-.36.18-.57.18s-.41-.06-.57-.18l-7.9-4.44A.99.99 0 0 1 3 16.5v-9c0-.38.21-.71.53-.88l7.9-4.44c.16-.12.36-.18.57-.18s.41.06.57.18l7.9 4.44c.32.17.53.5.53.88zM12 4.15 6.04 7.5 12 10.85l5.96-3.35zM5 15.91l6 3.38v-6.71L5 9.21zm14 0v-6.7l-6 3.37v6.71z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\" viewBox=\"0 0 24 24\"><path d=\"M0 0h24v24H0z\"/><path fill=\"#afb42b\" d=\"M19 5v9h-5v5H5V5zm0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h10l6-6V5c0-1.1-.9-2-2-2m-7 11H7v-2h5zm5-4H7V8h10z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\" viewBox=\"0 0 24 24\"><path d=\"M0 0h24v24H0z\"/><path fill=\"#42a5f5\" d=\"M18 23H4c-1.1 0-2-.9-2-2V7h2v14h14zM14.5 7V5h-2v2h-2v2h2v2h2V9h2V7zm2 6h-6v2h6zM15 1H8c-1.1 0-1.99.9-1.99 2L6 17c0 1.1.89 2 1.99 2H19c1.1 0 2-.9 2-2V7zm4 16H8V3h6.17L19 7.83z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#e64a19\" d=\"M13.172 2.828 11.78 4.22l1.91 1.91 2 2A2.986 2.986 0 0 1 20 10.81a3.25 3.25 0 0 1-.31 1.31l2.06 2a2.68 2.68 0 0 1 3.37.57 2.86 2.86 0 0 1 .88 2.117 3.02 3.02 0 0 1-.856 2.109A2.9 2.9 0 0 1 23 19.81a2.93 2.93 0 0 1-2.13-.87 2.694 2.694 0 0 1-.56-3.38l-2-2.06a3 3 0 0 1-.31.12V20a3 3 0 0 1 1.44 1.09 2.92 2.92 0 0 1 .56 1.72 2.88 2.88 0 0 1-.878 2.128 2.98 2.98 0 0 1-2.048.871 2.981 2.981 0 0 1-2.514-4.719A3 3 0 0 1 16 20v-6.38a2.96 2.96 0 0 1-1.44-1.09 2.9 2.9 0 0 1-.56-1.72 2.9 2.9 0 0 1 .31-1.31l-3.9-3.9-7.579 7.572a4 4 0 0 0-.001 5.658l10.342 10.342a4 4 0 0 0 5.656 0l10.344-10.344a4 4 0 0 0 0-5.656L18.828 2.828a4 4 0 0 0-5.656 0\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#7986cb\" d=\"M24 14h-2l-6 14h3l.857-2h6.286L27 28h3Zm-2.856 9L23 18.67 24.856 23ZM12 6V4h-2v2H2v2h11.959a13.4 13.4 0 0 1-2.876 7.07A41 41 0 0 1 8.786 12H6.408a42 42 0 0 0 3.404 4.685 64 64 0 0 1-5.49 5.579l1.355 1.472a68 68 0 0 0 5.454-5.523 49 49 0 0 0 3.279 3.342l1.42-1.42a50 50 0 0 1-3.415-3.498A15.34 15.34 0 0 0 15.97 8H20V6Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#0288d1\" d=\"M21.81 10.25c-.06-.04-.56-.43-1.64-.43-.28 0-.56.03-.84.08-.21-1.4-1.38-2.11-1.43-2.14l-.29-.17-.18.27c-.24.36-.43.77-.51 1.19-.2.8-.08 1.56.33 2.21-.49.28-1.29.35-1.46.35H2.62c-.34 0-.62.28-.62.63 0 1.15.18 2.3.58 3.38.45 1.19 1.13 2.07 2 2.61.98.6 2.59.94 4.42.94.79 0 1.61-.07 2.42-.22 1.12-.2 2.2-.59 3.19-1.16A8.3 8.3 0 0 0 16.78 16c1.05-1.17 1.67-2.5 2.12-3.65h.19c1.14 0 1.85-.46 2.24-.85.26-.24.45-.53.59-.87l.08-.24zm-17.96.99h1.76c.08 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16H3.85c-.09 0-.16.07-.16.16v1.58c.01.09.07.16.16.16m2.43 0h1.76c.08 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16H6.28c-.09 0-.16.07-.16.16v1.58c.01.09.07.16.16.16m2.47 0h1.75c.1 0 .17-.07.17-.16V9.5c0-.08-.06-.16-.17-.16H8.75c-.08 0-.15.07-.15.16v1.58c0 .09.06.16.15.16m2.44 0h1.77c.08 0 .15-.07.15-.16V9.5c0-.08-.06-.16-.15-.16h-1.77c-.08 0-.15.07-.15.16v1.58c0 .09.07.16.15.16M6.28 9h1.76c.08 0 .16-.09.16-.18V7.25c0-.09-.07-.16-.16-.16H6.28c-.09 0-.16.06-.16.16v1.57c.01.09.07.18.16.18m2.47 0h1.75c.1 0 .17-.09.17-.18V7.25c0-.09-.06-.16-.17-.16H8.75c-.08 0-.15.06-.15.16v1.57c0 .09.06.18.15.18m2.44 0h1.77c.08 0 .15-.09.15-.18V7.25c0-.09-.07-.16-.15-.16h-1.77c-.08 0-.15.06-.15.16v1.57c0 .09.07.18.15.18m0-2.28h1.77c.08 0 .15-.07.15-.16V5c0-.1-.07-.17-.15-.17h-1.77c-.08 0-.15.06-.15.17v1.56c0 .08.07.16.15.16m2.46 4.52h1.76c.09 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16h-1.76c-.08 0-.15.07-.15.16v1.58c0 .09.07.16.15.16\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#ef5350\" d=\"m29.5 24.02-1.6-.92a4.4 4.4 0 0 0 .09-.9A1.3 1.3 0 0 0 28 22a5.6 5.6 0 0 0-.1-1.1l1.6-.92a.493.493 0 0 0 .18-.68l-1.5-2.6a.45.45 0 0 0-.18-.18V6.01a2.006 2.006 0 0 0-2-2H4a2.006 2.006 0 0 0-2 2V22a2.006 2.006 0 0 0 2 2h10.53l-.03.02a.493.493 0 0 0-.18.68l1.5 2.6a.493.493 0 0 0 .68.18l1.6-.92a5.9 5.9 0 0 0 1.9 1.09v1.85a.495.495 0 0 0 .5.5h3a.495.495 0 0 0 .5-.5v-1.85a5.9 5.9 0 0 0 1.9-1.09l1.6.92a.493.493 0 0 0 .68-.18l1.5-2.6a.493.493 0 0 0-.18-.68M24 22.01a1.99 1.99 0 0 1-.88 1.65l-.18.11a2.04 2.04 0 0 1-1.88 0l-.18-.11a1.99 1.99 0 0 1-.88-1.65V22a2 2 0 0 1 .88-1.66l.18-.11a2.04 2.04 0 0 1 1.88 0l.18.11A2 2 0 0 1 24 22Zm2-4.63-.1.06a5.9 5.9 0 0 0-1.9-1.09V14.5a.495.495 0 0 0-.5-.5h-3a.495.495 0 0 0-.5.5v1.85a5.9 5.9 0 0 0-1.9 1.09l-1.6-.92a.493.493 0 0 0-.68.18l-1.5 2.6a.493.493 0 0 0 .18.68l1.6.92A5.6 5.6 0 0 0 16 22v.01L4 22V10.01h22Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#1e88e5\" d=\"M11.94 2.984 2.928 21.017l9.875-8.47z\"/><path fill=\"#e53935\" d=\"m11.958 2.982.002.29 1.312 14.499-.002.006.023.26 7.363 2.978h.415l-.158-.31-.114-.228h-.001l-8.84-17.494z\"/><path fill=\"#7cb342\" d=\"m8.558 16.13-5.627 4.884h17.743v-.016z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#8bc34a\" d=\"M16 20.003v2h4a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-2v-2h4v-2h-4a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2v2Z\"/><path fill=\"#8bc34a\" d=\"m16 3.003-12 7v14l4 2h6v-13.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v11.5H8l-2-1.034V11.15l10-5.833 10 5.833v11.703l-10 5.833-1.745-1.022L13 29.253l3 1.75 12-7v-14Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#e0e0e0\" d=\"M2 22h8v8H2zm10 0h8v8h-8zm10 0h8v8h-8zM12 12h8v8h-8z\"/><path fill=\"#ffb300\" d=\"M2 2h8v8H2zm10 0h8v8h-8zm10 0h8v8h-8zm0 10h8v8h-8z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#0288d1\" d=\"M27.575 23.967a9.9 9.9 0 0 0-3.751 1.726 22.6 22.6 0 0 1-5.537 2.504 1.55 1.55 0 0 1-.931.52 59 59 0 0 1-6.11.548c-1.102.008-1.777-.282-1.965-.735a1.49 1.49 0 0 1 .82-1.965 3.6 3.6 0 0 1-.486-.359c-.163-.162-.334-.487-.385-.367-.213.52-.324 1.794-.897 2.366-.786.795-2.273.53-3.153.069-.965-.513.069-1.718.069-1.718a.69.69 0 0 1-.94-.324 4.6 4.6 0 0 1-.632-2.794 5.2 5.2 0 0 1 1.674-2.76 8.84 8.84 0 0 1 .624-4.17 9.9 9.9 0 0 1 3-3.469S7.136 11.015 7.82 9.177c.444-1.196.623-1.187.769-1.239a3.44 3.44 0 0 0 1.375-.811 4.99 4.99 0 0 1 4.178-1.607s1.094-3.357 2.12-2.7a17.4 17.4 0 0 1 1.452 2.735s1.213-.71 1.35-.445a10.74 10.74 0 0 1 .495 5.81 13.3 13.3 0 0 1-2.46 5.127c-.129.214 1.47.889 2.477 3.683.932 2.554.103 4.699.248 4.938.026.043.034.06.034.06s1.068.085 3.213-1.24a8.05 8.05 0 0 1 4.05-1.52 1.026 1.026 0 0 1 .453 2Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#fff8e1\" d=\"M30 17.045a9.8 9.8 0 0 0-.32-2.306l-.004.034a11.2 11.2 0 0 0-5.762-6.786c-3.495-1.89-5.243-3.326-6.8-3.811h.003c-1.95-.695-3.949.82-5.825 1.927-4.52 2.481-9.573 5.45-9.28 11.417.008-.029.017-.052.026-.08a9.97 9.97 0 0 0 3.934 7.257l-.01-.006C13.747 31.473 30.05 27.292 30 17.045\"/><path fill=\"#37474f\" d=\"M19.855 20.236A.8.8 0 0 0 19.26 20h-6.514a.8.8 0 0 0-.596.236.51.51 0 0 0-.137.463 4.37 4.37 0 0 0 1.641 2.339 4.2 4.2 0 0 0 2.349.926 4.2 4.2 0 0 0 2.343-.926 4.37 4.37 0 0 0 1.642-2.339.5.5 0 0 0-.132-.463Z\"/><ellipse cx=\"22.5\" cy=\"18.5\" fill=\"#f8bbd0\" rx=\"2.5\" ry=\"1.5\"/><ellipse cx=\"9.5\" cy=\"18.5\" fill=\"#f8bbd0\" rx=\"2.5\" ry=\"1.5\"/><circle cx=\"10\" cy=\"16\" r=\"2\" fill=\"#37474f\"/><circle cx=\"22\" cy=\"16\" r=\"2\" fill=\"#37474f\"/><path fill=\"#455a64\" d=\"M9.996 18A2 2 0 1 0 8 15.996V16a2 2 0 0 0 1.996 2\"/><circle cx=\"9\" cy=\"15\" r=\"1\" fill=\"#fafafa\"/><circle cx=\"21\" cy=\"15\" r=\"1\" fill=\"#fafafa\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" clip-rule=\"evenodd\" image-rendering=\"optimizeQuality\" shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\" viewBox=\"0 0 3473 3473\"><path fill=\"#ede7f6\" d=\"M989.342 1977.409c41.146-26.835 75.137-93.922 54.564-141.33-56.353 24.151-53.67 79.61-54.564 141.33m636.877 153.851c44.724-14.311 87.66-64.402 63.509-116.283-34.886 24.151-57.248 57.247-63.51 116.284z\"/><g fill=\"#fafafa\"><path d=\"M374.827 2871.899c0 56.352 14.312 117.178 53.67 138.645 144.907 81.4 652.977 17.89 825.614-20.573 90.343-20.573 163.692-87.66 248.668-124.334 191.421-83.187 330.067-150.274 483.025-262.085 110.916-81.399 287.131-310.388 305.915-447.245l-151.169-33.991c-3.578 153.852-38.463 188.737-175.32 224.517-92.132 25.046-271.925 30.413-365.846 14.312-124.334-20.574-180.687-85.871-237.04-160.114-109.128-144.907 24.151-245.985-148.485-255.824-181.582 222.728-501.81 62.614-642.244 40.252-59.93 86.765-200.366 650.294-198.577 779.1 86.766-29.517 141.33 2.684 219.15 33.097 275.503 106.444 34.885 200.366-75.137 172.636-75.137-17.89-98.394-67.086-142.224-98.393m360.48-1285.383c111.81 21.468 211.1 67.982 305.915 115.39 154.747 76.926 182.476 66.192 196.788 173.53 1.789 19.68-1.789 30.413 54.564 48.303 94.816 29.518-54.564-23.257 199.471-22.362 151.169.894 497.337 61.72 609.148 132.384 46.513 29.519 37.568 67.087 194.999 62.615-1.79-185.16-50.986-461.557-123.44-631.51-88.554-205.733-205.733-237.04-444.561-313.966-139.54-44.725-549.217-93.922-676.235-15.207-118.967 74.243-141.33 162.798-252.246 318.439-32.202 45.619-43.83 80.504-64.403 132.384\"/><path d=\"M1720.14 1966.675c89.45 36.674-4.472 273.714-128.806 216.466-40.252-113.6 55.458-178.003 81.398-228.99-53.67-8.05-206.627-32.2-252.246-15.206-59.036 22.363-72.454 148.486-42.041 207.522 143.118 280.87 775.523 220.94 708.436 2.684-26.835-88.555-51.88-102.867-142.224-133.28-72.454-24.15-144.907-49.196-224.517-49.196m-1124.374-31.307c71.56 68.875 233.462 79.61 338.117 84.976 13.418-138.646 25.046-242.407 135.963-234.356 54.564 74.242 25.94 161.902-31.307 218.255 97.5-.894 153.852-74.242 139.54-180.687-82.293-59.036-331.856-177.109-457.084-194.104-34.885 37.569-120.756 243.301-125.229 305.916\"/></g><path d=\"M427.602 2820.913c59.036-5.367 212.889 39.357 225.412 89.449-95.71 11.628-217.361 2.683-225.412-89.45zm-52.775 50.986c43.83 31.307 67.087 80.504 142.224 98.393 110.022 27.73 350.64-66.192 75.137-172.636-77.82-30.413-132.384-62.614-219.15-33.096-1.789-128.807 138.646-692.336 198.577-779.101 140.435 22.362 460.662 182.476 642.244-40.252 172.636 9.84 39.357 110.917 148.485 255.824 56.353 74.243 112.706 139.54 237.04 160.114 93.921 16.1 273.714 10.734 365.846-14.312 136.857-35.78 171.742-70.665 175.32-224.517l151.17 33.99c-18.785 136.858-195 365.847-305.916 447.246-152.958 111.81-291.604 178.898-483.025 262.085-84.976 36.674-158.325 103.761-248.668 124.334-172.637 38.463-680.707 101.972-825.614 20.574-39.358-21.468-53.67-82.294-53.67-138.646M1626.22 2131.26c6.261-59.037 28.623-92.133 63.508-116.284 24.152 51.88-18.784 101.972-63.508 116.284m93.921-164.586c79.61 0 152.063 25.045 224.517 49.197 90.344 30.412 115.39 44.724 142.224 133.279 67.087 218.255-565.318 278.186-708.436-2.684-30.413-59.036-16.995-185.16 42.041-207.522 45.619-16.995 198.577 7.156 252.246 15.207-25.94 50.986-121.65 115.389-81.398 228.99 124.334 57.247 218.255-179.793 128.806-216.467m-730.798 10.734c.894-61.72-1.79-117.179 54.564-141.33 20.573 47.408-13.418 114.495-54.564 141.33m-393.576-42.041c4.473-62.615 90.344-268.347 125.229-305.916 125.228 16.995 374.791 135.068 457.084 194.104 14.312 106.445-42.04 179.793-139.54 180.687 57.247-56.353 85.87-144.013 31.307-218.255-110.917-8.05-122.545 95.71-135.963 234.356-104.655-5.367-266.558-16.1-338.117-84.976m-89.449-71.56c-33.096-91.238-33.096-233.462 107.339-245.09l-71.56 199.471c-18.783 42.936-18.783 33.096-35.779 45.62zm228.99-277.292c20.573-51.88 32.201-86.765 64.403-132.384 110.917-155.641 133.279-244.196 252.246-318.439 127.018-78.715 536.694-29.518 676.235 15.207 238.828 76.926 356.007 108.233 444.561 313.966 72.454 169.953 121.65 446.35 123.44 631.51-157.43 4.472-148.486-33.096-195-62.615-111.81-70.664-457.978-131.49-609.147-132.384-254.035-.895-104.655 51.88-199.471 22.362-56.353-17.89-52.775-28.624-54.564-48.302-14.312-107.34-42.041-96.605-196.788-173.531-94.816-47.408-194.104-93.922-305.915-115.39m1583.247-43.83c-16.995-56.352 14.312-52.775 68.876-91.238 31.307-22.362 56.353-45.619 94.816-67.086 144.013-80.504 412.36-93.922 526.854 1.789 46.514 38.463 122.545 113.6 110.917 211.994-24.151 195.893-158.325 303.232-268.347 392.68-111.811 91.239-297.865 185.16-490.18 122.546-16.101-39.358-3.578-288.92-22.363-381.053-16.995-82.293-8.05-91.238 39.358-140.435 139.54-144.907 441.878-250.457 613.62-126.123 72.454 53.67 51.88 74.243 89.449 115.39 46.513-50.092-40.252-218.256-360.48-207.522-217.36 7.156-311.282 177.109-402.52 169.058m-1302.377-508.964c4.472-124.335 118.967-381.948 233.461-471.397 138.646-107.338 283.554-208.416 496.442-87.66 52.775 29.519 50.092 44.725 55.459 118.073 4.472 70.665-1.79 96.605-19.679 153.852-141.33 456.19-259.402 194.105-712.014 302.338 16.995-148.485 145.802-280.87 217.361-349.746 122.545-118.967 211.1-195.893 395.365-170.847 50.986 84.976 56.352 138.646-5.367 237.934-82.293 132.385-102.867 124.334-90.344 214.678 64.403-16.101 84.082-78.715 113.6-141.33 179.793-375.686-81.398-421.305-241.512-352.429-107.339 45.62-298.76 256.719-361.374 383.736-12.523 25.046-25.94 57.248-37.568 84.977zm708.436 18.784c18.784-111.811 129.7-139.54 129.7-483.92 0-148.485-182.475-281.764-421.304-182.475-204.838 84.082-236.145 148.485-345.273 313.071-102.867 155.642-99.289 326.49-187.843 470.502-25.94 41.147-49.197 55.458-77.82 96.605-20.574 30.413-35.78 68.876-56.354 104.655-42.04 68.876-84.976 118.968-118.967 201.26-107.339 2.684-197.682 4.473-208.416 115.39-14.312 152.063 57.247 189.632 57.247 246.879-.894 61.72-251.351 684.285-181.581 1055.498 19.679 101.972 86.765 102.867 194.104 115.39 258.508 31.307 593.942 20.573 825.614-72.454l420.41-201.26c106.445-59.931 285.343-173.532 364.953-256.72 56.353-58.141 85.87-107.338 134.173-176.214 66.192-96.605 67.981-94.816 82.293-226.306 87.66 16.101 251.352 54.564 305.916 101.972-6.262 61.72-36.674 32.202-36.674 87.66 34.885.895 93.027-42.935 107.339-91.238-36.675-53.67-75.138-44.724-127.913-87.66 42.042-33.096 118.073-48.302 176.215-72.453 125.229-51.88 339.012-209.311 391.787-352.43 42.04-115.389 10.734-307.704-57.248-382.841-71.559-78.715-237.934-118.967-373.897-118.967-161.902 0-329.172 116.283-459.767 166.375-50.092-43.83-53.67-93.922-90.344-142.224-42.04-57.248-315.755-200.366-446.35-228.095\"/><path fill=\"#efebe9\" d=\"M2318.554 1542.686c91.238 8.05 185.16-161.902 402.52-169.058 320.228-10.734 406.993 157.43 360.48 207.521-37.569-41.146-16.995-61.72-89.45-115.389-171.741-124.334-474.079-18.784-613.62 126.123-47.407 49.197-56.352 58.142-39.357 140.435 18.785 92.133 6.262 341.695 22.362 381.053 192.316 62.614 378.37-31.307 490.181-122.545 110.022-89.45 244.196-196.788 268.347-392.681 11.628-98.394-64.403-173.531-110.917-211.994-114.494-95.71-382.841-82.293-526.854-1.79-38.463 21.468-63.51 44.725-94.816 67.087-54.564 38.464-85.871 34.886-68.876 91.238m-1302.377-508.964 43.83-77.821c11.628-27.73 25.045-59.93 37.568-84.977 62.614-127.017 254.035-338.117 361.374-383.736 160.114-68.876 421.305-23.257 241.512 352.43-29.518 62.614-49.197 125.228-113.6 141.329-12.523-90.344 8.05-82.293 90.344-214.678 61.72-99.288 56.353-152.958 5.367-237.934-184.265-25.046-272.82 51.88-395.365 170.847-71.56 68.876-200.366 201.26-217.361 349.746 452.612-108.233 570.685 153.852 712.014-302.338 17.89-57.247 24.151-83.187 19.679-153.852-5.367-73.348-2.684-88.554-55.459-118.073-212.888-120.756-357.796-19.678-496.442 87.66-114.494 89.45-228.989 347.062-233.461 471.397\"/><path fill=\"#eee\" d=\"M506.317 1863.808c16.996-12.523 16.996-2.683 35.78-45.619l71.559-199.47c-140.435 11.627-140.435 153.851-107.339 245.09z\"/><path fill=\"#efebe9\" d=\"M653.014 2910.362c-12.523-50.092-166.376-94.816-225.412-89.45 8.05 92.133 129.701 101.078 225.412 89.45\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#e53935\" d=\"M4 4v24h24V4Zm20 20h-4V12h-4v12H8V8h16Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#fdd835\" d=\"M18.23 11.21q-.045-.24-1.32-1.65c-.02-.19.29-.45.9-.8l1.74-1.55c.39-.5.62-1.28.69-2.38l-.02-.26c-.07-.78-.63-1.4-1.69-1.89-.63-.42-1.76-.65-3.38-.68-1.35.11-3.11.59-5.28 1.43-.6.43-1.28.86-2.04 1.28l.01.14.21-.08c.08-.01.13.03.14.11l.13-.07.07-.01.01.06c0 .07-.47.44-1.76 1.35l-.06.12c-.31.02-.61.25-.91.67l.08.12.25-.09.18.24c.32-.33.66-.62 1.03-.87.19.05.29.11.44.16 1.02-.75 2.03-1.3 3.04-1.64l.01.14c-.2.27-.32.42-.38.42l.1.23c.01.19-2.55 7-6.66 14.44l.08.19c.35-.08.58-.17.75-.26l.01.13.4-.03-.67 1.76.14.06c.57-.64 1-1.29 1.3-1.88 1.67-.49 2.94-.97 3.82-1.44.88-.08 1.56-.31 2.02-.7l.92-.47c1.27-.98 2.22-1.67 2.87-2.08 1.33-.98 2.2-1.93 2.6-2.85zm-3.46 2.31L13 14.91c-1.29.85-2 1.3-2.09 1.3-2.07 1.13-3.36 1.72-3.86 1.76l-.05.01c.04-.23.96-2.12 2.75-5.67.78-.06 2.02-.43 3.71-1.1l.41-.03c.85-.08 1.49.09 1.91.49l.03.26c-.31.9-.67 1.44-1.04 1.59m1.09-5.78q-.27.33-1.5 1.11c-.27.03-1.27.42-3.01 1.18l-.28-.05-.01-.12c-.02-.25.09-.57.34-.95.13-.7.28-1.12.44-1.2l1.45-3.28c-.02-.22.29-.35.93-.46l.21-.02.01.18 1.16-.16c1.15-.1 1.75.14 1.8.7l.13-.02-.03-.32.15-.02c.35.19.52.4.54.68.02.18-.08.41-.29.68-.09.01-.14-.06-.15-.18l-.14.01-.03.4c-.58.87-1.01 1.31-1.27 1.34z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#3f51b5\" d=\"M22.713 4H9.287a.5.5 0 0 0-.432.248l-6.708 11.5a.5.5 0 0 0 0 .504l6.708 11.5a.5.5 0 0 0 .432.248h13.426a.5.5 0 0 0 .432-.248l6.708-11.5a.5.5 0 0 0 0-.504l-6.708-11.5A.5.5 0 0 0 22.713 4m-6.937 20.888-7.5-3.75A.5.5 0 0 1 8 20.691v-9.382a.5.5 0 0 1 .276-.447l7.5-3.75a.5.5 0 0 1 .448 0l7.5 3.75a.5.5 0 0 1 .276.447v9.382a.5.5 0 0 1-.276.447l-7.5 3.75a.5.5 0 0 1-.448 0\"/><path fill=\"#7986cb\" d=\"M22 19.441v-6.882a.5.5 0 0 0-.276-.447l-5.5-2.75a.5.5 0 0 0-.448 0l-5.5 2.75a.5.5 0 0 0-.276.447v6.882a.5.5 0 0 0 .276.447l5.5 2.75a.5.5 0 0 0 .448 0l5.5-2.75a.5.5 0 0 0 .276-.447\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><path fill=\"#f44336\" d=\"M2 8h4v1H2zm0 6h4v1H2zm9-10h3v1h-3zM2 2h3v1H2z\"/><path fill=\"#f9a825\" d=\"M9 2h3v1H9zm1 4h4v1h-4zm-5 6h1v1H5zm-3-2h6v1H2z\"/><path fill=\"#26a69a\" d=\"M2 12h3v1H2zm7-4h5v1H9zM2 4h4v1H2zm3-2h4v1H5z\"/><path fill=\"#ba68c8\" d=\"M2 6h3v1H2zm7-2h2v1H9zm-1 6h4v1H8z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#757575\" d=\"M15 2H6a2.006 2.006 0 0 0-2 2v22a2.006 2.006 0 0 0 2 2h6v-4H6v-2h6v-2H6v-2h6v-2H6v-2h6v-2h2V4l8 8h2v-1Z\" data-mit-no-recolor=\"true\"/><path fill=\"#0288d1\" d=\"M12 12v18h18V12Zm8 6h-2v8h-2v-8h-2v-2h6Zm8 0h-4v2h2a2.006 2.006 0 0 1 2 2v2a2.006 2.006 0 0 1-2 2h-4v-2h4v-2h-2a2.006 2.006 0 0 1-2-2v-2a2.006 2.006 0 0 1 2-2h4Z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><path fill=\"#a0f\" d=\"M29.313 12h-6.664a1.427 1.427 0 0 1-1.1-2.24l4.398-6.676A.703.703 0 0 0 25.397 2H8.428a.62.62 0 0 0-.55.289l-5.77 8.627A.703.703 0 0 0 2.658 12h8.175a1.427 1.427 0 0 1 1.099 2.24l-4.48 6.676A.702.702 0 0 0 8 22l6.695.002A1.34 1.34 0 0 1 16 23.375v5.934a.652.652 0 0 0 1.168.433l12.694-16.586a.725.725 0 0 0-.55-1.156\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#fafafa\" fill-opacity=\".785\" d=\"m19.376 15.988-7.708 4.45-7.709-4.45v-8.9l7.709-4.451 7.708 4.45z\"/><path fill=\"#90caf9\" d=\"M12.286 1.98c-.21 0-.41.059-.57.179l-7.9 4.44c-.32.17-.53.5-.53.88v9c0 .38.21.711.53.881l7.9 4.44c.16.12.36.18.57.18s.41-.06.57-.18l7.9-4.44c.32-.17.53-.5.53-.88v-9c0-.38-.21-.712-.53-.882l-7.9-4.44a.95.95 0 0 0-.57-.179zm0 2.15 7 3.94v2.103h-.016v5.177h.016v.54l-7 3.939-7-3.94V8.07zm0 2.08-4.9 2.83 4.9 2.83 4.9-2.83zm-5 5.08v3.58l4 2.309v-3.58l-4-2.31zm10 0-4 2.308v3.58l4-2.308z\"/><path fill=\"#0277bd\" d=\"m12.286 6.21-4.9 2.83 4.9 2.83 4.9-2.83zm-5 5.08v3.58l4 2.309v-3.58l-4-2.31zm10 0-4 2.308v3.58l4-2.308z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\" viewBox=\"0 0 16 16\"><path d=\"M0 0h24v24H0z\"/><path fill=\"#42a5f5\" d=\"M8 1C4.136 1 1 4.136 1 8s3.136 7 7 7 7-3.136 7-7-3.136-7-7-7m1 11H7V7.5h2zm0-6H7V4h2z\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><path fill=\"#ff5722\" d=\"M8 1a5.5 5.5 0 0 0-4 9.26V15l4-1.5 4 1.5v-4.74A5.49 5.49 0 0 0 8 1m0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8m0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\" viewBox=\"0 0 24 24\"><path d=\"M0 0h24v24H0z\"/><path fill=\"#8bc34a\" d=\"M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.95 8.95 0 0 0 13 21a9 9 0 0 0 0-18m-1 5v5l4.25 2.52.77-1.28-3.52-2.09V8z\"/></svg>","<svg viewBox=\"0 0 16 16\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m8.668 6h3.6641l-3.6641-3.668v3.668m-4.668-4.668h5.332l4 4v8c0 0.73828-0.59375 1.3359-1.332 1.3359h-8c-0.73828 0-1.332-0.59766-1.332-1.3359v-10.664c0-0.74219 0.59375-1.3359 1.332-1.3359m3.332 1.3359h-3.332v10.664h8v-6h-4.668z\" fill=\"#90a4ae\" /></svg>","<svg viewBox=\"0 0 16 16\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232\" fill=\"#90a4ae\" /></svg>","<svg viewBox=\"0 0 16 16\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6\" fill=\"#90a4ae\" /></svg>"],"default":90,"folder":91,"folderOpen":92,"byExt":{"js":0,"mjs":0,"cjs":0,"jsx":1,"ts":2,"mts":2,"cts":2,"tsx":3,"json":4,"jsonc":4,"json5":4,"jsonl":4,"html":5,"htm":5,"xhtml":5,"css":6,"scss":7,"sass":7,"less":8,"md":9,"markdown":9,"mdx":10,"txt":11,"py":12,"pyc":13,"pyw":12,"ipynb":14,"go":15,"rs":16,"java":17,"class":18,"jar":19,"c":20,"h":21,"cc":22,"cpp":22,"cxx":22,"hpp":23,"cs":24,"vb":25,"fs":26,"fsi":26,"kt":27,"kts":27,"swift":28,"rb":29,"php":30,"pl":31,"pm":32,"sh":33,"bash":33,"zsh":33,"fish":33,"bat":33,"cmd":33,"ps1":34,"psd1":34,"psm1":34,"lua":35,"r":36,"scala":37,"clj":38,"cljs":38,"edn":38,"ex":39,"exs":39,"erl":40,"vue":41,"svelte":42,"astro":43,"graphql":44,"gql":44,"prisma":45,"yml":46,"yaml":46,"toml":47,"ini":48,"cfg":48,"conf":48,"env":49,"sqlite":50,"db":50,"sql":50,"lock":51,"xml":52,"plist":52,"svg":53,"png":54,"jpg":54,"jpeg":54,"gif":54,"webp":54,"ico":54,"bmp":54,"tif":54,"tiff":54,"pdf":55,"doc":56,"docx":56,"xls":57,"xlsx":57,"ppt":58,"pptx":58,"csv":57,"tsv":57,"zip":59,"tar":59,"gz":59,"tgz":59,"bz2":59,"xz":59,"7z":59,"rar":59,"ttf":60,"otf":60,"woff":60,"woff2":60,"eot":60,"mp3":61,"wav":61,"ogg":62,"flac":61,"m4a":61,"mp4":62,"mkv":62,"avi":62,"mov":62,"webm":62,"wasm":63,"exe":64,"msi":64,"dll":65,"so":65,"a":66,"o":67,"obj":67,"log":68,"diff":69,"patch":70,"pot":71,"po":71},"byName":{"dockerfile":72,"makefile":73,"cmakelists.txt":74,"package.json":75,"package-lock.json":75,"pnpm-lock.yaml":76,"yarn.lock":77,"bun.lockb":78,".gitignore":70,".gitattributes":70,".editorconfig":79,".npmrc":80,".nvmrc":75,".babelrc":81,".babelrc.json":81,".eslintrc":82,".eslintrc.json":82,".prettierrc":83,".prettierrc.json":83,"tsconfig.json":84,"vite.config.ts":85,"vite.config.js":85,"webpack.config.js":86,"readme.md":87,"license":88,"changelog.md":89}};

const STYLES = [
  // sidebar entry: 28px icon button at the end of the workspace section
  // header's icon row (after view options / add workspace)
  ".dsh-utils-sidebar-entry{width:28px;height:28px;flex:none;display:inline-flex;",
  "align-items:center;justify-content:center;border:none;background:0 0;padding:0;",
  "color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:8px;}",
  ".dsh-utils-sidebar-entry:hover{background:var(--dsw-alias-interactive-bg-hover);}",
  ".dsh-utils-sidebar-entry[data-active]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);}",
  ".dsh-utils-sidebar-entry svg{width:16px;height:16px;display:block;}",
  // file panel: right-side column of the frame grid (pushed open, so the
  // conversation shrinks and nothing behind the panel is covered)
  ".dsh-utils-files-col{min-width:0;overflow:hidden;display:none;flex-direction:column;",
  "background:var(--dsw-specific-page);color:var(--dsw-alias-label-primary);",
  "border-left:1px solid var(--dsw-alias-border-l2);}",
  "html[data-dsh-utils-files-active] .dsh-utils-files-col{display:flex;}",
  ".dsh-utils-files-view{height:100%;min-height:0;display:flex;flex-direction:column;}",
  ".dsh-utils-files-header{display:flex;align-items:center;gap:8px;padding:10px 14px;",
  "border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;}",
  ".dsh-utils-files-title{font-size:14px;font-weight:600;flex:none;}",
  ".dsh-utils-files-workspace{flex:1;min-width:0;display:flex;align-items:center;gap:6px;}",
  ".dsh-utils-files-workspace select{max-width:100%;min-width:0;background:var(--dsw-specific-menu);",
  "color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;",
  "padding:4px 8px;font-size:12px;font-family:inherit;height:26px;}",
  ".dsh-utils-files-tool{padding:0;width:28px;height:28px;border-radius:8px;border:none;",
  "background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:28px;}",
  ".dsh-utils-files-tool:hover{background:var(--dsw-alias-interactive-bg-hover);}",
  ".dsh-utils-files-tool svg{width:16px;height:16px;display:block;margin:6px auto;}",
  ".dsh-utils-files-search{padding:8px 14px 0;flex:none;}",
  ".dsh-utils-files-search input{width:100%;height:30px;padding:0 10px;border-radius:8px;",
  "border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input);",
  "color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;}",
  ".dsh-utils-files-body{flex:1;min-height:0;display:flex;flex-direction:column;}",
  ".dsh-utils-files-tree{flex:2;min-height:120px;overflow:auto;padding:6px 4px;",
  "border-bottom:1px solid var(--dsw-alias-border-l2);}",
  ".dsh-utils-files-preview{flex:3;min-height:160px;overflow:auto;display:flex;flex-direction:column;}",
  ".dsh-utils-files-preview-header{display:flex;align-items:center;gap:8px;padding:8px 12px;",
  "border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;flex:none;}",
  ".dsh-utils-files-preview-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
  "color:var(--dsw-alias-label-secondary);}",
  ".dsh-utils-files-preview-meta{flex:none;color:var(--dsw-alias-label-tertiary);}",
  ".dsh-utils-files-preview-actions{flex:none;display:flex;gap:4px;}",
  ".dsh-utils-files-preview-actions button{height:24px;padding:0 10px;border-radius:6px;border:none;",
  "background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);",
  "font-family:inherit;font-size:12px;cursor:pointer;}",
  ".dsh-utils-files-preview-actions button:hover{background:var(--dsw-alias-interactive-bg-active);}",
  ".dsh-utils-files-preview-actions button.dsh-utils-danger{color:var(--dsw-alias-state-error-primary);}",
  ".dsh-utils-files-pre{flex:1;min-height:0;margin:0;padding:12px 14px;overflow:auto;",
  "font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;line-height:1.6;",
  "white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary);}",
  ".dsh-utils-files-pre.hljs{padding:12px 14px;}",
  ".dsh-utils-files-img{max-width:100%;height:auto;display:block;margin:12px auto;border-radius:8px;}",
  ".dsh-utils-files-textarea{flex:1;min-height:0;margin:8px 10px;padding:10px 12px;border-radius:8px;",
  "border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input);",
  "color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;",
  "font-size:12.5px;line-height:1.6;resize:none;}",
  ".dsh-utils-files-row{display:flex;align-items:center;gap:5px;height:26px;padding:0 6px;",
  "border-radius:6px;cursor:pointer;font-size:12.5px;white-space:nowrap;color:var(--dsw-alias-label-secondary);}",
  ".dsh-utils-files-row:hover{background:var(--dsw-alias-interactive-bg-hover);}",
  ".dsh-utils-files-row-selected{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);}",
  ".dsh-utils-files-row-dir{color:var(--dsw-alias-label-primary);font-weight:500;}",
  ".dsh-utils-files-row-dragover{outline:1px dashed var(--dsw-alias-border-inverted);outline-offset:-2px;",
  "background:var(--dsw-alias-interactive-bg-active);}",
  ".dsh-utils-files-row[draggable=\"true\"]{cursor:grab;}",
  ".dsh-utils-files-row[draggable=\"true\"]:active{cursor:grabbing;}",
  // context menu
  ".dsh-utils-files-menu-mask{position:fixed;inset:0;z-index:49;}",
  ".dsh-utils-files-menu{position:fixed;z-index:50;min-width:150px;padding:4px;border-radius:10px;",
  "border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);",
  "box-shadow:var(--dsw-shadow-lv3);}",
  ".dsh-utils-files-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;",
  "border:none;background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;",
  "font-size:12.5px;line-height:18px;cursor:pointer;border-radius:6px;text-align:left;}",
  ".dsh-utils-files-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover);}",
  ".dsh-utils-files-menu-item-danger{color:var(--dsw-alias-state-error-primary);}",
  ".dsh-utils-files-menu-item-hint{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
  ".dsh-utils-files-row-icon{flex:none;width:16px;display:inline-flex;align-items:center;}",
  ".dsh-utils-files-row-icon svg{width:16px;height:16px;display:block;flex:none;}",
  ".dsh-utils-files-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;}",
  ".dsh-utils-files-row-size{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
  ".dsh-utils-files-hint{padding:14px;font-size:12.5px;color:var(--dsw-alias-label-tertiary);}",
  ".dsh-utils-files-error{padding:10px 14px;font-size:12.5px;color:var(--dsw-alias-state-error-primary);}",
  ".dsh-utils-files-new{display:flex;gap:6px;padding:8px 14px 0;flex:none;}",
  ".dsh-utils-files-new input{flex:1;min-width:0;height:30px;padding:0 10px;border-radius:8px;",
  "border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input);",
  "color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;}",
  ".dsh-utils-files-new button{height:30px;padding:0 12px;border-radius:8px;border:none;",
  "background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);",
  "font-family:inherit;font-size:13px;cursor:pointer;}",
  ".dsh-utils-files-new button:hover{background:var(--dsw-alias-interactive-bg-active);}",
].join("\n");

function interpolate(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  );
}

function adoptStyles() {
  if (typeof document === "undefined") return;
  const tagId = "dsh-utils/styles";
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-utils";
  tag.dataset.pluginCss = tagId;
  tag.textContent = STYLES + "\n" + themeCss;
  document.head.appendChild(tag);
}

// ── file-type icons ─────────────────────────────────────────────────────────

/**
 * Resolve the SVG for one tree row: directories get folder glyphs (open or
 * closed), files match by exact name then by extension, with a default file
 * glyph as fallback. Data comes from the embedded material-icon-theme set.
 */
function fileIconSvg(name, isDir, isOpen) {
  const icons = FILE_ICONS;
  if (isDir) return icons.svgs[isOpen ? icons.folderOpen : icons.folder];
  const lower = name.toLowerCase();
  const byName = icons.byName[lower];
  if (byName !== undefined) return icons.svgs[byName];
  const dot = lower.lastIndexOf(".");
  if (dot > 0) {
    const ext = lower.slice(dot + 1);
    const byExt = icons.byExt[ext];
    if (byExt !== undefined) return icons.svgs[byExt];
  }
  return icons.svgs[icons.default];
}

// ── syntax highlighting ─────────────────────────────────────────────────────

/** Extension / file-name → highlight.js language id. */
const EXT_LANG = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  py: "python", pyw: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
  cs: "csharp", kt: "kotlin", kts: "kotlin", swift: "swift", php: "php",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell",
  lua: "lua", json: "json", jsonc: "json", json5: "json",
  html: "xml", htm: "xml", vue: "xml", svg: "xml", xml: "xml",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  css: "css", scss: "scss", less: "less", sql: "sql", graphql: "graphql", gql: "graphql",
  diff: "diff", patch: "diff",
};
const NAME_LANG = {
  dockerfile: "dockerfile", makefile: "makefile", "cmakelists.txt": "makefile",
};

/**
 * Highlight one text file for the preview pane. Unknown types fall back to
 * plaintext (which still HTML-escapes the content).
 * @param content - raw file text.
 * @param name - file name (used for language detection).
 * @returns highlighted, HTML-escaped markup.
 */
function highlightCode(content, name) {
  const lower = name.toLowerCase();
  let lang = NAME_LANG[lower];
  if (lang === undefined) {
    const dot = lower.lastIndexOf(".");
    if (dot > 0) lang = EXT_LANG[lower.slice(dot + 1)];
  }
  if (lang !== undefined && hljs.getLanguage(lang) !== undefined) {
    try {
      return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
    } catch (err) {
      // fall through to plaintext
    }
  }
  try {
    return hljs.highlight(content, { language: "plaintext" }).value;
  } catch (err) {
    // last resort: manual escaping
    return content.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
  }
}

// ── workspace file manager ───────────────────────────────────────────────────

/** Persistent key of the last-selected workspace root. */
const FILES_ROOT_KEY = "dsh-utils:files-root";

/** Tiny pub-sub store shared by the sidebar entry and the panel view. */
const filesBus = {
  open: false,
  listeners: new Set(),
  setOpen(open) {
    if (this.open === open) return;
    this.open = open;
    for (const fn of this.listeners) fn();
  },
  toggle() {
    this.setOpen(!this.open);
  },
  subscribe(fn) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  },
};

/** Folder glyph for the sidebar entry. */
const FILES_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4.5v7a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H8L6.5 3h-3.5A1.5 1.5 0 0 0 1.5 4.5Z"/></svg>';

/**
 * DOM-injected sidebar entry, placed at the end of the workspace section
 * header's icon row (search / view options / add workspace), so it sits in
 * one continuous row with the other icons. The shell's sidebar exposes no
 * stable external slot there, so the button is inserted at the DOM level and
 * self-heals: a MutationObserver re-inserts it whenever a React re-render
 * displaces it.
 * @param label - localized entry label.
 * @returns disposer.
 */
function mountSidebarEntry(label) {
  const ENTRY_ATTR = "data-dsh-utils-entry";
  const HEADER_SELECTOR = '[data-slot="sidebar.workspaces"] [class*="sectionHeader"]';
  const ACTIONS_SELECTOR = '[class*="headerActions"]';
  const SEARCH_SELECTOR = '[class*="searchSlot"]';
  const entry = document.createElement("button");
  entry.type = "button";
  entry.className = "dsh-utils-sidebar-entry";
  entry.dataset.dshUtilsEntry = "";
  entry.setAttribute("aria-label", label);
  entry.title = label;
  entry.innerHTML = FILES_ICON;
  entry.addEventListener("click", () => filesBus.toggle());

  const place = () => {
    const header = document.querySelector(HEADER_SELECTOR);
    if (header === null) return;
    const actions = header.querySelector(ACTIONS_SELECTOR);
    const anchor = actions !== null ? actions : header.querySelector(SEARCH_SELECTOR);
    if (anchor === null) return;
    const targetNext = anchor.nextElementSibling;
    // Already placed directly after the anchor.
    if (entry.parentElement === header && header.contains(entry) && entry.previousElementSibling === anchor) return;
    if (entry.parentElement !== null) entry.remove();
    header.insertBefore(entry, targetNext);
  };

  const observer = new MutationObserver(() => { place(); });
  observer.observe(document.body, { childList: true, subtree: true });
  place();

  const applyActive = () => {
    if (filesBus.open) entry.dataset.active = "";
    else delete entry.dataset.active;
  };
  const unsubscribe = filesBus.subscribe(applyActive);
  applyActive();

  return () => {
    unsubscribe();
    observer.disconnect();
    entry.remove();
  };
}

/** The file-panel React tree, mounted inside the right-side floating column. */
function FilesPanel(props) {
  const api = props.api;
  const t = props.t;
  const fmt = (key, values) => interpolate(t(key), values);

  const [workspaces, setWorkspaces] = React.useState(null); // null = loading
  const [root, setRoot] = React.useState(() => {
    try {
      return localStorage.getItem(FILES_ROOT_KEY) || "";
    } catch (err) {
      return "";
    }
  });
  const [dirs, setDirs] = React.useState({}); // rel -> entries | null
  const [expanded, setExpanded] = React.useState({}); // rel -> bool
  const [loadingDirs, setLoadingDirs] = React.useState({}); // rel -> bool
  const [selected, setSelected] = React.useState(null); // rel of selected file
  const [preview, setPreview] = React.useState(null); // {path,...} | {error,...}
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState(null); // {query, hits, truncated} | null
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [notice, setNotice] = React.useState(null); // transient status line
  const [menu, setMenu] = React.useState(null); // {x, y, path, name, isDir} | null
  const [hoverDir, setHoverDir] = React.useState(null); // drag-over folder rel
  const dragSource = React.useRef(null); // rel path being dragged

  // Refs keep the loader callbacks stable across renders so effects keyed on
  // them never re-run (an unstable identity would loop list() calls).
  const rootRef = React.useRef(root);
  rootRef.current = root;
  const fmtRef = React.useRef(fmt);
  fmtRef.current = fmt;

  /** Remove one path (recycle bin) after the caller confirmed. */
  const removePath = (path) => {
    setPreview((prev) => (prev !== null && prev.path === path ? null : prev));
    setSelected((prev) => (prev === path ? null : prev));
    Promise.resolve()
      .then(() => api.remove(root, path))
      .then((result) => {
        if (result.ok) {
          loadDir(parentOf(path));
          setExpanded((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(next)) {
              if (key === path || key.startsWith(path + "/")) delete next[key];
            }
            return next;
          });
          setDirs((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(next)) {
              if (key === path || key.startsWith(path + "/")) delete next[key];
            }
            return next;
          });
        } else {
          setNotice(fmt("filesError", { message: result.error.message }));
        }
      }, (err) => {
        setNotice(fmt("filesError", { message: String(err && err.message ? err.message : err) }));
      });
  };

  /** Move one path into a destination directory ('' = root); drag & drop. */
  const doMove = (from, toDir) => {
    if (from === "" || from === undefined) return;
    // Already in that directory ('' = root when the source is at root):
    // silent no-op instead of a "same destination" error.
    if (toDir === parentOf(from)) return;
    Promise.resolve()
      .then(() => api.move(root, from, toDir))
      .then((result) => {
        if (result.ok) {
          setNotice(fmt("filesMoved", {}));
          loadDir(parentOf(from));
          loadDir(toDir);
          setPreview((prev) => (prev !== null && prev.path === from ? null : prev));
          setSelected((prev) => (prev === from ? null : prev));
          setDirs((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(next)) {
              if (key === from || key.startsWith(from + "/")) delete next[key];
            }
            return next;
          });
        } else {
          setNotice(result.error.message.indexOf("move-conflict") !== -1
            ? fmt("filesMoveConflict", {})
            : fmt("filesError", { message: result.error.message }));
        }
      }, (err) => {
        setNotice(fmt("filesError", { message: String(err && err.message ? err.message : err) }));
      });
  };

  const loadDir = React.useCallback((rel) => {
    const currentRoot = rootRef.current;
    setLoadingDirs((prev) => ({ ...prev, [rel]: true }));
    Promise.resolve()
      .then(() => api.list(currentRoot, rel))
      .then((result) => {
        if (result.ok) {
          setDirs((prev) => ({ ...prev, [rel]: result.value.entries }));
        } else {
          setDirs((prev) => ({ ...prev, [rel]: null }));
          setNotice(fmtRef.current("filesError", { message: result.error.message }));
        }
      }, (err) => {
        setDirs((prev) => ({ ...prev, [rel]: null }));
        setNotice(fmtRef.current("filesError", { message: String(err && err.message ? err.message : err) }));
      })
      .finally(() => setLoadingDirs((prev) => ({ ...prev, [rel]: false })));
  }, [api]);

  // Load workspaces on mount.
  React.useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => api.workspaces())
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setWorkspaces(result.value.workspaces);
          if (root === "" && result.value.workspaces.length > 0) {
            setRoot(result.value.workspaces[0].path);
          }
        } else {
          setWorkspaces([]);
        }
      }, () => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset the tree whenever the root changes.
  React.useEffect(() => {
    setDirs({});
    setExpanded({});
    setSelected(null);
    setPreview(null);
    setEditing(false);
    setHits(null);
    setQuery("");
    if (root !== "") {
      try {
        localStorage.setItem(FILES_ROOT_KEY, root);
      } catch (err) {
        // storage unavailable; ignore
      }
      loadDir("");
    }
  }, [root, loadDir]);

  const toggleDir = (rel) => {
    setExpanded((prev) => {
      const next = { ...prev, [rel]: !prev[rel] };
      if (next[rel] && dirs[rel] === undefined && loadingDirs[rel] !== true) loadDir(rel);
      return next;
    });
  };

  const openFile = (path) => {
    setSelected(path);
    setEditing(false);
    setPreview({ path, loading: true });
    Promise.resolve()
      .then(() => api.read(root, path))
      .then((result) => {
        if (result.ok) {
          const value = result.value;
          if (value.isImage === true) {
            setPreview({ path, image: value.content, size: value.size, mtime: value.mtime });
            return;
          }
          if (value.size > 0 && value.content.indexOf("\u0000") !== -1) {
            setPreview({ path, error: fmt("filesBinary", {}) });
            return;
          }
          setPreview({ path, content: value.content, truncated: value.truncated, size: value.size, mtime: value.mtime });
        } else {
          setPreview({ path, error: result.error.message });
        }
      }, (err) => {
        setPreview({ path, error: String(err && err.message ? err.message : err) });
      });
  };

  const parentOf = (path) => {
    const index = path.lastIndexOf("/");
    return index === -1 ? "" : path.slice(0, index);
  };

  const saveFile = () => {
    if (preview === null || preview.path === undefined) return;
    const path = preview.path;
    Promise.resolve()
      .then(() => api.write(root, path, draft, preview.mtime))
      .then((result) => {
        if (result.ok) {
          setPreview((prev) => ({ ...prev, content: draft, mtime: result.value.mtime, truncated: false }));
          setEditing(false);
          setNotice(fmt("filesSaved", {}));
          loadDir(parentOf(path));
        } else {
          setNotice(result.error.message.indexOf("write-conflict") !== -1
            ? fmt("filesWriteConflict", {})
            : fmt("filesError", { message: result.error.message }));
        }
      }, (err) => {
        setNotice(fmt("filesError", { message: String(err && err.message ? err.message : err) }));
      });
  };

  const removeFile = () => {
    if (preview === null || preview.path === undefined) return;
    const path = preview.path;
    let confirmed = false;
    try {
      confirmed = window.confirm(fmt("filesDeleteConfirm", { path }));
    } catch (err) {
      confirmed = false;
    }
    if (!confirmed) return;
    setPreview(null);
    setSelected(null);
    removePath(path);
  };

  /** Delete from the context menu (right-click on a tree row). */
  const menuDelete = () => {
    if (menu === null) return;
    const path = menu.path;
    setMenu(null);
    let confirmed = false;
    try {
      confirmed = window.confirm(fmt("filesDeleteConfirm", { path }));
    } catch (err) {
      confirmed = false;
    }
    if (!confirmed) return;
    removePath(path);
  };

  /** Open a terminal on the host at the menu's directory. */
  const menuTerminal = () => {
    if (menu === null) return;
    const path = menu.path;
    setMenu(null);
    Promise.resolve()
      .then(() => api.openTerminal(root, path))
      .then((result) => {
        if (!result.ok) setNotice(fmt("filesError", { message: result.error.message }));
      }, (err) => {
        setNotice(fmt("filesError", { message: String(err && err.message ? err.message : err) }));
      });
  };

  /** Open a terminal on the host at the current workspace root. */
  const openRootTerminal = () => {
    Promise.resolve()
      .then(() => api.openTerminal(root, ""))
      .then((result) => {
        if (!result.ok) setNotice(fmt("filesError", { message: result.error.message }));
      }, (err) => {
        setNotice(fmt("filesError", { message: String(err && err.message ? err.message : err) }));
      });
  };

  const createFile = () => {
    const name = newName.trim();
    if (name === "") return;
    const path = name.startsWith("/") ? name.slice(1) : name;
    Promise.resolve()
      .then(() => api.write(root, path, "", undefined))
      .then((result) => {
        if (result.ok) {
          setCreating(false);
          setNewName("");
          loadDir(parentOf(path));
          openFile(path);
        } else {
          setNotice(fmt("filesError", { message: result.error.message }));
        }
      }, (err) => {
        setNotice(fmt("filesError", { message: String(err && err.message ? err.message : err) }));
      });
  };

  // Debounced filename search.
  React.useEffect(() => {
    const needle = query.trim();
    if (needle === "" || root === "") {
      setHits(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => api.search(root, needle))
        .then((result) => {
          if (cancelled) return;
          if (result.ok) setHits(result.value);
          else setHits(null);
        }, () => {
          if (!cancelled) setHits(null);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, root, api]);

  const searching = hits !== null;

  // Render one tree level as an ARRAY of rows (never a bare element), so a
  // parent can safely spread it.
  const renderRows = (rel, depth) => {
    const entries = dirs[rel];
    if (entries === undefined) {
      if (loadingDirs[rel] === true) {
        return [React.createElement("div", { className: "dsh-utils-files-hint", key: rel },
          "  ".repeat(depth) + fmt("filesLoading", {}))];
      }
      return null;
    }
    if (entries === null) return null;
    return entries.map((entry) => {
      const rowKey = entry.path;
      const isOpen = expanded[entry.path] === true;
      const click = () => {
        if (entry.isDir) toggleDir(entry.path);
        else openFile(entry.path);
      };
      const row = React.createElement(
        "div",
        {
          key: rowKey,
          className: "dsh-utils-files-row" +
            (entry.isDir ? " dsh-utils-files-row-dir" : "") +
            (selected === entry.path ? " dsh-utils-files-row-selected" : "") +
            (hoverDir === entry.path ? " dsh-utils-files-row-dragover" : ""),
          onClick: click,
          onContextMenu: (event) => {
            event.preventDefault();
            event.stopPropagation();
            setMenu({ x: event.clientX, y: event.clientY, path: entry.path, name: entry.name, isDir: entry.isDir });
          },
          draggable: true,
          onDragStart: (event) => {
            dragSource.current = entry.path;
            try { event.dataTransfer.effectAllowed = "move"; } catch (err) { /* ignore */ }
          },
          onDragOver: (event) => {
            if (dragSource.current === null) return;
            event.preventDefault();
            try { event.dataTransfer.dropEffect = "move"; } catch (err) { /* ignore */ }
            if (entry.isDir && dragSource.current !== entry.path) setHoverDir(entry.path);
          },
          onDragLeave: () => {
            setHoverDir((prev) => (prev === entry.path ? null : prev));
          },
          onDrop: (event) => {
            event.preventDefault();
            event.stopPropagation();
            const from = dragSource.current;
            dragSource.current = null;
            setHoverDir(null);
            if (from === null || from === entry.path) return;
            if (entry.isDir) {
              // Dropping onto the source's own parent is a no-op.
              if (parentOf(from) !== entry.path) doMove(from, entry.path);
            } else {
              // Dropping onto a file moves into its parent folder.
              const parent = parentOf(entry.path);
              if (parent !== from && parent !== parentOf(from)) doMove(from, parent);
            }
          },
          title: entry.path,
          style: { paddingLeft: String(6 + depth * 14) + "px" },
        },
        React.createElement("span", {
          className: "dsh-utils-files-row-icon",
          dangerouslySetInnerHTML: { __html: fileIconSvg(entry.name, entry.isDir, isOpen) },
        }),
        React.createElement("span", { className: "dsh-utils-files-row-name" }, entry.name),
        !entry.isDir && React.createElement(
          "span",
          { className: "dsh-utils-files-row-size" },
          entry.size > 0 ? (entry.size >= 1024 ? (entry.size / 1024).toFixed(1) + "K" : String(entry.size) + "B") : ""
        )
      );
      if (!entry.isDir || !isOpen) return row;
      const children = renderRows(entry.path, depth + 1);
      if (children === null) return row;
      return [row, ...children];
    });
  };

  const treeContent = searching
    ? (hits !== null && hits.hits.length === 0
        ? React.createElement("div", { className: "dsh-utils-files-hint" }, fmt("filesEmpty", {}))
        : hits !== null && hits.hits.map((hit) =>
            React.createElement(
              "div",
              {
                key: hit.path,
                className: "dsh-utils-files-row" + (selected === hit.path ? " dsh-utils-files-row-selected" : ""),
                onClick: () => openFile(hit.path),
                title: hit.path,
              },
              React.createElement("span", {
                className: "dsh-utils-files-row-icon",
                dangerouslySetInnerHTML: { __html: fileIconSvg(hit.name, false, false) },
              }),
              React.createElement("span", { className: "dsh-utils-files-row-name" }, hit.path)
            )
          ))
    : renderRows("", 0);

  const previewHeader = preview !== null && preview.path !== undefined
    ? React.createElement(
        "div",
        { className: "dsh-utils-files-preview-header" },
        React.createElement("span", { className: "dsh-utils-files-preview-path" }, preview.path),
        preview.size !== undefined &&
          React.createElement("span", { className: "dsh-utils-files-preview-meta" }, String(preview.size) + "B"),
        React.createElement(
          "div",
          { className: "dsh-utils-files-preview-actions" },
          !editing &&
            React.createElement("button", { type: "button", onClick: () => { setDraft(preview.content ?? ""); setEditing(true); } }, t("filesEdit")),
          editing &&
            React.createElement("button", { type: "button", onClick: saveFile }, t("filesSave")),
          editing &&
            React.createElement("button", { type: "button", onClick: () => setEditing(false) }, t("filesCancel")),
          !editing &&
            React.createElement("button", { type: "button", className: "dsh-utils-danger", onClick: removeFile }, t("filesDelete"))
        )
      )
    : null;

  const previewBody = (() => {
    if (preview === null) {
      return React.createElement("div", { className: "dsh-utils-files-hint" }, t("filesPreview"));
    }
    if (preview.loading === true) {
      return React.createElement("div", { className: "dsh-utils-files-hint" }, fmt("filesLoading", {}));
    }
    if (preview.error !== undefined) {
      return React.createElement("div", { className: "dsh-utils-files-error" }, preview.error);
    }
    if (editing) {
      return React.createElement("textarea", {
        className: "dsh-utils-files-textarea",
        value: draft,
        onChange: (event) => setDraft(event.target.value),
        spellCheck: false,
      });
    }
    if (preview.image !== undefined) {
      return React.createElement("img", {
        className: "dsh-utils-files-img",
        src: preview.image,
        alt: preview.path,
        title: preview.path,
      });
    }
    const children = [React.createElement("pre", {
      className: "dsh-utils-files-pre hljs",
      key: "pre",
      dangerouslySetInnerHTML: { __html: highlightCode(preview.content, preview.path) },
    })];
    if (preview.truncated === true) {
      children.push(React.createElement("div", { className: "dsh-utils-files-hint", key: "trunc" }, fmt("filesTruncated", {})));
    }
    return children;
  })();

  const workspaceOptions = workspaces === null
    ? React.createElement("option", { key: "loading" }, fmt("filesLoading", {}))
    : workspaces.length === 0
      ? React.createElement("option", { key: "none" }, t("filesNoWorkspace"))
      : workspaces.map((workspace) =>
          React.createElement("option", { key: workspace.path, value: workspace.path },
            workspace.title + " — " + workspace.path)
        );

  return React.createElement(
    "div",
    { className: "dsh-utils-files-view", "data-dsh-utils-files-view": "" },
    React.createElement(
      "div",
      { className: "dsh-utils-files-header" },
      React.createElement("span", { className: "dsh-utils-files-title" }, t("filesTitle")),
      React.createElement(
        "label",
        { className: "dsh-utils-files-workspace" },
        React.createElement(
          "select",
          {
            value: root,
            disabled: workspaces === null || workspaces.length === 0,
            onChange: (event) => setRoot(event.target.value),
            title: t("filesSelectWorkspace"),
          },
          workspaceOptions
        )
      ),
      React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-utils-files-tool",
          title: t("filesTerminalRoot"),
          onClick: openRootTerminal,
        },
        React.createElement(
          "svg",
          { viewBox: "0 0 16 16", "aria-hidden": "true" },
          React.createElement("path", {
            fill: "currentColor",
            d: "M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM7.25 8a.75.75 0 0 1-.22.53l-2.25 2.25a.75.75 0 1 1-1.06-1.06L5.44 8 3.72 6.28a.75.75 0 1 1 1.06-1.06l2.25 2.25c.141.14.22.331.22.53Zm1.5 1.5a.75.75 0 0 1 0-1.5h3a.75.75 0 0 1 0 1.5Z",
          })
        )
      ),
      React.createElement(
        "button",
        { type: "button", className: "dsh-utils-files-tool", title: t("filesNewFile"), onClick: () => setCreating((value) => !value) },
        "+"
      ),
      React.createElement(
        "button",
        { type: "button", className: "dsh-utils-files-tool", title: t("filesRefresh"), onClick: () => { loadDir(""); setHits(null); } },
        "⟳"
      ),
      React.createElement(
        "button",
        { type: "button", className: "dsh-utils-files-tool", title: t("filesClose"), onClick: () => filesBus.setOpen(false) },
        "×"
      )
    ),
    React.createElement(
      "div",
      { className: "dsh-utils-files-search" },
      React.createElement("input", {
        type: "text",
        placeholder: t("filesSearch"),
        value: query,
        onChange: (event) => setQuery(event.target.value),
        spellCheck: false,
      })
    ),
    creating &&
      React.createElement(
        "div",
        { className: "dsh-utils-files-new" },
        React.createElement("input", {
          type: "text",
          placeholder: t("filesNewFileName"),
          value: newName,
          onChange: (event) => setNewName(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") createFile();
            if (event.key === "Escape") setCreating(false);
          },
        }),
        React.createElement("button", { type: "button", onClick: createFile }, t("filesCreate"))
      ),
    notice !== null &&
      React.createElement("div", { className: "dsh-utils-files-hint", onClick: () => setNotice(null) }, notice),
    React.createElement(
      "div",
      {
        className: "dsh-utils-files-body",
      },
      React.createElement(
        "div",
        {
          className: "dsh-utils-files-tree",
          // Dropping on the empty tree area moves the item to the workspace root.
          onDragOver: (event) => {
            if (dragSource.current === null || dragSource.current === "") return;
            event.preventDefault();
            try { event.dataTransfer.dropEffect = "move"; } catch (err) { /* ignore */ }
          },
          onDrop: (event) => {
            event.preventDefault();
            const from = dragSource.current;
            dragSource.current = null;
            setHoverDir(null);
            // No-op when the source is already at the workspace root.
            if (from === null || from === "" || parentOf(from) === "") return;
            doMove(from, "");
          },
          // Right-clicking the empty tree area offers the workspace root.
          onContextMenu: (event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, path: "", name: "", isDir: true });
          },
        },
        treeContent
      ),
      React.createElement(
        "div",
        { className: "dsh-utils-files-preview" },
        previewHeader,
        previewBody
      )
    ),
    menu !== null &&
      React.createElement(
        "div",
        {
          className: "dsh-utils-files-menu-mask",
          onMouseDown: () => setMenu(null),
          onContextMenu: (event) => {
            event.preventDefault();
            setMenu(null);
          },
        },
        React.createElement(
          "div",
          {
            className: "dsh-utils-files-menu",
            style: {
              left: Math.min(menu.x, Math.max(0, window.innerWidth - 170)) + "px",
              top: Math.min(menu.y, Math.max(0, window.innerHeight - 120)) + "px",
            },
            onMouseDown: (event) => event.stopPropagation(),
          },
          (menu.path === "" || menu.isDir) &&
            React.createElement(
              "button",
              { type: "button", className: "dsh-utils-files-menu-item", onClick: menuTerminal },
              React.createElement("span", null, menu.path === "" ? t("filesTerminalRoot") : t("filesTerminal"))
            ),
          menu.path !== "" &&
            React.createElement(
              "button",
              { type: "button", className: "dsh-utils-files-menu-item dsh-utils-files-menu-item-danger", onClick: menuDelete },
              React.createElement("span", null, t("filesDelete")),
              React.createElement("span", { className: "dsh-utils-files-menu-item-hint" }, fmt("filesRecycleHint", {}))
            )
        )
      )
  );
}

/** Mount the file panel as a right-side floating column of the frame grid. */
function mountFilesView(ctx, api) {
  const FRAME_SELECTOR = '[class*="_frame"]';
  const ACTIVE_ATTR = "data-dsh-utils-files-active";

  let root = null;
  let container = null;
  let savedTemplate = null;

  const ensure = () => {
    if (container !== null) return;
    const frame = document.querySelector(FRAME_SELECTOR);
    if (frame === null) return;
    container = document.createElement("div");
    container.dataset.dshUtilsFilesView = "";
    container.className = "dsh-utils-files-col";
    // Insert before the details column so the panel occupies the third grid
    // track (between the conversation and the details column).
    const details = frame.querySelector('[class*="_detailsCol"]');
    frame.insertBefore(container, details !== null ? details : null);
    root = createRoot(container);
    const t = (key) => {
      try {
        return ctx.locale.bind(NS)(key);
      } catch (err) {
        return key;
      }
    };
    root.render(React.createElement(FilesPanel, { api, t }));
  };

  const waitObserver = new MutationObserver(() => { ensure(); });
  waitObserver.observe(document.body, { childList: true, subtree: true });

  // Push the conversation column open: replace the center track with
  // `1fr 420px` while the panel is open, restore the saved template on close,
  // so the panel never covers anything (e.g. the Session log button).
  const applyActive = () => {
    const frame = container !== null ? container.parentElement : null;
    if (filesBus.open) {
      document.documentElement.setAttribute(ACTIVE_ATTR, "");
      if (frame !== null && savedTemplate === null) {
        const columns = getComputedStyle(frame).gridTemplateColumns.trim().split(/\s+/);
        savedTemplate = getComputedStyle(frame).gridTemplateColumns;
        const sidebar = columns.length > 0 ? columns[0] : "280px";
        const details = columns.length > 2 ? columns[columns.length - 1] : "0px";
        frame.style.gridTemplateColumns = `${sidebar} 1fr 420px ${details}`;
      }
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR);
      if (frame !== null && savedTemplate !== null) {
        frame.style.gridTemplateColumns = savedTemplate;
        savedTemplate = null;
      }
    }
  };
  const unsubscribe = filesBus.subscribe(applyActive);
  applyActive();
  ensure();

  return () => {
    unsubscribe();
    waitObserver.disconnect();
    document.documentElement.removeAttribute(ACTIVE_ATTR);
    const frame = container !== null ? container.parentElement : null;
    if (frame !== null && savedTemplate !== null) {
      frame.style.gridTemplateColumns = savedTemplate;
      savedTemplate = null;
    }
    root !== null && root.unmount();
    container !== null && container.remove();
    root = null;
    container = null;
  };
}

/** Required services: the gateway Remote face and locale. */
const inject = ["remote", "locale"];

/**
 * Compose the plugin.
 * @param ctx - client root context.
 */
function apply(ctx) {
  adoptStyles();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-utils: dictionaries");

  // The mounted namespace handles resolve through the service store
  // (`ctx.reflect.get`), not through dotted `ctx.remote.<ns>` reads: the
  // generated-style dotted read walks the cordis fiber chain, which stops at
  // the Loader's runtime-less internal forks between a plugin entry and the
  // root fiber — the namespace services mounted under the gateway entry are
  // unreachable that way (the store path resolves them by isolation label).
  //
  // Mounting is async; every call site awaits this promise so the first
  // panel open can never race the mount.
  const remotesPromise = (async () => {
    const dispose = await ctx.remote.$mount({
      package: "dsh-utils",
      descriptors: WORKSPACE_FILES_REMOTE.descriptors,
    });
    const filesRemote = ctx.reflect.get("remote.workspaceFiles");
    if (filesRemote === undefined) {
      throw new Error("dsh-utils: the workspaceFiles Remote namespace did not mount");
    }
    return { filesRemote, dispose };
  })();
  ctx.effect(() => () => {
    void remotesPromise.then(({ dispose }) => {
      void dispose();
    }, () => {});
  }, "dsh-utils: remote cleanup");

  const filesApi = {
    workspaces: async () => {
      try {
        const { filesRemote } = await remotesPromise;
        return filesRemote.workspaces();
      } catch (err) {
        return { ok: false, error: { code: "MOUNT_FAILED", message: String(err && err.message ? err.message : err) } };
      }
    },
    list: async (root, rel) => {
      try {
        const { filesRemote } = await remotesPromise;
        return filesRemote.list(root, rel);
      } catch (err) {
        return { ok: false, error: { code: "MOUNT_FAILED", message: String(err && err.message ? err.message : err) } };
      }
    },
    read: async (root, rel) => {
      try {
        const { filesRemote } = await remotesPromise;
        return filesRemote.read(root, rel);
      } catch (err) {
        return { ok: false, error: { code: "MOUNT_FAILED", message: String(err && err.message ? err.message : err) } };
      }
    },
    write: async (root, rel, content, baseMtime) => {
      try {
        const { filesRemote } = await remotesPromise;
        return filesRemote.write(root, rel, content, baseMtime);
      } catch (err) {
        return { ok: false, error: { code: "MOUNT_FAILED", message: String(err && err.message ? err.message : err) } };
      }
    },
    remove: async (root, rel) => {
      try {
        const { filesRemote } = await remotesPromise;
        return filesRemote.delete(root, rel);
      } catch (err) {
        return { ok: false, error: { code: "MOUNT_FAILED", message: String(err && err.message ? err.message : err) } };
      }
    },
    move: async (root, from, to) => {
      try {
        const { filesRemote } = await remotesPromise;
        return filesRemote.move(root, from, to);
      } catch (err) {
        return { ok: false, error: { code: "MOUNT_FAILED", message: String(err && err.message ? err.message : err) } };
      }
    },
    openTerminal: async (root, rel) => {
      try {
        const { filesRemote } = await remotesPromise;
        return filesRemote.openTerminal(root, rel);
      } catch (err) {
        return { ok: false, error: { code: "MOUNT_FAILED", message: String(err && err.message ? err.message : err) } };
      }
    },
    search: async (root, query) => {
      try {
        const { filesRemote } = await remotesPromise;
        return filesRemote.search(root, query);
      } catch (err) {
        return { ok: false, error: { code: "MOUNT_FAILED", message: String(err && err.message ? err.message : err) } };
      }
    },
  };

  // File manager: sidebar entry below New Session + right-side floating panel.
  const filesLabel = (() => {
    try {
      const locale = ctx.locale.getLocale();
      const id = typeof locale === "string" ? locale : locale && typeof locale.id === "string" ? locale.id : "";
      return id.startsWith("zh") ? zh.filesEntry : en.filesEntry;
    } catch (err) {
      return zh.filesEntry;
    }
  })();
  ctx.effect(() => mountSidebarEntry(filesLabel), "dsh-utils: files entry");
  ctx.effect(() => mountFilesView(ctx, filesApi), "dsh-utils: files view");
}

module.exports = { inject, apply };
