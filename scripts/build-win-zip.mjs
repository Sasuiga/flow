/**
 * flow Windows 绿色包（zip）组装脚本
 *
 * 产物：flow-win-x64-<version>.zip
 *   ├─ node/                    便携 Node（win-x64，免安装）
 *   ├─ package.json             { "type": "module" }，让 main.js 以 ESM 启动
 *   ├─ node_modules/            运行时外部依赖（better-sqlite3 + bindings、pdfjs-dist、exceljs
 *   │                            及其传递依赖；better-sqlite3 换 win-x64 预编译）
 *   ├─ main.js                  服务端 bundle（esbuild）
 *   ├─ web/                     前端静态（vite）
 *   ├─ data/                    数据目录（首启自动建 SQLite；备份=复制此目录）
 *   ├─ start.bat                双击启动（可设 FLOW_DOC_ROOT 改目录选择器根）
 *   └─ README-快速上手.txt
 *
 * 用法：node scripts/build-win-zip.mjs [版本号] [缓存目录]
 *   - 缓存目录默认 /tmp/flowpkg（便携 Node zip 与 better-sqlite3 win 预编译缓存于此，
 *     缺失时自动下载）；2026-10 M1 spike 已在 Windows 实测该组合可用。
 *   - 发布：git tag + GitHub release 附 zip 资产。
 */
import { execSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const VERSION = process.argv[2] ?? '0.1.2';
const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.resolve(process.argv[3] ?? path.join(tmpdir(), 'flowpkg'));
mkdirSync(CACHE_DIR, { recursive: true });

// 便携 Node 版本（win-x64 官方 zip；M1 实测 v22.23.3 与 better-sqlite3 v12.11.1 预编译兼容）
const NODE_VERSION = 'v22.23.3';
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/node-win-x64.zip`;
const BSQ_VERSION = lockedVersion('better-sqlite3'); // 与 pnpm-lock 一致，才能对上预编译 .node
const BSQ_URL = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${BSQ_VERSION}/prebuilds/better-sqlite3-v${BSQ_VERSION}-node-v127-win32-x64.tar.gz`;

function sh(cmd, cwd = ROOT) {
  console.log('$', cmd);
  execSync(cmd, { stdio: 'inherit', cwd });
}

/** pnpm-lock.yaml 里某个包的精确版本（打包必须钉死，才能对上预编译二进制） */
function lockedVersion(name) {
  const lock = readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const m = lock.match(new RegExp(`^  ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@(\\d+\\.\\d+\\.\\d+):`, 'm'));
  if (!m) throw new Error(`pnpm-lock.yaml 里找不到 ${name} 的版本`);
  return m[1];
}

function cachedOrDownload(name, url, file) {
  if (existsSync(file)) {
    console.log(`use cache: ${name}`);
    return file;
  }
  console.log(`download ${name} → ${file}`);
  execSync(`curl -fL --retry 2 -o "${file}" "${url}"`, { stdio: 'inherit' });
  return file;
}

/* ---------- 1. 构建 ---------- */
sh('node build.mjs', path.join(ROOT, 'apps/server')); // 服务端 bundle → apps/server/dist/main.js
sh('pnpm --filter flow-web build'); // 前端 → apps/web/dist

/* ---------- 2. 组装 ---------- */
const nodeArtifact = cachedOrDownload('portable node', NODE_URL, path.join(CACHE_DIR, 'node-win-x64.zip'));
const bsqArtifact = cachedOrDownload('better-sqlite3 win prebuild', BSQ_URL, path.join(CACHE_DIR, 'bsq-win.tgz'));

const stage = path.join(CACHE_DIR, `build-${VERSION}`);
const appDir = path.join(stage, `flow-win-x64-${VERSION}`);
rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

console.log('assemble: portable node → node/');
const nodeTmp = path.join(stage, 'node-extract');
rmSync(nodeTmp, { recursive: true, force: true });
execSync(
  `python3 -c 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "${nodeArtifact}" "${nodeTmp}"`,
  { stdio: 'inherit' },
);
execSync(`mv "${nodeTmp}/node-${NODE_VERSION}-win-x64" "${appDir}/node" && rm -rf "${nodeTmp}"`, {
  stdio: 'inherit',
});

console.log('assemble: node_modules（npm 装齐传递依赖；pnpm 隔离目录拷贝会丢掉 bindings）');
// esbuild 已把 express/chokidar 打进 main.js。运行时还要这些 external 包及其传递依赖
// （better-sqlite3 → bindings → file-uri-to-path）。直接 cp pnpm 的 apps/server/node_modules
// 只会拿到顶层符号链接，bindings 在 .pnpm 虚拟仓库的兄弟目录里，绿色包启动即 MODULE_NOT_FOUND。
const runtimePkg = {
  name: 'flow-win',
  private: true,
  type: 'module',
  dependencies: {
    'better-sqlite3': BSQ_VERSION,
    'pdfjs-dist': lockedVersion('pdfjs-dist'),
    exceljs: lockedVersion('exceljs'),
  },
};
writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(runtimePkg, null, 2)}\n`);
execSync('npm install --omit=dev --ignore-scripts --no-audit --no-fund', { stdio: 'inherit', cwd: appDir });
const bsqDir = path.join(appDir, 'node_modules', 'better-sqlite3');
// --ignore-scripts 不会编译原生模块；预编译归档内是 build/Release/better_sqlite3.node
execSync(`tar -xzf "${bsqArtifact}" -C "${bsqDir}"`, { stdio: 'inherit' });
const nodeBin = path.join(bsqDir, 'build', 'Release', 'better_sqlite3.node');
if (!existsSync(nodeBin)) throw new Error(`Windows 预编译不存在：${nodeBin}`);
if (!existsSync(path.join(appDir, 'node_modules', 'bindings', 'package.json'))) {
  throw new Error('bindings 未装进 node_modules，better-sqlite3 无法加载原生模块');
}

console.log('assemble: main.js + web/ + release/ + data/');
copyFileSync(path.join(ROOT, 'apps/server/dist/main.js'), path.join(appDir, 'main.js'));
cpSync(path.join(ROOT, 'apps/web/dist'), path.join(appDir, 'web'), { recursive: true });
// 仓库里 start.bat 可能是 LF；cmd 双击要 CRLF，否则有的机器上命令会被吃掉
const bat = readFileSync(path.join(ROOT, 'release/start.bat'), 'utf8').replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n');
writeFileSync(path.join(appDir, 'start.bat'), bat.endsWith('\r\n') ? bat : `${bat}\r\n`);
copyFileSync(path.join(ROOT, 'release/README-快速上手.txt'), path.join(appDir, 'README-快速上手.txt'));
const dataDir = path.join(appDir, 'data');
mkdirSync(dataDir, { recursive: true });
writeFileSync(path.join(dataDir, '.keep'), ''); // 空目录 zip 不保留；首启 db.ts 自动建 SQLite

/* ---------- 3. 打 zip ---------- */
const out = path.join(CACHE_DIR, `flow-win-x64-${VERSION}.zip`);
const py = `import zipfile, os, sys
root, out = sys.argv[1], sys.argv[2]
base = os.path.dirname(root)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dp, _, fns in os.walk(root):
        for f in fns:
            p = os.path.join(dp, f)
            z.write(p, os.path.relpath(p, base))
print("zipped ->", out, round(os.path.getsize(out) / 1048576, 1), "MB")
`;
execSync(`python3 -c '${py}' '${appDir}' '${out}'`, { stdio: 'inherit' });

console.log(`\n✅ ${out} 就绪。发布：git tag v${VERSION} → GitHub release 附此 zip。`);
