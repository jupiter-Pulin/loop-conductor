// 单元：agent 没能留下合格 log 时的残局取证（lib/salvage.mjs）。撞上限、被 kill、runner 崩溃的
// 那一轮，内核手里只剩自己逐行落盘的原始流。这份 salvage 的全部价值在于「只说观察得到的事实，
// 并且把不知道的事情明说」：
//   - observeStream 是纯读取——半截 JSON（进程正被 SIGKILL 时最后一行常常就是半截）不能让整份取证报废；
//   - session_id 取第一条（init 那条），续会话要接的就是它，被后面的事件盖掉就接错会话；
//   - writeSalvage 永远不写 outcome：没有合格 log 就没有完成信号，内核绝不替 agent 盖章，
//     多出一个 outcome 字段，下游就可能把「未知」当成「完成」而合并未经验收的产物。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observeStream, writeSalvage } from '../../conductor/lib/salvage.mjs';

const TEXT_TAIL = 1200; // 与 lib/salvage.mjs 内部常量同值（未导出）
const FILES_MAX = 80;

function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salvage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 落一份 stream.jsonl；数组元素是对象则按行 JSON 化，是字符串则原样写入（用来造畸形行）。 */
function writeStream(dir, lines, name = 'maker-r3.stream.jsonl') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
  return p;
}

const assistant = (content, usage = undefined) => ({
  type: 'assistant',
  message: usage === undefined ? { content } : { usage, content },
});
const toolUse = (name, input) => ({ type: 'tool_use', name, input });
const textBlock = (text) => ({ type: 'text', text });

test('完整的一份流 → 逐项聚合：会话、轮次、工具计数、碰过的文件、最后命令、文本尾巴、token 下界', (t) => {
  const dir = makeDir(t);
  const p = writeStream(dir, [
    { type: 'system', subtype: 'init', session_id: 'sess-A', cwd: '/w' },
    assistant(
      [textBlock('先看一眼现状'), toolUse('Read', { file_path: '/w/src/median.mjs' }), toolUse('Bash', { command: 'git status' })],
      { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 },
    ),
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    assistant(
      [toolUse('Write', { file_path: '/w/src/median.mjs' }), toolUse('Edit', { file_path: '/w/tests/median.test.mjs' }), toolUse('Bash', { command: 'npm test' })],
      { input_tokens: 50, output_tokens: 8 },
    ),
    assistant(
      [toolUse('MultiEdit', { file_path: '/w/src/median.mjs' }), toolUse('NotebookEdit', { notebook_path: '/w/nb.ipynb' }), textBlock('   '), textBlock('最后一句话')],
      { input_tokens: '3', output_tokens: null },
    ),
    { type: 'assistant' }, // 没有 message：不计轮次
    { type: 'result', subtype: 'error_max_turns', session_id: 'sess-B', total_cost_usd: 0.42 },
  ]);

  const o = observeStream(p);

  // 续会话认的是 init 那条：被 result 里的另一个 session_id 盖掉就会接到别的会话上。
  assert.equal(o.session_id, 'sess-A');
  assert.equal(o.assistant_turns, 3);
  assert.equal(o.result_subtype, 'error_max_turns', '撞上限与被 kill 的区别全靠它，不能丢');

  assert.deepEqual(o.tool_calls, { Read: 1, Bash: 2, Write: 1, Edit: 1, MultiEdit: 1, NotebookEdit: 1 });
  // 只有写类工具算「碰过」：Read 的 file_path 混进来的话，这份清单就不再是修改面证据。
  assert.deepEqual(o.files_written_via_tools, ['/w/src/median.mjs', '/w/tests/median.test.mjs', '/w/nb.ipynb']);
  assert.deepEqual(o.last_commands, ['git status', 'npm test']);
  // 空白 text 块不覆盖上一条真话；取的是最后一条非空文本。
  assert.equal(o.last_assistant_text_tail, '最后一句话');

  // 下界 = 流里看得见的那部分；缺字段按 0 记，绝不产生 NaN（NaN 落进 JSON 会变 null，账就糊了）。
  assert.deepEqual(o.token_usage_lower_bound, {
    input_tokens: 153, output_tokens: 28, cache_creation_input_tokens: 5, cache_read_input_tokens: 7,
  });
  for (const v of Object.values(o.token_usage_lower_bound)) assert.equal(Number.isFinite(v), true);
});

test('畸形行 / 空行 / 半截 JSON 只是被跳过，不能让整份取证报废', (t) => {
  const dir = makeDir(t);
  const p = writeStream(dir, [
    { type: 'system', subtype: 'init', session_id: 'sess-A' },
    '',
    '   ',
    '{"type":"assistant","message":{"content":[', // 被 SIGKILL 时最后一行就是这样的半截
    'not json at all',
    'null',
    '[]',
    assistant([toolUse('Bash', { command: 'npm test' })], { input_tokens: 9 }),
    { type: 'assistant', message: 'tick-1' }, // 真实 CLI 也出现过 message 是字符串的形状
    assistant([toolUse('Write', { file_path: 42 }), toolUse('Bash', { command: { not: 'a string' } })]),
    assistant('content 不是数组'),
  ]);

  const o = observeStream(p);
  assert.notEqual(o, null, '有半截行也必须给出观察结果');
  assert.equal(o.session_id, 'sess-A');
  assert.equal(o.tool_calls.Bash, 2, '工具被调用过的事实仍然计数');
  assert.deepEqual(o.last_commands, ['npm test'], '非字符串的 command 不入列，也不能变成 "[object Object]"');
  assert.deepEqual(o.files_written_via_tools, [], '非字符串的 file_path 不入列');
  assert.equal(o.token_usage_lower_bound.input_tokens, 9);
  assert.equal(o.last_assistant_text_tail, null);
  // 'null' / '[]' 解析得出但不是事件对象；message 为字符串的那条按一轮计。
  assert.equal(o.assistant_turns, 4);
});

test('文件不存在 → null；文件存在但空 → 零值但成形（两者含义不同，不能混）', (t) => {
  const dir = makeDir(t);
  assert.equal(observeStream(path.join(dir, '不存在.jsonl')), null, 'null = 连调用过哪些工具都无从得知');
  assert.equal(observeStream(dir), null, '读不动（是个目录）也按缺失处理，不抛');

  const empty = path.join(dir, 'empty.stream.jsonl');
  fs.writeFileSync(empty, '');
  assert.deepEqual(observeStream(empty), {
    session_id: null,
    assistant_turns: 0,
    result_subtype: null,
    tool_calls: {},
    files_written_via_tools: [],
    last_commands: [],
    last_assistant_text_tail: null,
    token_usage_lower_bound: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
});

test('上限：命令只留最后 10 条且每条截到 200 字符，文件清单封顶 80，文本只留尾部 1200', (t) => {
  const dir = makeDir(t);
  const commands = Array.from({ length: 12 }, (_, i) => toolUse('Bash', { command: `cmd-${String(i).padStart(2, '0')}` }));
  const writes = Array.from({ length: 100 }, (_, i) => toolUse('Write', { file_path: `/w/f-${String(i).padStart(3, '0')}` }));
  const longText = '尾'.repeat(2000);
  const p = writeStream(dir, [
    assistant([...commands, toolUse('Bash', { command: 'x'.repeat(300) })]),
    assistant(writes),
    assistant([textBlock(longText)]),
  ]);

  const o = observeStream(p);
  assert.equal(o.last_commands.length, 10);
  assert.deepEqual(o.last_commands.slice(0, 2), ['cmd-03', 'cmd-04'], '留的是最后 10 条（最早的被丢掉）');
  assert.equal(o.last_commands.at(-1), 'x'.repeat(200), '单条命令截到 200 字符：salvage 不能被一条超长命令撑爆');
  assert.equal(o.tool_calls.Bash, 13, '截断只影响留存内容，计数仍是全量');

  assert.equal(o.files_written_via_tools.length, FILES_MAX);
  assert.equal(o.files_written_via_tools[0], '/w/f-000');
  assert.equal(o.files_written_via_tools.at(-1), `/w/f-${String(FILES_MAX - 1).padStart(3, '0')}`, '文件清单留的是最早的 80 个');

  assert.equal(o.last_assistant_text_tail.length, TEXT_TAIL);
  assert.equal(o.last_assistant_text_tail, longText.slice(-TEXT_TAIL));
});

test('result 事件：以最后一条为准；没有 subtype 记 null', (t) => {
  const dir = makeDir(t);
  const last = observeStream(writeStream(dir, [
    { type: 'result', subtype: 'success', session_id: 'sess-A' },
    { type: 'result', subtype: 'error_max_turns', session_id: 'sess-A' },
  ], 'two-results.jsonl'));
  assert.equal(last.result_subtype, 'error_max_turns');

  const none = observeStream(writeStream(dir, [{ type: 'result', session_id: 'sess-A' }], 'no-subtype.jsonl'));
  assert.equal(none.result_subtype, null, '没写就是 null，不许猜成 success');
});

test('writeSalvage：永远不写 outcome，永远列出 unknown；落盘内容与返回值一致', (t) => {
  const dir = makeDir(t);
  const stream = writeStream(dir, [
    { type: 'system', subtype: 'init', session_id: 'sess-A' },
    assistant([toolUse('Bash', { command: 'npm test' }), textBlock('改完了一半')], { input_tokens: 11, output_tokens: 2 }),
    { type: 'result', subtype: 'error_max_turns' },
  ]);
  const out = path.join(dir, 'maker-r3.salvage.json');
  const known = { committed_to: 'conductor/task-20260917-001', note: '改动已提交；完成度未知' };

  const salvage = writeSalvage(out, { role: 'maker', round: 3, reason: 'truncated', streamFile: stream, known });

  // 这一条是整个模块存在的理由：没有合格 log 就没有完成信号，内核不替 agent 盖章。
  assert.equal('outcome' in salvage, false);
  assert.equal(/"outcome"/.test(fs.readFileSync(out, 'utf8')), false, '落盘文本里也不许出现 outcome 键');

  assert.equal(salvage.schema_version, 1);
  assert.equal(salvage.written_by, 'kernel');
  assert.equal(salvage.role, 'maker');
  assert.equal(salvage.round, 3);
  assert.equal(salvage.key, null, 'key 缺省为 null（非委派角色没有 key）');
  assert.equal(salvage.reason, 'truncated');
  assert.deepEqual(salvage.known, known, '调用方给的执行器事实原样保留');
  assert.deepEqual(salvage.observed, observeStream(stream), 'observed 就是原始流的观察结果');
  assert.equal(salvage.observed.session_id, 'sess-A');
  assert.equal(Number.isNaN(Date.parse(salvage.written_at)), false);

  // truncated：只有「完成度未知」与「费用未知」两条。
  assert.equal(salvage.unknown.length, 2);
  assert.match(salvage.unknown[0], /outcome 未知/);
  assert.match(salvage.unknown.at(-1), /费用/);

  const onDisk = fs.readFileSync(out, 'utf8');
  assert.equal(onDisk.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(onDisk), salvage, '返回值与落盘必须一致：下游读的是文件');
});

test('writeSalvage：reason 决定额外的 unknown —— 被中断的那次工具调用是否生效，只有 interrupted / runner_crashed 才列', (t) => {
  const dir = makeDir(t);
  const stream = writeStream(dir, [assistant([toolUse('Write', { file_path: '/w/a.mjs' })])]);
  const run = (reason) => writeSalvage(path.join(dir, `${reason}.salvage.json`), {
    role: 'worker', key: 'api', round: 5, reason, streamFile: stream, known: {},
  });

  for (const reason of ['interrupted', 'runner_crashed']) {
    const s = run(reason);
    assert.equal(s.unknown.length, 3, `${reason} 应多一条「那次工具调用是否生效」`);
    assert.equal(s.unknown.some((u) => /被中断那一刻/.test(u)), true);
    assert.equal(s.key, 'api', '委派角色的 key 必须留在 salvage 里，否则对不上是哪一路 worker');
  }
  for (const reason of ['truncated', 'log_missing', 'log_invalid']) {
    const s = run(reason);
    assert.equal(s.unknown.length, 2, `${reason} 不该凭空多列未知`);
    assert.equal(s.unknown.some((u) => /被中断那一刻/.test(u)), false);
  }
});

test('writeSalvage：原始流缺失 → observed=null，并明说「连调用过哪些工具都无从得知」', (t) => {
  const dir = makeDir(t);
  const missing = path.join(dir, '没落盘.stream.jsonl');

  const s = writeSalvage(path.join(dir, 'a.salvage.json'), {
    role: 'maker', round: 1, reason: 'log_missing', streamFile: missing, known: { process_at_recovery: 'dead' },
  });
  assert.equal(s.observed, null, '流缺失要如实记 null，不能编一份空观察冒充「什么都没干」');
  assert.equal(s.unknown.length, 3);
  assert.equal(s.unknown.some((u) => /原始流缺失/.test(u)), true);
  assert.equal('outcome' in s, false);

  // 流缺失 + 崩溃：两条额外未知同时出现（4 条），且顺序固定：完成度 → 流缺失 → 中断 → 费用。
  const crashed = writeSalvage(path.join(dir, 'b.salvage.json'), {
    role: 'maker', round: 1, reason: 'runner_crashed', streamFile: missing, known: {},
  });
  assert.equal(crashed.unknown.length, 4);
  assert.match(crashed.unknown[0], /outcome 未知/);
  assert.match(crashed.unknown[1], /原始流缺失/);
  assert.match(crashed.unknown[2], /被中断那一刻/);
  assert.match(crashed.unknown[3], /费用/);
});
