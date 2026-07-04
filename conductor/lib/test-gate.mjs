// lib/test-gate.mjs — test gate（基线空转测试探针）的纯函数：测试文件 glob 匹配与
// name-status 变更分类。零 IO；副作用探针在 stages/shared.mjs::runTestGateProbe，
// verdict 判定在 stages/decisions.mjs::testGateVerdict（设计见 docs/features/test-gate/tech-spec.md）。

/** 默认测试文件 glob（config.testGateTestGlobs 可覆盖）。 */
export const DEFAULT_TEST_GLOBS = ['test/**', 'tests/**', '**/*.test.*', '**/*.spec.*'];

/** 极简 glob → RegExp：`**` 跨目录（目录前缀可为空）；`*` 与 `?` 不跨路径分隔符；其余字面量。 */
function globToRegExp(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') { re += '[^/]'; i += 1; continue; }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/** filePath（仓库根相对、/ 分隔）是否命中任一测试 glob。 */
export function matchesTestGlobs(filePath, globs) {
  return (globs ?? []).some((g) => globToRegExp(g).test(filePath));
}

/**
 * 解析 `git diff --name-status base...HEAD` 输出，挑出测试文件变更：
 * A/M/T → copy（从任务 worktree 复制进基线探针 worktree）；D → remove；
 * R<n>（两个路径）→ 旧路径 remove、新路径 copy；C<n> → 仅新路径 copy。
 * 非测试文件一律忽略（探针保持基线代码不动）。
 */
export function classifyTestFileChanges(nameStatus, globs) {
  const copy = [];
  const remove = [];
  for (const line of String(nameStatus ?? '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    if (status.startsWith('R') || status.startsWith('C')) {
      const [, oldPath, newPath] = parts;
      if (status.startsWith('R') && oldPath && matchesTestGlobs(oldPath, globs)) remove.push(oldPath);
      if (newPath && matchesTestGlobs(newPath, globs)) copy.push(newPath);
      continue;
    }
    const p = parts[1];
    if (!p || !matchesTestGlobs(p, globs)) continue;
    if (status.startsWith('D')) remove.push(p);
    else copy.push(p); // A / M / T
  }
  return { copy, remove };
}
