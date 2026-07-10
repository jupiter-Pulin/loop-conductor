// lib/test-gate.mjs — test gate（基线空转测试探针）的纯函数：测试文件 glob 匹配、
// name-status 变更分类与 AC→测试映射校验（单一裁判，探针与未来消费者共用）。零 IO；
// 副作用探针在 stages/shared.mjs::runTestGateProbe，verdict 判定（suite 模式 + per-AC
// 方向裁决）在 stages/decisions.mjs（设计见 docs/features/test-gate/tech-spec.md）。

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

/**
 * H16 测试改动守卫：从 name-status 挑出「既有测试文件」被动过的痕迹——
 * M/T → modified、D → deleted、R → renamed（旧或新路径任一命中测试 glob 都算：
 * 改名进/出测试目录同样可疑）。A/C（新增/拷贝出新路径）不入清单：新增测试是期望行为，
 * 守卫只审计对既有测试的动作。非测试文件一律忽略。观测型口径，消费方绝不据此 block。
 */
export function listExistingTestFileChanges(nameStatus, globs) {
  const modified = [];
  const deleted = [];
  const renamed = [];
  for (const line of String(nameStatus ?? '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    if (status.startsWith('C')) continue; // copy：旧路径原样保留，既有侧无损
    if (status.startsWith('R')) {
      const [, oldPath, newPath] = parts;
      if ((oldPath && matchesTestGlobs(oldPath, globs)) || (newPath && matchesTestGlobs(newPath, globs))) {
        renamed.push({ from: oldPath, to: newPath });
      }
      continue;
    }
    const p = parts[1];
    if (!p || !matchesTestGlobs(p, globs)) continue;
    if (status.startsWith('D')) deleted.push(p);
    else if (status.startsWith('M') || status.startsWith('T')) modified.push(p);
    // A：新增测试不入守卫清单
  }
  return { modified, deleted, renamed };
}

// ---- 约定 2（B 批）：maker 交付的 AC→测试映射（per-AC 定向探针的输入） ----

/** 映射文件在任务 worktree 内的相对路径（约定即常量，不新增配置项；harness exclude 已覆盖）。 */
export const AC_TESTS_MAPPING_PATH = '.will-workflow/ac-tests.json';

/** 方向枚举：fail_on_baseline = 新行为测试基线必须红；pass_on_baseline = 回归守卫基线必须绿。 */
export const AC_TEST_EXPECTS = ['fail_on_baseline', 'pass_on_baseline'];

/**
 * 映射校验的唯一裁判（绝不抛错）。expectedAcIds = conductor 对冻结 spec 的 AC 枚举集
 * （与 verifier 校验同源，extractAcceptanceCriteria）。
 * 返回 { ok, errors, entries }：非法时 entries 恒为 []（整份映射判 invalid，降级 suite 模式）。
 * 非法条件：非对象 / schema_version≠1 / entries 非数组 / ac_id·command 非非空字符串 /
 * expect 不在枚举 / ac_id 重复 / ac_id 不在枚举集内。
 */
export function validateAcTestsMapping(raw, expectedAcIds) {
  const errors = [];
  const expected = new Set(expectedAcIds ?? []);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['映射不是对象'], entries: [] };
  }
  if (raw.schema_version !== 1) errors.push('schema_version 必须为 1');
  if (!Array.isArray(raw.entries)) {
    errors.push('entries 必须是数组');
    return { ok: false, errors, entries: [] };
  }
  const seen = new Set();
  raw.entries.forEach((e, i) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) { errors.push(`entries[${i}] 不是对象`); return; }
    if (typeof e.ac_id !== 'string' || e.ac_id.trim() === '') {
      errors.push(`entries[${i}].ac_id 必须是非空字符串`);
    } else {
      if (seen.has(e.ac_id)) errors.push(`ac_id 重复：${e.ac_id}`);
      seen.add(e.ac_id);
      if (!expected.has(e.ac_id)) errors.push(`ac_id 不在冻结 spec 的 AC 枚举集内：${e.ac_id}`);
    }
    if (typeof e.command !== 'string' || e.command.trim() === '') {
      errors.push(`entries[${i}].command 必须是非空字符串`);
    }
    if (!AC_TEST_EXPECTS.includes(e.expect)) {
      errors.push(`entries[${i}].expect 必须 ∈ {${AC_TEST_EXPECTS.join(', ')}}`);
    }
  });
  if (errors.length > 0) return { ok: false, errors, entries: [] };
  return {
    ok: true,
    errors: [],
    entries: raw.entries.map((e) => ({ ac_id: e.ac_id, command: e.command, expect: e.expect })),
  };
}
