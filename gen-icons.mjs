/**
 * Generate the file-icon dataset embedded into lib/client.js from the
 * material-icon-theme npm package (MIT, PKief/vscode-material-icon-theme).
 *
 * Output shape (deduplicated SVG strings referenced by index):
 *   const FILE_ICONS = {
 *     svgs: [...],
 *     default: 0, folder: 1, folderOpen: 2,
 *     byExt: { "js": 3, ... },
 *     byName: { "dockerfile": 4, ... },
 *   };
 *
 * Usage: node gen-icons.mjs <material-icons.json> <icons-dir> <client-js>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , manifestPath, iconsDir, clientPath] = process.argv;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const readSvg = (iconName) => {
  try {
    const raw = readFileSync(`${iconsDir}/${iconName}.svg`, "utf8").trim();
    // strip the XML declaration if any
    return raw.startsWith("<?xml") ? raw.slice(raw.indexOf(">") + 1).trim() : raw;
  } catch {
    return null;
  }
};

// The curated extension set (developer-oriented; add freely).
const WANTED_EXTS = [
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx",
  "json", "jsonc", "json5", "jsonl", "html", "htm", "xhtml", "css", "scss", "sass", "less",
  "md", "markdown", "mdx", "txt", "py", "pyc", "pyw", "ipynb", "go", "rs",
  "java", "class", "jar", "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "vb", "fs", "fsi",
  "kt", "kts", "swift", "rb", "php", "pl", "pm", "sh", "bash", "zsh", "fish", "bat", "cmd",
  "ps1", "psd1", "psm1", "lua", "r", "scala", "clj", "cljs", "edn", "ex", "exs", "erl", "hrl",
  "vue", "svelte", "astro", "graphql", "gql", "prisma", "yml", "yaml", "toml", "ini", "cfg", "conf",
  "env", "sqlite", "db", "sql", "lock", "xml", "plist", "svg", "png", "jpg", "jpeg", "gif", "webp",
  "ico", "bmp", "tif", "tiff", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "tsv",
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "ttf", "otf", "woff", "woff2", "eot",
  "mp3", "wav", "ogg", "flac", "m4a", "mp4", "mkv", "avi", "mov", "webm", "wasm",
  "exe", "msi", "dll", "so", "a", "o", "obj", "map", "log", "diff", "patch", "pot", "po",
  "test", "spec",
];

const WANTED_NAMES = [
  "dockerfile", ".dockerignore", "makefile", "cmakelists.txt",
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
  ".gitignore", ".gitattributes", ".editorconfig", ".env", ".npmrc", ".nvmrc",
  ".babelrc", ".babelrc.json", ".eslintrc", ".eslintrc.json", ".prettierrc", ".prettierrc.json",
  "tsconfig.json", "vite.config.ts", "vite.config.js", "webpack.config.js",
  "readme.md", "license", "changelog.md",
];

const byExt = {};
for (const ext of WANTED_EXTS) {
  const icon = manifest.fileExtensions[ext];
  if (icon === undefined) continue;
  const svg = readSvg(icon);
  if (svg !== null) byExt[ext] = svg;
}

const byName = {};
for (const name of WANTED_NAMES) {
  const icon = manifest.fileNames[name];
  if (icon === undefined) continue;
  const svg = readSvg(icon);
  if (svg !== null) byName[name] = svg;
}

// Deduplicate SVG strings into a shared table.
const svgs = [];
const indexOf = (svg) => {
  const found = svgs.indexOf(svg);
  if (found !== -1) return found;
  svgs.push(svg);
  return svgs.length - 1;
};

const byExtIdx = {};
for (const [key, svg] of Object.entries(byExt)) byExtIdx[key] = indexOf(svg);
const byNameIdx = {};
for (const [key, svg] of Object.entries(byName)) byNameIdx[key] = indexOf(svg);

const defaultSvg = readSvg(manifest.file);
const folderSvg = readSvg(manifest.folder);
const folderOpenSvg = readSvg(manifest.folderExpanded);
if (defaultSvg === null || folderSvg === null || folderOpenSvg === null) {
  throw new Error("missing default/folder icons in the theme package");
}

const payload = JSON.stringify({ svgs, default: indexOf(defaultSvg), folder: indexOf(folderSvg), folderOpen: indexOf(folderOpenSvg), byExt: byExtIdx, byName: byNameIdx });
const totalSvgBytes = svgs.reduce((sum, s) => sum + s.length, 0);
console.log(`unique svgs: ${svgs.length} (${totalSvgBytes} chars), ext mappings: ${Object.keys(byExtIdx).length}, name mappings: ${Object.keys(byNameIdx).length}, payload bytes: ${payload.length}`);

const client = readFileSync(clientPath, "utf8");
const marker = "//__FILE_ICONS_GENERATED__";
if (!client.includes(marker)) throw new Error(`marker ${marker} not found in ${clientPath}`);
const generated = `// File-type icons embedded from material-icon-theme (MIT, PKief/vscode-material-icon-theme).\n// Regenerate with: node gen-icons.mjs <material-icons.json> <icons-dir> <client-js>\nconst FILE_ICONS = ${payload};`;
writeFileSync(clientPath, client.replace(marker, generated));
console.log(`injected into ${clientPath}`);
