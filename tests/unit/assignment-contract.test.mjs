// 单元：委派（assignment）契约。router 用 dispatch 一次派出 1..N 个 worker，
// 每个 assignment 的文字被内核**逐字**注入接收者的 prompt，key 则进文件名（worker-<key>-r<n>.json）
// 与分支名（task/<id>--<key>）。内核不理解这些文字，只认这里的格式与几条机械规则——
// 规则松一格，轻则 worker 拿到一份说不清边界的活，重则两个并行 write 改到同一处文件、
// 或产物落到解析不出来的路径上。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAssignments, isValidKey, literalPrefixSegments, writePathConflicts, filesOutsideDeclared,
  PROFILES, INTENTS, MAX_ASSIGNMENTS_PER_DISPATCH, KEY_MAX, KEY_RE,
} from '../../conductor/lib/assignment-contract.mjs';

/** 一份最小合法委派：五件事（目的 / 输入 / 范围 / 产物 / 完成条件）一件都不能少。 */
const base = (over = {}) => ({
  key: 'auth-probe',
  profile: 'read',
  intent: 'investigate',
  title: '查清登录态在哪一层丢失',
  purpose: '定位 401 只在特定分支复现的原因',
  inputs: ['maker-r3.report.md 第 2 节', 'AC-004'],
  scope: '只读 src/auth 与相关测试，不改代码',
  deliverables: '一份 report.md 指出失效点与证据',
  done_when: '给出具体文件与行号，或明确说明证据不足',
  ...over,
});

const errsOf = (over) => validateAssignments([base(over)]).join();

test('常量面——profile / intent 闭集、单次上限、key 长度与正则', () => {
  // profile 决定真实权限（read 无 Bash / sandbox 产物不并入产品 / write 改产品代码）：
  // 多一档或改名，lib/agent-settings.mjs 分配工具集时就会落到未知分支。
  assert.deepEqual([...PROFILES], ['read', 'sandbox', 'write']);
  assert.deepEqual([...INTENTS], ['investigate', 'experiment', 'design', 'implement', 'diagnose', 'fix', 'check']);
  assert.equal(MAX_ASSIGNMENTS_PER_DISPATCH, 8);
  assert.equal(KEY_MAX, 24);
  assert.equal(KEY_RE.test('auth-probe'), true);
  assert.equal(KEY_RE.test('Auth'), false);
});

test('validateAssignments：三档 profile 的 happy path 各自返回空错误数组', () => {
  assert.deepEqual(validateAssignments([base()]), []);
  assert.deepEqual(validateAssignments([base({ key: 'dep-bump', profile: 'sandbox', intent: 'experiment' })]), []);
  assert.deepEqual(validateAssignments([
    base({ key: 'auth-fix', profile: 'write', intent: 'fix', paths: ['src/auth/**'] }),
  ]), []);
  // 可选字段（paths / acs / continue_from）缺席是常态，不是错误。
  assert.deepEqual(validateAssignments([base({ acs: ['AC-004'], continue_from: 2 })]), []);
});

test('validateAssignments：空 / 非数组输入 → 只报「必须带非空的 assignments 数组」并立即返回', () => {
  // dispatch 没有委派就是一次空派工：内核会准备工作目录、写台账、却没有任何人可派。
  for (const bad of [[], undefined, null, 'x', 42, {}]) {
    assert.deepEqual(
      validateAssignments(bad),
      ['dispatch 必须带非空的 assignments 数组'],
      `${JSON.stringify(bad)} 应只报这一条`,
    );
  }
});

test('validateAssignments：非对象元素只报一条形态错误，不再逐字段追打', () => {
  for (const bad of [null, 42, 'auth', ['auth'], undefined]) {
    const errors = validateAssignments([bad]);
    assert.deepEqual(errors, ['assignments[0] 必须是对象']);
  }
  // 位置下标必须指到具体那一条：一次派 8 个时，router 得知道改的是哪一份。
  assert.deepEqual(validateAssignments([base(), 42]), ['assignments[1] 必须是对象']);
});

test('validateAssignments：未知字段拒收（委派字段是闭集，拼错等于没写）', () => {
  // 多写的字段内核不会读：如果不报错，router 会以为自己声明了限制，实际什么约束都没生效。
  const errors = validateAssignments([base({ notes: '顺便看看别的', pahts: ['src/**'] })]);
  assert.match(errors.join(), /assignments\[0\] 未知字段：notes/);
  assert.match(errors.join(), /assignments\[0\] 未知字段：pahts/);
  assert.match(errors.join(), /只接受 key \/ profile \/ intent \/ title/);
});

test('validateAssignments：key 合法形式（小写起头、[a-z0-9-]、≤ 24）', () => {
  for (const key of ['a', 'auth', 'auth-probe', 'a1-b2', 'fix-401', 'router2', 'r2-auth', 'a'.repeat(KEY_MAX)]) {
    assert.equal(isValidKey(key), true, `${key} 应合法`);
    assert.deepEqual(validateAssignments([base({ key })]), [], `${key} 应合法`);
  }
});

test('validateAssignments：key 非法形式（大写 / 数字起头 / 下划线 / 边界连字符 / 超长 / 非字符串）', () => {
  // key 直接拼进文件名与分支名：大写在大小写不敏感的文件系统上会撞车，
  // 下划线与首尾连字符则让 `worker-<key>-r<n>` 的解析与 git 分支名都变得不可靠。
  for (const key of ['AUTH', '2auth', 'auth_x', 'auth-', '-auth', 'auth--x', 'auth probe', 'auth.probe', '', 'a'.repeat(KEY_MAX + 1), null, undefined, 42, ['auth']]) {
    assert.equal(isValidKey(key), false, `${JSON.stringify(key)} 应非法`);
    const errors = validateAssignments([base({ key })]);
    assert.match(errors.join(), /assignments\[0\]\.key 非法/, `${JSON.stringify(key)} 应非法`);
    assert.match(errors.join(), /小写字母开头，\[a-z0-9-\]，≤ 24 字符，不得以 r<数字> 结尾/);
  }
});

test('validateAssignments：key 不得以 r<数字> 结尾（否则和轮次后缀撞名）', () => {
  // 产物名是 `worker-<key>-r<n>.json`：key = "auth-r2" 时，`worker-auth-r2-r1.json` 与
  // key = "auth" 的第 2 轮 `worker-auth-r2.json` 在同一个目录里肉眼与正则都分不清，
  // 续会话与恢复会按错的那份接着做。分支名 task/<id>--<key> 同理。
  for (const key of ['auth-r2', 'r2', 'fix-r10', 'a-r0']) {
    assert.equal(isValidKey(key), false, `${key} 应因轮次后缀被拒`);
    assert.match(validateAssignments([base({ key })]).join(), /不得以 r<数字> 结尾/);
  }
  // 只有「-r<数字>」结尾才撞名：r 前面不是边界（router2）或数字前没有 r（auth2）都照常放行。
  for (const key of ['router2', 'auth2', 'r2-auth', 'error500']) {
    assert.equal(isValidKey(key), true, `${key} 不该被误伤`);
  }
});

test('validateAssignments：key 在同一次 dispatch 内必须唯一', () => {
  // 同名 key = 同一个产物路径与同一条分支：两个 worker 会互相覆盖 log 与 report。
  const errors = validateAssignments([base(), base({ title: '另一件事' })]);
  assert.deepEqual(errors, ['assignments[1].key 重复：auth-probe']);
  assert.deepEqual(validateAssignments([base(), base({ key: 'auth-fix' })]), [], '不同 key 可并存');
});

test('validateAssignments：profile / intent 必须落在闭集内', () => {
  for (const profile of PROFILES) {
    const over = profile === 'write' ? { profile, paths: ['src/**'] } : { profile };
    assert.deepEqual(validateAssignments([base(over)]), [], `profile=${profile} 应合法`);
  }
  for (const profile of ['admin', 'READ', '', null, undefined, 1]) {
    assert.match(errsOf({ profile }), /assignments\[0\]\.profile 取值非法/, `${JSON.stringify(profile)} 应非法`);
  }
  for (const intent of INTENTS) {
    assert.deepEqual(validateAssignments([base({ intent })]), [], `intent=${intent} 应合法`);
  }
  for (const intent of ['refactor', 'Investigate', '', null, undefined]) {
    assert.match(errsOf({ intent }), /assignments\[0\]\.intent 取值非法/, `${JSON.stringify(intent)} 应非法`);
  }
});

test('validateAssignments：title 必填且 ≤ 120 字符', () => {
  assert.deepEqual(validateAssignments([base({ title: 'x'.repeat(120) })]), []);
  for (const title of ['', '   ', 'x'.repeat(121), undefined, null, 42, ['t']]) {
    assert.match(errsOf({ title }), /assignments\[0\]\.title 必填，≤ 120 字符/, `${JSON.stringify(title)} 应非法`);
  }
});

test('validateAssignments：purpose / scope / deliverables / done_when 四项各自必填且 ≤ 2000 字符', () => {
  // 这四段是接收者唯一的任务说明（逐字进 prompt）：缺一段，worker 就得自己猜边界或完成标准，
  // 而「猜」正是并行委派最贵的失败模式。
  for (const f of ['purpose', 'scope', 'deliverables', 'done_when']) {
    assert.deepEqual(validateAssignments([base({ [f]: 'x'.repeat(2000) })]), [], `${f} 2000 字符应合法`);
    for (const bad of ['', '  ', 'x'.repeat(2001), undefined, null, 42, { text: 'x' }]) {
      assert.match(
        errsOf({ [f]: bad }),
        new RegExp(`assignments\\[0\\]\\.${f} 必填，≤ 2000 字符`),
        `${f}=${JSON.stringify(bad)} 应非法`,
      );
    }
  }
});

test('validateAssignments：inputs 必填 1–20 条，每条 ≤ 300 字符', () => {
  // inputs 是「凭什么这么派」的依据（原文引用 / 产物路径 / AC 编号）：
  // 允许为空，router 就能派出无凭据的活；不限条数，整份案卷又会被塞进 prompt。
  assert.deepEqual(validateAssignments([base({ inputs: ['a'] })]), []);
  assert.deepEqual(validateAssignments([base({ inputs: Array(20).fill('依据') })]), []);
  assert.deepEqual(validateAssignments([base({ inputs: ['x'.repeat(300)] })]), []);
  for (const inputs of [[], Array(21).fill('依据'), ['x'.repeat(301)], [''], ['  '], [42], 'AC-004', undefined, null, {}]) {
    assert.match(errsOf({ inputs }), /assignments\[0\]\.inputs 必填：1–20 条输入依据/, `${JSON.stringify(inputs)?.slice(0, 40)} 应非法`);
  }
});

test('validateAssignments：paths 只对 profile=write 有意义', () => {
  // read / sandbox 压根不往产品里写：给它们声明 paths 是一种假授权，
  // 会让 router 以为某段代码「已经有人负责」，从而不再派真正的 write。
  const read = validateAssignments([base({ paths: ['src/auth/**'] })]);
  assert.deepEqual(read, ['assignments[0].paths 只对 profile=write 有意义']);
  assert.match(
    validateAssignments([base({ profile: 'sandbox', intent: 'experiment', paths: ['src/**'] })]).join(),
    /paths 只对 profile=write 有意义/,
  );
  assert.deepEqual(validateAssignments([base({ profile: 'write', intent: 'fix', paths: ['src/auth/**'] })]), []);
  // write 不带 paths 在字段层合法：单个写手无须声明范围，冲突检查才是它该被拦住的地方。
  assert.deepEqual(validateAssignments([base({ profile: 'write', intent: 'fix' })]), []);
});

test('validateAssignments：paths 形态 1–40 条、每条 ≤ 200 字符', () => {
  const write = (paths) => errsOf({ profile: 'write', intent: 'fix', paths });
  assert.deepEqual(validateAssignments([base({ profile: 'write', intent: 'fix', paths: Array(40).fill('src/a/**') })]), []);
  assert.deepEqual(validateAssignments([base({ profile: 'write', intent: 'fix', paths: ['s'.repeat(200)] })]), []);
  for (const paths of [[], Array(41).fill('src/**'), ['s'.repeat(201)], [''], ['   '], [42], 'src/**', {}]) {
    assert.match(write(paths), /assignments\[0\]\.paths 须为 1–40 条路径 \/ glob/, `${JSON.stringify(paths)?.slice(0, 40)} 应非法`);
  }
});

test('validateAssignments：paths 必须是仓库内相对路径（绝对路径与 .. 段一律拒）', () => {
  // paths 同时是授权声明与越界检查的基准（filesOutsideDeclared）：
  // 放过 `/etc/...` 或 `../` 就等于让一个 worker 在 worktree 之外写文件，越界检查也测不出来。
  const write = (paths) => errsOf({ profile: 'write', intent: 'fix', paths });
  for (const paths of [['/etc/passwd'], ['/'], ['src/**', '/abs/x'], ['../sibling/**'], ['src/../../etc'], ['..'], ['src/../lib/**']]) {
    assert.match(write(paths), /assignments\[0\]\.paths 必须是仓库内相对路径（不得以 \/ 开头或含 \.\.）/, `${JSON.stringify(paths)} 应非法`);
  }
  // 逐段比较，不是子串匹配：`..foo` 与 `a..b` 是普通目录名，不该被误伤。
  assert.deepEqual(validateAssignments([base({ profile: 'write', intent: 'fix', paths: ['src/..foo/**', 'a..b/x.ts'] })]), []);
});

test('validateAssignments：acs 只接受 AC-<数字> / B-<数字>，最多 60 条', () => {
  // acs 只是参考索引（子任务做完 ≠ AC 通过）：格式不锁死，版本闸与证据链上的编号就对不上号。
  for (const acs of [[], ['AC-1'], ['AC-004', 'B-12'], Array(60).fill('AC-1')]) {
    assert.deepEqual(validateAssignments([base({ acs })]), [], `${JSON.stringify(acs).slice(0, 30)} 应合法`);
  }
  for (const acs of [['ac-1'], ['AC-'], ['AC1'], ['AC-1a'], ['C-1'], [1], 'AC-1', Array(61).fill('AC-1'), {}, null]) {
    assert.match(errsOf({ acs }), /assignments\[0\]\.acs 须为相关 AC 编号数组/, `${JSON.stringify(acs)?.slice(0, 30)} 应非法`);
  }
});

test('validateAssignments：continue_from 必须是正整数轮次号', () => {
  // 它指向要续接的那一轮（读那一轮的产物接着做）：0 / 负数 / 小数都取不到对应的产物文件。
  assert.deepEqual(validateAssignments([base({ continue_from: 1 })]), []);
  assert.deepEqual(validateAssignments([base({ continue_from: 42 })]), []);
  for (const v of [0, -1, 1.5, '2', null, undefined, true, NaN, Infinity]) {
    assert.match(errsOf({ continue_from: v }), /assignments\[0\]\.continue_from 须为要续接的那一轮的轮次号（正整数）/, `${String(v)} 应非法`);
  }
});

test('validateAssignments：一次最多 8 个，超出仍逐条校验其余字段', () => {
  // 上限护的是并发预算与集成复杂度：9 个 worker 的产物要顺序合进同一条任务分支。
  const nine = Array.from({ length: 9 }, (_, i) => base({ key: `probe-${i}` }));
  const errors = validateAssignments(nine);
  assert.deepEqual(errors, [`assignments 一次最多 ${MAX_ASSIGNMENTS_PER_DISPATCH} 个（实际 9）：更多的工作放到后续轮次`]);
  assert.deepEqual(validateAssignments(Array.from({ length: 8 }, (_, i) => base({ key: `probe-${i}` }))), [], '8 个是上限内');
  // 超限不会短路掉逐条校验：router 一次就能看到所有要改的地方。
  const alsoBroken = validateAssignments(nine.map((a, i) => (i === 0 ? { ...a, intent: 'refactor' } : a)));
  assert.match(alsoBroken.join(), /一次最多 8 个/);
  assert.match(alsoBroken.join(), /assignments\[0\]\.intent 取值非法/);
});

// ---- literalPrefixSegments：glob → 可比较的字面路径段 ----

test('literalPrefixSegments：截到第一个通配符之前，并丢掉不完整的那一段', () => {
  assert.deepEqual(literalPrefixSegments('packages/chains/**'), ['packages', 'chains']);
  assert.deepEqual(literalPrefixSegments('**/*.ts'), []);
  assert.deepEqual(literalPrefixSegments('./src/a.ts'), ['src', 'a.ts']);
  assert.deepEqual(literalPrefixSegments('src/*.ts'), ['src']);
  assert.deepEqual(literalPrefixSegments('src/**'), ['src']);
  assert.deepEqual(literalPrefixSegments('package.json'), ['package.json']);
  assert.deepEqual(literalPrefixSegments('conductor/lib/git.mjs'), ['conductor', 'lib', 'git.mjs']);
  // `src/*.ts` 里 `*.ts` 那一段是半截字面量：留着它比较，就会把 `src/*.ts` 和 `src/*.js` 判成不重叠。
  assert.deepEqual(literalPrefixSegments('src/a*.ts'), ['src']);
  assert.deepEqual(literalPrefixSegments('src/?.ts'), ['src']);
  assert.deepEqual(literalPrefixSegments('{src,docs}/**'), []);
  // 缺省与脏输入不抛错：契约模块是零 IO 纯函数，任何输入都只能变成判决。
  for (const junk of ['', '/', './', null, undefined]) {
    assert.deepEqual(literalPrefixSegments(junk), [], `${JSON.stringify(junk)} 应得空段`);
  }
});

// ---- writePathConflicts：并行写入的保守重叠判定 ----

const writer = (key, paths) => ({ ...base({ key, profile: 'write', intent: 'fix' }), ...(paths ? { paths } : {}) });

test('writePathConflicts：不相交目录可并行，嵌套目录判冲突', () => {
  assert.deepEqual(writePathConflicts([writer('a', ['src/a/**']), writer('b', ['src/b/**'])]), []);
  assert.deepEqual(writePathConflicts([writer('a', ['src/**']), writer('b', ['docs/**', 'README.md'])]), []);

  // 一方是另一方的前缀 = 可能写到同一处：宁可误报让 router 串行，也不放过一次共享写入。
  const nested = writePathConflicts([writer('a', ['src/**']), writer('b', ['src/lib/**'])]);
  assert.deepEqual(nested, ['a(src/**) 与 b(src/lib/**) 的写入范围可能重叠：串行派出，或收窄 paths']);
  assert.equal(writePathConflicts([writer('a', ['src/a.ts']), writer('b', ['src/a.ts'])]).length, 1, '同一个文件当然冲突');
});

test('writePathConflicts：无字面前缀的 glob（**/*.ts）与任何人都冲突', () => {
  // 它的字面前缀是空的 = 整仓：谁都可能被它改到，必须串行。
  const conflicts = writePathConflicts([writer('a', ['**/*.ts']), writer('b', ['docs/**'])]);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /a\(\*\*\/\*\.ts\) 与 b\(docs\/\*\*\) 的写入范围可能重叠/);
  assert.equal(writePathConflicts([writer('a', ['{src,docs}/**']), writer('b', ['tools/x.mjs'])]).length, 1);
});

test('writePathConflicts：前缀按路径段比，package.json 与 packages/** 不冲突', () => {
  // 这是最容易回归的一条：按字符串前缀比较时 "packages/chains/**" 会被当成 "package.json" 的
  // 兄弟前缀而误判冲突，router 于是永远串行——并行委派的收益直接归零。
  assert.deepEqual(writePathConflicts([writer('a', ['package.json']), writer('b', ['packages/chains/**'])]), []);
  assert.deepEqual(writePathConflicts([writer('a', ['src/auth/**']), writer('b', ['src/authz/**'])]), []);
  assert.deepEqual(writePathConflicts([writer('a', ['tools/dossier-stats.mjs']), writer('b', ['tools/dossier-stats-extra.mjs'])]), []);
  // 这两对专门盯字符串比较：'src/authz/' 确实以 'src/auth' 开头、'docs/api-v2/' 以 'docs/api' 开头，
  // 一旦改回 startsWith 就会误判冲突，而逐段比较在第二段就分开了。
  assert.deepEqual(writePathConflicts([writer('a', ['src/auth']), writer('b', ['src/authz/**'])]), []);
  assert.deepEqual(writePathConflicts([writer('a', ['docs/api']), writer('b', ['docs/api-v2/**'])]), []);
  // 反向也要成立：真正的父子目录仍必须判冲突，否则「不误报」就变成了「什么都不报」。
  assert.equal(writePathConflicts([writer('a', ['src/auth']), writer('b', ['src/auth/session.ts'])]).length, 1);
});

test('writePathConflicts：多写手时每个都必须声明 paths，缺声明的先报出来', () => {
  const missing = writePathConflicts([writer('a'), writer('b', ['src/**'])]);
  assert.deepEqual(missing, ['a 没有声明 paths：同一轮并行多个 write 时每个都必须声明写入范围']);
  // 空数组等同于没声明：一个写不出范围的写手，事后也无从判断它有没有越界。
  assert.deepEqual(
    writePathConflicts([{ ...writer('a'), paths: [] }, writer('b', ['src/**'])]),
    ['a 没有声明 paths：同一轮并行多个 write 时每个都必须声明写入范围'],
  );
  // 缺声明时先只报缺声明，不掺杂后续的重叠结论——否则 router 会被两种性质不同的错误一起砸。
  const both = writePathConflicts([writer('a'), writer('b'), writer('c', ['src/**'])]);
  assert.equal(both.length, 2);
  assert.ok(both.every((m) => /没有声明 paths/.test(m)));
});

test('writePathConflicts：单个写手与 read / sandbox 委派从不参与冲突判定', () => {
  // 只有 write 会改产品代码：read 是只读快照，sandbox 的产物结束即弃，
  // 把它们算成写手只会逼出一堆无谓的串行。
  assert.deepEqual(writePathConflicts([writer('a')]), [], '单个写手无须声明 paths');
  assert.deepEqual(writePathConflicts([writer('a', ['src/**'])]), []);
  assert.deepEqual(writePathConflicts([
    writer('a'),
    base({ key: 'probe', profile: 'read' }),
    base({ key: 'dep-bump', profile: 'sandbox', intent: 'experiment' }),
  ]), [], 'read / sandbox 不算写手，写手仍只有一个');
  assert.deepEqual(writePathConflicts([]), []);
  assert.deepEqual(writePathConflicts(undefined), []);
  assert.deepEqual(writePathConflicts([null, undefined]), [], '脏元素不得让判定抛错');
});

// ---- filesOutsideDeclared：事后越界报告（只报告，不判失败） ----

test('filesOutsideDeclared：声明前缀内的文件不报，前缀外的逐个报出', () => {
  assert.deepEqual(
    filesOutsideDeclared(['src/auth/login.ts', 'docs/x.md', 'srcfoo/b.ts'], ['src/auth/**']),
    ['docs/x.md', 'srcfoo/b.ts'],
  );
  assert.deepEqual(filesOutsideDeclared(['src/a.ts', 'tools/b.mjs'], ['src/**', 'tools/**']), []);
  // 同样逐段比较：srcfoo 不是 src 的子目录，package-lock.json 也不在 package.json 之内。
  assert.deepEqual(filesOutsideDeclared(['package-lock.json'], ['package.json']), ['package-lock.json']);
  assert.deepEqual(filesOutsideDeclared(['package.json'], ['package.json']), []);
  // 声明成整仓（无字面前缀）时一切都算「在范围内」——这正是 writePathConflicts 把它判成
  // 与谁都冲突的原因：授权面越大，事后越界检查越测不出东西。
  assert.deepEqual(filesOutsideDeclared(['anything/deep/x.ts'], ['**/*.ts']), []);
});

test('filesOutsideDeclared：没有声明 paths 时返回空（越界与否交给 router 与整体 review）', () => {
  for (const paths of [[], undefined, null, 'src/**', {}]) {
    assert.deepEqual(filesOutsideDeclared(['src/a.ts', 'x.md'], paths), [], `paths=${JSON.stringify(paths)} 应返回空`);
  }
  assert.deepEqual(filesOutsideDeclared([], ['src/**']), []);
  assert.deepEqual(filesOutsideDeclared(undefined, ['src/**']), [], '没有改动文件时不抛错');
});
