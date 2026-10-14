import { build } from 'esbuild';
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/main.js',
  external: ['better-sqlite3', '@napi-rs/canvas', 'pdfjs-dist', 'exceljs'],
  banner: {
    js: [
      'import { createRequire as __flow_createRequire } from "node:module";',
      'const require = __flow_createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'warning',
});
console.log('server bundled → dist/main.js');
