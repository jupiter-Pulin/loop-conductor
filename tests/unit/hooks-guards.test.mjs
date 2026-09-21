// 单元：三个「护栏类」hook 脚本按 Claude Code hook 协议独立驱动（stdin JSON + 退出码）。
// read-guard：PreToolUse(Read|Grep|Glob) 读范围白名单——router / worker:read 能读内容，
//   但「能读」必须有边界；越界在工具执行前就 exit 2 拦下（stderr 喂回模型）。
// check-digest：摘要角色的 Stop hook——会话内机械校验 + 有界阻断，
//   既要当场把错误清单喂回去自修，又不能让一个改不好的摘要 agent 永远结束不了。
// maker-git-guard：只覆盖**嵌套 claude CLI** 这一半护栏
//   （git 破坏性操作那一半已在 tests/unit/hooks.test.mjs 覆盖，不重复）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateDigestText } from '../../conductor/lib/digest-contract.mjs';
import { sha256Of, splitLines } from '../../conductor/lib/spec-version.mjs';
import { enumerateAcceptanceCriteria } from '../../conductor/lib/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ_GUARD = path.resolve(HERE, '..', '..', 'conductor', 'hooks', 'read-guard.mjs');
const CHECK_DIGEST = path.resolve(HERE, '..', '..', 'conductor', 'hooks', 'check-digest.mjs');
const GIT_GUARD = path.resolve(HERE, '..', '..', 'conductor', 'hooks', 'maker-git-guard.mjs');

function runHook(script, args, stdinObj) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    input: stdinObj == null ? '' : JSON.stringify(stdinObj),
  });
}

function tmpdir(t, prefix = 'hook-guard-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 落一个真实文件（护栏解析符号链接，路径必须真的存在才测得准）。 */
function put(dir, rel, content = 'x\n') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

const readCall = (tool_name, tool_input, cwd) => ({ tool_name, tool_input, cwd });

// ---- read-guard ----

test('read-guard：root（可多个）之内的读放行，Read/Grep/Glob 都放行', (t) => {
  // 反向保险：router 的判断建立在「读得到案卷与原文」上，护栏把正常范围也拦掉等于让角色瞎掉。
  const dossier = tmpdir(t);
  const worktree = tmpdir(t, 'hook-guard-wt-');
  const spec = put(dossier, 'spec.md', '# spec\n');
  const code = put(worktree, 'lib/stats.mjs', 'export const x = 1;\n');
  const cases = [
    ['Read', { file_path: spec }],
    ['Read', { file_path: code }], // 第二个 root 同样算数：命中任意一个即可
    ['Grep', { path: dossier }], // Grep/Glob 传的是 path 而不是 file_path
    ['Glob', { path: path.join(worktree, 'lib') }],
    ['Read', { file_path: dossier }], // root 自身
  ];
  for (const [tool, input] of cases) {
    const r = runHook(READ_GUARD, ['--root', dossier, '--root', worktree], readCall(tool, input, dossier));
    assert.equal(r.status, 0, `${tool} ${JSON.stringify(input)} 不该被拦：${r.stderr}`);
  }
});

test('read-guard：root 之外的路径拒读（exit 2），反馈里给出被拒目标、可读范围与正当出路', (t) => {
  // 越界读的典型后果：串到别的任务案卷 / state / 用户主目录，把不属于本任务的上下文吸进来。
  // 反馈必须够用——只说「不行」会让模型原地重试，白烧一轮。
  const dossier = tmpdir(t);
  const outside = tmpdir(t, 'hook-guard-outside-');
  const other = put(outside, 'other-task/spec.md');
  for (const [tool, input] of [['Read', { file_path: other }], ['Grep', { path: outside }]]) {
    const r = runHook(READ_GUARD, ['--root', dossier], readCall(tool, input, dossier));
    assert.equal(r.status, 2, `${tool} 应被拦：${r.stderr}`);
    assert.match(r.stderr, /本角色只能读这些位置之内的文件/);
    assert.match(r.stderr, /被拒绝的读取目标/);
    assert.ok(r.stderr.includes(fs.realpathSync(dossier)), '列出可读范围');
  }
  const r = runHook(READ_GUARD, ['--root', dossier], readCall('Read', { file_path: other }, dossier));
  assert.ok(r.stderr.includes(fs.realpathSync(other)), '写清是哪个目标越界了');
  assert.match(r.stderr, /未决问题|调查任务/, '给出范围外信息的正当出路，而不是让模型自己想办法绕');
});

test('read-guard：`..` 逃逸被拒（绝对路径与按 cwd 解析的相对路径都算）', (t) => {
  // 最省事的绕法就是 `../`：只要按字面拼接不归一化，护栏就形同虚设。
  const root = tmpdir(t);
  const sub = path.dirname(put(root, 'dossier/spec.md'));
  const escapes = [
    readCall('Read', { file_path: path.join(root, '..', 'escaped.md') }, root),
    readCall('Read', { file_path: path.join('..', '..', 'escaped.md') }, sub), // 相对路径按 stdin.cwd 解析
    readCall('Grep', { path: path.join(sub, '..', '..') }, root),
    readCall('Read', { file_path: '/etc/passwd' }, root),
  ];
  for (const input of escapes) {
    const r = runHook(READ_GUARD, ['--root', root], input);
    assert.equal(r.status, 2, `应被拦：${JSON.stringify(input.tool_input)}（stderr: ${r.stderr}）`);
    assert.match(r.stderr, /本角色只能读这些位置之内的文件/);
  }
  // 归一化之后仍在 root 内的 `..` 不该误伤。
  const ok = runHook(READ_GUARD, ['--root', root], readCall('Read', { file_path: path.join(sub, '..', 'dossier', 'spec.md') }, root));
  assert.equal(ok.status, 0, ok.stderr);
});

test('read-guard：root 内指向外部的符号链接被拒；链接目标在 root 内则放行', (t) => {
  // 字符串前缀比对会被这一招整个绕开：`<root>/link -> /etc` 之后，`<root>/link/passwd`
  // 看起来完全在范围内。护栏必须先解析真实路径再比。
  const root = tmpdir(t);
  const outside = tmpdir(t, 'hook-guard-outside-');
  const secret = put(outside, 'secret.txt', 'token\n');
  put(root, 'inner/spec.md');
  fs.symlinkSync(outside, path.join(root, 'link'));
  fs.symlinkSync(path.join(root, 'inner'), path.join(root, 'inner-link'));

  const viaLink = runHook(READ_GUARD, ['--root', root], readCall('Read', { file_path: path.join(root, 'link', 'secret.txt') }, root));
  assert.equal(viaLink.status, 2, '经符号链接读到 root 外必须拦');
  assert.ok(viaLink.stderr.includes(fs.realpathSync(secret)), '反馈里给的是解析后的真实目标');

  const dirItself = runHook(READ_GUARD, ['--root', root], readCall('Grep', { path: path.join(root, 'link') }, root));
  assert.equal(dirItself.status, 2, '链接目录本身也在范围外');

  // 尚不存在的路径按「最深的已存在祖先」解析：否则新建文件名就能骗过护栏。
  const notYet = runHook(READ_GUARD, ['--root', root], readCall('Read', { file_path: path.join(root, 'link', 'not-created-yet.md') }, root));
  assert.equal(notYet.status, 2, '链接后面接一个还不存在的文件名同样要拦');

  const inner = runHook(READ_GUARD, ['--root', root], readCall('Read', { file_path: path.join(root, 'inner-link', 'spec.md') }, root));
  assert.equal(inner.status, 0, `链接目标仍在 root 内就不该拦（护栏禁的是越界，不是符号链接本身）：${inner.stderr}`);
});

test('read-guard：范围内的 .env / 密钥文件也拒读，.env.example 放行', (t) => {
  // 秘密一旦进入上下文就收不回来（会写进 log、进下一轮 prompt）。
  // 但占位模板正是「需要键名时该读的那个文件」，连它一起拦会逼模型去猜键名。
  const root = tmpdir(t);
  for (const name of ['.env', '.env.local', '.npmrc', 'id_rsa', 'server.pem', 'deploy.key', 'credentials.json']) {
    const p = put(root, name, 'SECRET=1\n');
    const r = runHook(READ_GUARD, ['--root', root], readCall('Read', { file_path: p }, root));
    assert.equal(r.status, 2, `${name} 应拒读：${r.stderr}`);
    assert.match(r.stderr, /拒绝读取疑似密钥 \/ 环境变量文件/, name);
    assert.match(r.stderr, /\.env\.example/, '拒读的同时要指出该读哪个文件');
  }
  for (const name of ['.env.example', '.env.sample', '.env.template']) {
    const p = put(root, name, 'SECRET=\n');
    const r = runHook(READ_GUARD, ['--root', root], readCall('Read', { file_path: p }, root));
    assert.equal(r.status, 0, `${name} 是占位模板，不该拦：${r.stderr}`);
  }
});

test('read-guard：Grep/Glob 不给 path 时按 cwd 判（cwd 在范围内放行、在范围外拒）', (t) => {
  // 不给 path 的 Grep 搜的就是整个 cwd：这时候「没有目标」不等于「无害」，
  // 当成默认放行就等于给了一次全盘搜索。
  const root = tmpdir(t);
  const sub = path.dirname(put(root, 'dossier/spec.md'));
  const outside = tmpdir(t, 'hook-guard-outside-');

  for (const cwd of [root, sub]) {
    for (const tool of ['Grep', 'Glob']) {
      const r = runHook(READ_GUARD, ['--root', root], readCall(tool, { pattern: 'AC-' }, cwd));
      assert.equal(r.status, 0, `${tool} 在范围内的 cwd 搜索应放行：${r.stderr}`);
    }
  }
  const denied = runHook(READ_GUARD, ['--root', root], readCall('Grep', { pattern: 'token' }, outside));
  assert.equal(denied.status, 2, 'cwd 在范围外时，无 path 的 Grep 同样要拦');
  assert.ok(denied.stderr.includes(fs.realpathSync(outside)), '反馈里指明被判定的其实是 cwd');

  // 空字符串 path 与无 path 同义，不能因为「有这个字段」就当成合法目标。
  const empty = runHook(READ_GUARD, ['--root', root], readCall('Grep', { path: '' }, outside));
  assert.equal(empty.status, 2, empty.stderr);
});

test('read-guard：零 --root（角色没配读范围）不拦，配置缺失不该把角色锁死', () => {
  // 护栏的默认值要偏「可用」：配置漏了就整个角色读不了任何文件，会把 loop 直接卡死，
  // 而越界的终审兜底在内核（lib/integrity.mjs）与角色的工具白名单上。
  for (const input of [
    readCall('Read', { file_path: '/etc/passwd' }, '/'),
    readCall('Grep', { path: os.homedir() }, '/'),
  ]) {
    const r = runHook(READ_GUARD, [], input);
    assert.equal(r.status, 0, `零 --root 应放行：${r.stderr}`);
  }
});

test('read-guard：非读工具不归它管（Write/Edit/Bash 一律不拦）', (t) => {
  // 职责单一：写由 write-guard 判、Bash 由 maker-git-guard 判。
  // 这里多管一层，只会在两个护栏口径不一致时产生难查的假拦截。
  const root = tmpdir(t);
  const outside = tmpdir(t, 'hook-guard-outside-');
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'Bash', 'Task']) {
    const r = runHook(READ_GUARD, ['--root', root], readCall(tool, { file_path: path.join(outside, 'x.md') }, root));
    assert.equal(r.status, 0, `${tool} 不该被 read-guard 拦：${r.stderr}`);
  }
});

// ---- check-digest ----

const DIGEST_SPEC = [
  '# stats 能力扩展',
  '',
  '## Summary',
  '',
  '给 stats 模块补齐 median 与 percentile，并保持零依赖。',
  '',
  '## 契约',
  '',
  '1. 不得引入任何第三方依赖。',
  '',
  '## 验收标准',
  '',
  '- AC-001: 第 1 条可观察行为成立',
  '- AC-002: 第 2 条可观察行为成立',
  '',
].join('\n');
const DIGEST_SHA = sha256Of(DIGEST_SPEC);
const DIGEST_CTX = {
  specText: DIGEST_SPEC,
  specSha: DIGEST_SHA,
  acIds: enumerateAcceptanceCriteria(DIGEST_SPEC).map((a) => a.ac_id),
};

/** 从原文机械地造一份**真的合格**的摘要（行号 / quote 都是从原文抄的）；mutate 可以把它改坏。 */
function makeDigest(mutate = null) {
  const lines = splitLines(DIGEST_SPEC);
  const find = (needle) => {
    const i = lines.findIndex((l) => l.includes(needle));
    assert.notEqual(i, -1, `fixture 坏了：原文里找不到 ${needle}`);
    return { lines: [i + 1, i + 1], quote: lines[i].trim() };
  };
  const digest = {
    schema: 'spec-digest/v1',
    source_sha256: DIGEST_SHA,
    goal: [{ text: '补齐 median 与 percentile', refs: [find('median 与 percentile')] }],
    constraints: [{ kind: 'must_not', text: '不引入第三方依赖', refs: [find('不得引入任何第三方依赖')] }],
    acs: DIGEST_CTX.acIds.map((id) => ({ id, gist: `${id} 的要点`, refs: [find(`${id}:`)] })),
    modules: [],
    open_questions: [],
    proposed_packages: [],
  };
  if (mutate) mutate(digest);
  return digest;
}

/** 摘要 agent 的会话现场：原文快照 + 摘要文件 + 报告路径（报告目录故意还不存在）。 */
function digestEnv(t, digest) {
  const dir = tmpdir(t, 'hook-digest-');
  const source = path.join(dir, 'spec.source.md');
  fs.writeFileSync(source, DIGEST_SPEC);
  const digestPath = path.join(dir, 'digest', `${DIGEST_SHA.slice(0, 12)}.json`);
  if (digest !== undefined) {
    fs.mkdirSync(path.dirname(digestPath), { recursive: true });
    fs.writeFileSync(digestPath, `${JSON.stringify(digest, null, 2)}\n`);
  }
  const report = path.join(dir, 'reports', 'nested', 'digest-check.json');
  const args = (over = []) => ['--digest', digestPath, '--source', source, '--sha', DIGEST_SHA, '--report', report, ...over];
  return {
    dir, source, digestPath, report, args,
    readReport: () => JSON.parse(fs.readFileSync(report, 'utf8')),
    rawDigest: () => { try { return fs.readFileSync(digestPath, 'utf8'); } catch { return null; } },
  };
}

test('check-digest：合格摘要 → exit 0，报告记 ok:true / blocked:false / blocks:0', (t) => {
  const digest = makeDigest();
  assert.equal(validateDigestText(JSON.stringify(digest), DIGEST_CTX).ok, true, 'fixture 必须真的合格，否则这条用例什么都没证明');
  const env = digestEnv(t, digest);

  const r = runHook(CHECK_DIGEST, env.args(), { session_id: 'sess-ok', stop_hook_active: false });
  assert.equal(r.status, 0, r.stderr);

  // 报告是内核判「这一轮摘要算不算数 / 已经拦过几次」的唯一依据，合格路径也必须留痕。
  const rep = env.readReport();
  assert.equal(rep.schema_version, 1);
  assert.equal(rep.source, 'stop-hook');
  assert.equal(rep.ok, true);
  assert.equal(rep.blocked, false);
  assert.equal(rep.blocks, 0);
  assert.deepEqual(rep.errors, []);
  assert.equal(rep.digest_path, env.digestPath);
  assert.equal(rep.spec_sha256, DIGEST_SHA);
  assert.equal(rep.session_id, 'sess-ok');
  assert.equal(rep.stop_hook_active, false);
  assert.match(rep.checked_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('check-digest：不合格 → exit 2 阻断结束，stderr 原样给出错误清单，报告记 blocked:true', (t) => {
  // 引用行号 / quote 抄错是最常见的毛病，会话里当场喂回错误清单最省钱：
  // 换成等内核终审再重派，等于整个会话白开一次。
  const digest = makeDigest((d) => { d.acs[1].refs[0].quote = '这句话原文里根本没有'; });
  const env = digestEnv(t, digest);

  const r = runHook(CHECK_DIGEST, env.args(), { session_id: 'sess-bad', stop_hook_active: false });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /摘要机械校验未通过/);
  assert.ok(r.stderr.includes(env.digestPath), '告诉模型该重写哪个文件');
  assert.match(r.stderr, /acs\[1\]\.refs\[0\]\.quote 没有逐字出现在 L14/, '错误清单要精确到条目与行号');
  assert.match(r.stderr, /用 Write 重写整份 JSON/, '给出可执行的修法，而不是只报错');

  const rep = env.readReport();
  assert.equal(rep.ok, false);
  assert.equal(rep.blocked, true);
  assert.equal(rep.blocks, 1);
  // 与内核终审共用同一份裁判代码：两边口径必须逐字一致，否则会出现「hook 放行、内核判死」。
  assert.deepEqual(rep.errors, validateDigestText(env.rawDigest(), DIGEST_CTX).errors);
});

test('check-digest：阻断次数封顶 --max-blocks，用尽后放行（改不好的摘要 agent 不会死循环）', (t) => {
  // Stop hook 是快反馈层不是终审：无限阻断 = 会话永远结束不了，成本无上限。
  // 次数用尽就放行，剩下的交给内核记一次失败尝试（有界重派 / 显式降级）。
  const env = digestEnv(t, makeDigest((d) => { d.source_sha256 = 'f'.repeat(64); }));
  const statuses = [];
  const blocks = [];
  for (let i = 0; i < 4; i++) {
    const r = runHook(CHECK_DIGEST, env.args(['--max-blocks', '2']), { session_id: 'sess-loop', stop_hook_active: i > 0 });
    statuses.push(r.status);
    blocks.push(env.readReport().blocks);
  }
  assert.deepEqual(statuses, [2, 2, 0, 0], '只阻断 --max-blocks 次，之后一律放行');
  assert.deepEqual(blocks, [1, 2, 2, 2], '计数封顶，不会越滚越大');

  const rep = env.readReport();
  assert.equal(rep.ok, false, '放行不等于合格：报告如实记着没过，内核照样按失败处理');
  assert.equal(rep.blocked, false);
  assert.ok(rep.errors.some((e) => /source_sha256 不匹配/.test(e)), '抄错来源版本 = 摘要对不上这一版 spec');
});

test('check-digest：摘要文件根本没写也算不合格（exit 2）', (t) => {
  // 「会话结束了但交付物不在盘上」必须当场发现：
  // 否则内核只会看到一个空目录，错误信息比现在难查得多。
  const env = digestEnv(t, undefined);
  const r = runHook(CHECK_DIGEST, env.args(), { session_id: 'sess-none', stop_hook_active: false });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /摘要文件缺失或为空/);
  assert.equal(env.readReport().blocked, true);
});

test('check-digest：参数缺失 / spec 快照与 --sha 不符 → 放行给内核终审，不写报告', (t) => {
  // 护栏自己的配置或快照出了问题时，宁可放行也不能把会话钉死在一个它无法修复的错误上
  // （模型改不动 hook 的参数）。这类路径不写报告：没有「阻断次数」可记。
  const env = digestEnv(t, makeDigest());
  const stdin = { session_id: 'sess-cfg', stop_hook_active: false };

  const missing = runHook(CHECK_DIGEST, ['--digest', env.digestPath, '--report', env.report], stdin);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stderr, /缺 --digest \/ --source \/ --sha 参数/);

  const wrongSha = runHook(
    CHECK_DIGEST,
    ['--digest', env.digestPath, '--source', env.source, '--sha', 'a'.repeat(64), '--report', env.report],
    stdin,
  );
  assert.equal(wrongSha.status, 0, wrongSha.stderr);
  assert.match(wrongSha.stderr, /spec 快照缺失或与 --sha 不符/);

  const noSource = runHook(
    CHECK_DIGEST,
    ['--digest', env.digestPath, '--source', path.join(env.dir, 'gone.md'), '--sha', DIGEST_SHA, '--report', env.report],
    stdin,
  );
  assert.equal(noSource.status, 0, noSource.stderr);
  assert.match(noSource.stderr, /spec 快照缺失或与 --sha 不符/);

  assert.equal(fs.existsSync(env.report), false, '放行路径不该留下一份看起来「检查过」的报告');
});

// ---- maker-git-guard：嵌套 agent 护栏（git 那一半在 hooks.test.mjs） ----

const bashCall = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('git-guard：命令词是 claude 的一律拦（裸调 / npx / 绝对路径 / 环境变量前缀）', () => {
  // worker 自己再起一个 claude 会话 = 不经内核授权、不入任务成本、不受停止控制的子委派：
  // 预算与轮次上限全部失效，dashboard 上还看不见。要再拆任务只能回到 router。
  const denied = [
    'claude -p x',
    'npx claude',
    '/usr/local/bin/claude',
    'FOO=1 claude',
    'claude',
    'pnpx claude -p "帮我改"',
    'bunx @anthropic-ai/claude-code',
    './claude --dangerously-skip-permissions',
    'sudo claude -p x',
    'node --test && claude -p "再跑一轮"',
  ];
  for (const command of denied) {
    const r = runHook(GIT_GUARD, [], bashCall(command));
    assert.equal(r.status, 2, `应拦截：${command}（stderr: ${r.stderr}）`);
    assert.match(r.stderr, /maker-git-guard 拦截/, command);
    assert.match(r.stderr, /嵌套调用 claude CLI/, command);
    assert.match(r.stderr, /不入账、不继承限制的子委派/, `拦截理由要说清后果：${command}`);
    assert.match(r.stderr, /由 router 派/, `要给出认可的替代路径：${command}`);
  }
});

test('git-guard：claude 只是参数 / 字面量 / 目录名时不误报', () => {
  // 护栏是命令文本匹配，误报的代价同样实在：一次假拦截就烧掉 maker 的一轮。
  const allowed = [
    'echo claude',
    'git commit -m "use claude -p"',
    'ls claude/',
    'cat docs/claude-notes.md',
    'grep -r claude .',
    "git commit -m 'claude -p'",
    'node --test tests/unit/claude.test.mjs',
  ];
  for (const command of allowed) {
    const r = runHook(GIT_GUARD, [], bashCall(command));
    assert.equal(r.status, 0, `不应拦截：${command}（stderr: ${r.stderr}）`);
  }
});

test('git-guard：藏在 sh -c 与命令替换里的嵌套 claude 同样拦', () => {
  // 最顺手的绕法就是再套一层解释器 / 反引号；单引号里的字面量则不会被展开执行，不该误报。
  const denied = ['sh -c "claude -p x"', 'echo $(claude -p x)', 'echo `claude -p x`'];
  for (const command of denied) {
    const r = runHook(GIT_GUARD, [], bashCall(command));
    assert.equal(r.status, 2, `应拦截：${command}（stderr: ${r.stderr}）`);
    assert.match(r.stderr, /嵌套调用 claude CLI/, command);
  }
  const literal = runHook(GIT_GUARD, [], bashCall("git commit -m '$(claude -p x)'"));
  assert.equal(literal.status, 0, `单引号内是字面量，不该拦：${literal.stderr}`);
});
