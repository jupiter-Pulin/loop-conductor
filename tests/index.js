// tests/index.js — 聚合入口。
// Node 24 起 `node --test <dir>` 不再展开目录；此文件让 `node --test tests/` 继续可用：
// 目录按 main 解析到本文件，动态 import 全部 *.test.mjs 完成注册。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.test.mjs')) yield p;
  }
}

for (const file of walk(here)) {
  await import(pathToFileURL(file).href);
}
