/**
 * flow Windows 绿色包（zip）组装脚本
 *
 * 产物：flow-win-x64-<version>.zip
 *   ├─ node/                    便携 Node（win-x64，免安装）
 *   ├─ node_modules/            服务端运行依赖（含 better-sqlite3 win-x64 预编译）
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
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const VERSION = process.argv[2] ?? '0.1.2';
const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.resolve(process.argv[3] ?? path.join(tmpdir(), 'flowpkg'));
mkdirSync(CACHE_DIR, { recursive: true });

// 便携 Node 版本（win-x64 官方 zip；M1 实测 v22.23.3 与 better-sqlite3 v12.11.1 预编译兼容）
const NODE_VERSION = 'v22.23.3';
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/node-win-x64.zip`;
const BSQ_VERSION = '12.11.1'; // 与 apps/server/package.json better-sqlite3 保持一致
const BSQ_URL = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${BSQ_VERSION}/prebuilds/better-sqlite3-v${BSQ_VERSION}-node-v127-win32-x64.tar.gz`;

function sh(cmd, cwd = ROOT) {
  console.log('$', cmd);
  execSync(cmd, { stdio: 'inherit', cwd });
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

console.log('assemble: node_modules（用 win 预编译覆盖 dev 环境的 better-sqlite3 二进制）');
// pnpm 布局：服务端依赖在 apps/server/node_modules（符号链接树，-rL 展开为实体文件）
execSync(
  `rm -rf "${path.join(appDir, 'node_modules')}" && cp -rL "${path.join(ROOT, 'apps/server/node_modules')}" "${path.join(appDir, 'node_modules')}"`,
  { stdio: 'inherit' },
);
const bsqDir = path.join(appDir, 'node_modules', 'better-sqlite3');
// prebuilds 归档内仅 build/Release/better_sqlite3.node（直接覆盖 dev 环境的 Linux 二进制）
execSync(`tar -xzf "${bsqArtifact}" -C "${bsqDir}"`, { stdio: 'ignore' });

console.log('assemble: main.js + web/ + release/ + data/');
copyFileSync(path.join(ROOT, 'apps/server/dist/main.js'), path.join(appDir, 'main.js'));
cpSync(path.join(ROOT, 'apps/web/dist'), path.join(appDir, 'web'), { recursive: true });
copyFileSync(path.join(ROOT, 'release/start.bat'), path.join(appDir, 'start.bat'));
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
