// 定位「DSH 安装目录下的 node_modules」—— 供仓库脚本加载 DSH 自身的模块做校验。
//
// 解析顺序：
//   1. 环境变量 DSH_INSTALL_MODULES / DSH_MODULES（应指向 <DSH>/node_modules）
//   2. 从 $DSH_HOME/profiles/<profile>/package.json 用 Node 模块解析反查真实安装位置
//      （profile 依次尝试 DSH_PROFILE、web、default，再兜底扫 profiles 下的其它目录）
//   3. 桌面版兜底：DSH 桌面版（0.2.x）把依赖打进了 app.asar，磁盘上根本没有
//      <DSH>/node_modules 这个目录 —— profile 里只剩 cosmokit / dsh-home-paths /
//      schemastery 三个辅助包，探针 specifier 全都解析不到。这时从 app.asar 按需
//      把要用的包抽到临时目录，再把那个目录当作 node_modules 返回。
// 全部失败时抛出带指引的错误，不做任何写死路径的回退 —— 宁可显式报错，也不要静默用错版本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 这些脚本需要加载的包，任意一个能解析成功即可反推出 node_modules 位置。
const PROBE_SPECIFIERS = ['@deepseek-ai/dsh-persona', 'js-yaml'];

function findNodeModules(resolvedFile) {
  let dir = path.dirname(resolvedFile);
  for (;;) {
    if (path.basename(dir) === 'node_modules') return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function candidateProfiles(home) {
  const names = [];
  const add = (n) => { if (!n || names.includes(n)) return; names.push(n); };
  add('desktop');   // 桌面版优先：命令行版没有 desktop profile，加了也无害
  add(process.env.DSH_PROFILE);
  add('web');
  add('default');
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) add(e.name);
    }
  } catch { /* profiles 目录不存在时忽略 */ }
  return names;
}

// ── 桌面版 app.asar 支持 ────────────────────────────────────────────────────
// asar 格式：头 16 字节，offset 12 是 uint32LE = JSON header 长度；JSON 从 offset 16 起；
// 文件内容基准 = 16 + ceil(jsonLen/4)*4。节点递归 { files: {...} }，叶子 { size, offset }。
const ASAR_CANDIDATES = [
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  path.join('/Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar'),
];

function findAsar() {
  if (process.env.DSH_APP_ASAR) return fs.existsSync(process.env.DSH_APP_ASAR) ? process.env.DSH_APP_ASAR : null;
  for (const p of ASAR_CANDIDATES) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 换下一个 */ }
  }
  return null;
}

function openAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  return { fd, tree: JSON.parse(jsonBuf.toString('utf8')), base: 16 + Math.ceil(jsonLen / 4) * 4 };
}

// 在 asar 树里按 'node_modules/@deepseek-ai/dsh-persona' 这样的相对路径找节点。
function asarLookup(tree, relParts) {
  let node = tree;
  for (const part of relParts) {
    if (!node?.files?.[part]) return null;
    node = node.files[part];
  }
  return node;
}

// 把一个包（或单文件）从 asar 抽到 <outDir>/<relParts.join('/')> 下，返回抽出的文件数。
function asarExtract({ fd, base }, node, destDir, relParts) {
  let count = 0;
  const outRoot = path.join(destDir, ...relParts);
  const writeOne = (n, dest) => {
    const size = Number(n.size ?? 0);
    if (!size) return;
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, base + Number(n.offset));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    count++;
  };
  const walkNode = (n, dest) => {
    if (n.link) return;                    // 软链一律跳过
    if (n.files) {
      for (const [name, child] of Object.entries(n.files)) walkNode(child, path.join(dest, name));
      return;
    }
    if (n.unpacked) return;                // 已解包到 app.asar.unpacked，不用再抽
    writeOne(n, dest);
  };
  walkNode(node, outRoot);
  return count;
}

// 把一个包从 asar 抽到 nmDir 下，返回抽出的文件数。
function asarExtractPackage(handle, nmDir, spec) {
  const parts = spec.split('/');
  const node = asarLookup(handle.tree, ['dsh', 'node_modules', ...parts]);
  if (!node) return 0;
  return asarExtract(handle, node, nmDir, parts);
}

// 读 asar 内某个包的 package.json，拿到它需要一起装进来的依赖名。
// 必须连 peerDependencies 一起走：dsh-persona 的 dependencies 只有 schemastery，
// 真正 import 的 @deepseek-ai/dsh-system-prompt 与 @deepseek-ai/cordis 写在
// peerDependencies 里，漏了它们照样 ERR_MODULE_NOT_FOUND。
function asarPackageDeps(handle, spec) {
  const { fd, base, tree } = handle;
  const node = asarLookup(tree, ['dsh', 'node_modules', ...spec.split('/'), 'package.json']);
  if (!node || node.files || !node.size) return [];
  try {
    const buf = Buffer.alloc(Number(node.size));
    fs.readSync(fd, buf, 0, Number(node.size), base + Number(node.offset));
    const pkg = JSON.parse(buf.toString('utf8'));
    return [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ];
  } catch { return []; }
}

// 递归补包：入口包 + 它依赖链上的每一个包，都从 asar 抽到同一个 node_modules。
// 只抽入口包是不够的 —— dsh-persona 依赖 @deepseek-ai/schemastery 与
// @standard-schema/spec，抽完立刻 ERR_MODULE_NOT_FOUND，得沿着 dependencies 走一遍。
function extractClosure(handle, nmDir, entrySpec) {
  const queue = [entrySpec];
  const seen = new Set();
  while (queue.length) {
    const spec = queue.shift();
    if (seen.has(spec)) continue;
    seen.add(spec);
    if (asarExtractPackage(handle, nmDir, spec) === 0) continue;
    for (const dep of asarPackageDeps(handle, spec)) queue.push(dep);
  }
  return seen;
}

// 桌面版兜底：把 PROBE_SPECIFIERS 涉及包的完整依赖闭包抽到缓存目录，返回那个 node_modules。
// 缓存目录按 asar 的 mtime+size 命名，asar 升级后自动重新抽。
function modulesFromAsar() {
  const asarPath = findAsar();
  if (!asarPath) return null;
  const st = fs.statSync(asarPath);
  const tag = `${Math.round(st.mtimeMs)}-${st.size}`.replace(/[^\d-]/g, '');
  const cacheRoot = path.join(os.tmpdir(), 'dsh-asar-modules', tag);
  const nm = path.join(cacheRoot, 'node_modules');
  // 抽成功才写 .done 标记：中途崩掉的半成品目录不能被下次当成完整缓存。
  const done = path.join(cacheRoot, '.done');
  if (fs.existsSync(done)) return nm;

  let handle;
  try { handle = openAsar(asarPath); } catch { return null; }
  try {
    for (const spec of PROBE_SPECIFIERS) extractClosure(handle, nm, spec);
    // verify-persona-config.mjs 按 `<modules>/js-yaml/index.js` 硬拼路径，所以 js-yaml
    // 必须落在和 @deepseek-ai 同一层 —— extractClosure 按 spec 原样摊平，正好满足。
  } finally {
    try { fs.closeSync(handle.fd); } catch { /* 忽略 */ }
  }
  if (!fs.existsSync(nm)) return null;
  try { fs.writeFileSync(done, new Date().toISOString()); } catch { /* 忽略 */ }
  return nm;
}

// 需要的包是否都在这一个 node_modules 下（都齐了才算可用）。
// 桌面版的 profile/node_modules 里只有 js-yaml、没有 @deepseek-ai/dsh-persona，
// 只看「任意一个能解析到」会返回一个缺包的目录，调用方随后就 ERR_MODULE_NOT_FOUND。
function hasAllProbePackages(dir) {
  return PROBE_SPECIFIERS.every((spec) => {
    const parts = spec.split('/');
    const pkgFile = spec.startsWith('@')
      ? path.join(dir, parts[0], parts[1], 'package.json')
      : path.join(dir, parts[0], 'package.json');
    // 有些包 package.json 不在导出面里，但目录存在就够 module 解析用了
    return fs.existsSync(pkgFile) || fs.existsSync(path.dirname(pkgFile));
  });
}

export function dshModulesDir() {
  const override = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (override) return override;

  const home = dshHome();
  for (const profile of candidateProfiles(home)) {
    const anchor = path.join(home, 'profiles', profile, 'package.json');
    if (!fs.existsSync(anchor)) continue;
    const req = createRequire(anchor);
    for (const spec of PROBE_SPECIFIERS) {
      try {
        const dir = findNodeModules(req.resolve(spec));
        if (dir && hasAllProbePackages(dir)) return dir;
      } catch { /* 换下一个 specifier，再换下一个 profile */ }
    }
  }

  // 桌面版兜底（见文件头第 3 条）。抽成功后把路径记进环境变量，
  // 后续同一进程里的其它脚本再问一次就不用重复解 asar 了。
  const fromAsar = modulesFromAsar();
  if (fromAsar) {
    process.env.DSH_INSTALL_MODULES = process.env.DSH_INSTALL_MODULES || fromAsar;
    return fromAsar;
  }

  throw new Error(
    '无法定位 DSH 安装目录下的 node_modules。\n'
    + '  请设置 DSH_INSTALL_MODULES=<DSH 安装目录>/node_modules 后重试；\n'
    + `  或设置 DSH_HOME 指向 DSH 根目录（当前解析为 ${home}）。`
  );
}

// ── 供工具名扫描器直读 asar ────────────────────────────────────────────────
// 桌面版把 308 个 @deepseek-ai 包打进 app.asar，profile 里只有 3 个辅助包。
// `scripts/dsh-tool-names.mjs` 要扫「装了什么工具」，靠 dshModulesDir() 拿到的
// 目录是不够的（那只是抽出来给 verify 用的几个包）。所以这里再给一个**只读遍历**
// 接口：不落盘、不解包，直接把 asar 内 dsh/node_modules 下的源码读成字符串回调出去。
//
// 返回 null 表示「本机没有 asar」（命令行版），调用方应当走原来的磁盘扫描路径。
export function walkAsarPackages(onFile) {
  const asarPath = findAsar();
  if (!asarPath) return null;
  let handle;
  try { handle = openAsar(asarPath); } catch { return null; }
  const { fd, base, tree } = handle;
  const packages = new Set();
  let scanned = 0;
  const readNode = (n) => {
    const size = Number(n?.size ?? 0);
    if (!size) return null;
    try {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, base + Number(n.offset));
      return buf.toString('utf8');
    } catch { return null; }
  };
  const walk = (node, pkgName, relPath) => {
    if (node.link || node.unpacked) return;
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) {
        walk(child, pkgName, relPath ? `${relPath}/${name}` : name);
      }
      return;
    }
    if (!pkgName) return;
    // 只喂可能承载工具名的文件类型；图片/二进制一律跳过。
    if (!/\.(js|mjs|cjs|ts|ya?ml)$/.test(relPath)) return;
    const size = Number(node.size ?? 0);
    if (!size || size > 4 * 1024 * 1024) return;
    const text = readNode(node);
    if (!text || text.includes('\u0000')) return;   // 二进制
    scanned += 1;
    onFile({ package: pkgName, path: relPath, text });
  };
  try {
    const roots = ['@deepseek-ai', null];   // 先扫 scope 包，再扫顶层包
    for (const scope of roots) {
      const baseNode = scope
        ? asarLookup(tree, ['dsh', 'node_modules', scope])
        : asarLookup(tree, ['dsh', 'node_modules']);
      if (!baseNode?.files) continue;
      for (const [name, child] of Object.entries(baseNode.files)) {
        if (scope) {
          if (!child.files || !/^dsh-/.test(name)) continue;
          packages.add(name);
          walk(child, name, '');
        } else if (!name.startsWith('@') && child.files) {
          // 顶层包（js-yaml 之类）也可能注册工具；不加 dsh- 限制但跳过 scope 目录
          walk(child, name, '');
        }
      }
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
  }
  return { packages: [...packages], scanned };
}
