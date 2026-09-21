// 单元：一次「运行」的持久账本（state/.run-session.json）与停止请求。
//
// runBudgetUsd 是人给**一次运行**的授权额度，不是给一个进程的。所以账本必须落在盘上：
//   - 上一次运行没收尾（崩溃 / 被 SIGKILL）→ 新进程**接管**那份账本，spent 原样带过来、
//     adopted_count 记一笔，并且 cfg.__runBudget.spent 必须从账本初始化。这一条是拦住
//     「崩溃—重启—崩溃」循环的唯一闸门：只要它被重置回 0，同一笔额度就能被花 N 遍；
//   - 上一次运行正常收尾（人看到了结果）→ 再次 run 才是一次新授权，必须开新账本、从 0 起算。
// 停止请求同理：盘上的 .stop 是 `conductor stop` 与 runner 之间唯一的通道，读不动也不能被吞掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearStopRequest, closeRunSession, noteBatch, openRunSession, readRunSession, readStopRequest,
  requestStop, runSessionFile, stopFile, stopRequested, syncRunSessionCost,
} from '../../conductor/lib/run-session.mjs';
import { addRunCost, canStartSpawn } from '../../conductor/lib/scheduler.mjs';
import { pidStartTime } from '../../conductor/lib/proc.mjs';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-session-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * 一个「runner 进程」的 cfg。同一个 root 建出来的两份 cfg 就是崩溃前后的两个 runner：
 * 它们之间除了盘上的账本什么都不共享——这正是恢复语义要求的。
 */
function makeCfg(root, over = {}) {
  return {
    root,
    stateDir: path.join(root, 'state'),
    dossierDir: path.join(root, 'dossier'),
    runBudgetUsd: 10,
    ...over,
  };
}

test('runSessionFile / stopFile：两个盘上位置是唯一构造点', (t) => {
  const cfg = makeCfg(makeRoot(t));
  assert.equal(runSessionFile(cfg), path.join(cfg.stateDir, '.run-session.json'));
  assert.equal(stopFile(cfg), path.join(cfg.stateDir, '.stop'));
});

test('openRunSession：全新运行开新账本，字段与 __runBudget 一起立起来', (t) => {
  const cfg = makeCfg(makeRoot(t), { runBudgetUsd: 7.5 });
  const { session, adopted } = openRunSession(cfg, { mode: 'continuous' });

  assert.equal(adopted, false, '盘上没有账本时不可能是「接管」');
  assert.equal(session.schema_version, 1);
  assert.match(session.session_id, /^[0-9a-f-]{36}$/);
  assert.ok(session.started_at);
  assert.equal(session.mode, 'continuous');
  assert.equal(session.limit_usd, 7.5);
  assert.equal(session.spent_usd, 0);
  assert.equal(session.batches, 0);
  assert.equal(session.adopted_count, 0);
  assert.equal(session.ended_at, null, '没收尾的账本 ended_at 必须是 null——它就是「可接管」的判据');
  assert.equal(session.end_reason, null);
  // 身份写进账本：恢复与锁靠 pid + 启动时刻判断「那个 runner 还在不在」。
  assert.equal(session.pid, process.pid);
  assert.equal(session.pid_started, pidStartTime(process.pid));

  assert.equal(cfg.__runSession, session, '内存账本就是返回的这一份，不是副本');
  assert.deepEqual(cfg.__runBudget, { spent: 0, announced: false, limit: 7.5 });
  assert.deepEqual(readRunSession(cfg), session, '开账本这一刻就要落盘：下一秒崩了也认得出来');
});

test('openRunSession：接管没收尾的账本——spent 原样带过来，adopted_count +1，预算不归零', (t) => {
  const root = makeRoot(t);
  const crashed = makeCfg(root, { runBudgetUsd: 5 });
  const first = openRunSession(crashed, { mode: 'continuous' }).session;
  crashed.__runBudget.spent = 3.25;
  syncRunSessionCost(crashed);
  noteBatch(crashed);
  noteBatch(crashed);
  assert.equal(readRunSession(crashed).ended_at, null, 'runner 在这里被 SIGKILL：账本停在没收尾的状态');

  // 把账本里的身份改成「上一个进程」的：接管后必须换成本进程的身份，否则后续恢复与锁
  // 会拿一个早已不存在的 pid 去判断「这次运行还有人在推进吗」。
  fs.writeFileSync(
    runSessionFile(crashed),
    `${JSON.stringify({ ...readRunSession(crashed), pid: 424242, pid_started: 'Mon Jan  1 00:00:00 2001' }, null, 2)}\n`,
  );

  const restarted = makeCfg(root, { runBudgetUsd: 4 }); // 人重启时改了配置：限额以新的为准
  const { session, adopted } = openRunSession(restarted, { mode: 'watch' });

  assert.equal(adopted, true);
  assert.equal(session.session_id, first.session_id, '接管的是同一次运行，不是新授权');
  assert.equal(session.started_at, first.started_at, '起始时刻属于那次运行，不能被重启抹掉');
  assert.equal(session.spent_usd, 3.25);
  assert.equal(session.batches, 2, '批次计数一并带过来');
  assert.equal(session.adopted_count, 1);
  assert.ok(session.adopted_at, '接管时刻要留痕：人得看得出这次运行被接管过几次');
  assert.equal(session.mode, 'watch', 'mode 以本次进程为准');
  assert.equal(session.limit_usd, 4);
  assert.equal(session.ended_at, null);
  assert.equal(session.pid, process.pid);
  assert.equal(session.pid_started, pidStartTime(process.pid));
  assert.equal(
    restarted.__runBudget.spent, 3.25,
    '核心不变量：崩溃重启绝不能把已花金额洗回 0，否则一次授权能被花 N 遍',
  );
  assert.equal(restarted.__runBudget.limit, 4);
  assert.equal(restarted.__runBudget.announced, false);
  assert.deepEqual(readRunSession(restarted), session, '接管也要立刻落盘');

  // 连崩两次：接管次数继续累加，金额继续往上带，不会因为「又是新进程」而清零。
  const again = makeCfg(root, { runBudgetUsd: 4 });
  const third = openRunSession(again, { mode: 'watch' });
  assert.equal(third.adopted, true);
  assert.equal(third.session.adopted_count, 2);
  assert.equal(third.session.session_id, first.session_id);
  assert.equal(again.__runBudget.spent, 3.25);
});

test('openRunSession：接管后 addRunCost 从旧金额接着加，额度用尽的闸门照样关着', (t) => {
  const root = makeRoot(t);
  const ts = { id: 'task-20260920-001', runtime: {} };

  const crashed = makeCfg(root, { runBudgetUsd: 1 });
  openRunSession(crashed, { mode: 'continuous' });
  addRunCost(crashed, 0.4);
  addRunCost(crashed, 0.35);
  assert.equal(crashed.__runBudget.spent, 0.75, '浮点误差被 1e6 归一吃掉');
  assert.equal(readRunSession(crashed).spent_usd, 0.75, 'addRunCost 每笔都同步落盘：崩溃时不丢账');
  assert.equal(canStartSpawn(ts, crashed, 'maker'), true, '0.75 < 1：还能派');

  // runner 崩了又被拉起来：接管账本，从 0.75 接着花。
  const restarted = makeCfg(root, { runBudgetUsd: 1 });
  assert.equal(openRunSession(restarted, { mode: 'continuous' }).adopted, true);
  assert.equal(restarted.__runBudget.spent, 0.75);
  addRunCost(restarted, 0.3);
  assert.equal(restarted.__runBudget.spent, 1.05);

  // 额度已用尽：新进程一样不许再派 spawn（否则崩溃循环 = 无限额度）。
  const errs = [];
  const orig = console.error;
  console.error = (...args) => errs.push(args.join(' '));
  try {
    assert.equal(canStartSpawn(ts, restarted, 'maker'), false);
    assert.equal(canStartSpawn(ts, restarted, 'reviewer'), false);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1, '限额只播报一次（announced 闩），但闸门每次都关');
  assert.match(errs[0], /runBudgetUsd=\$1 已达到/);
  assert.match(errs[0], /1\.05/);
  const timeline = fs.readFileSync(path.join(root, 'dossier', ts.id, 'timeline.md'), 'utf8');
  assert.match(timeline, /runBudgetUsd reached \(\$1\.05 >= \$1\)/);
});

test('openRunSession：账本已收尾 → 开新账本（人再次 run 才是一次新授权）', (t) => {
  const root = makeRoot(t);
  const cfg1 = makeCfg(root);
  const first = openRunSession(cfg1, { mode: 'once' }).session;
  cfg1.__runBudget.spent = 2;
  syncRunSessionCost(cfg1);
  closeRunSession(cfg1, 'idle');
  const closed = readRunSession(cfg1);
  assert.ok(closed.ended_at);
  assert.equal(closed.end_reason, 'idle');

  const cfg2 = makeCfg(root);
  const { session, adopted } = openRunSession(cfg2, { mode: 'once' });
  assert.equal(adopted, false, 'ended_at 有值 = 那次运行已经交代过了，不该被接管');
  assert.notEqual(session.session_id, first.session_id);
  assert.equal(session.spent_usd, 0);
  assert.equal(session.adopted_count, 0);
  assert.equal(session.ended_at, null);
  assert.equal(cfg2.__runBudget.spent, 0, '新授权从 0 起算');
});

test('openRunSession：账本缺失 / 坏 JSON 按全新起算；已花金额读不出来则 fail closed（按额度已用尽），绝不静默归零', (t) => {
  const root = makeRoot(t);
  const cfg = makeCfg(root);

  // 坏 JSON：读不出来就当没有，绝不让一个手改坏的文件把 run 顶死在启动。
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(runSessionFile(cfg), '{ 这不是 JSON\n');
  const broken = openRunSession(cfg, { mode: 'once' });
  assert.equal(broken.adopted, false);
  assert.equal(cfg.__runBudget.spent, 0);

  // 未收尾的账本上 spent_usd 被改成非数字：当成 0 等于一次静默的额度重置。
  // 有额度上限 → 按「已用尽」处理并打标记；没有上限 → 0（没有闸可绕）。两种都不得是 NaN。
  const corrupt = () => fs.writeFileSync(
    runSessionFile(cfg),
    `${JSON.stringify({ ...broken.session, spent_usd: 'oops', ended_at: null }, null, 2)}\n`,
  );
  corrupt();
  const limited = { ...makeCfg(root), runBudgetUsd: 2 };
  const adoptedBad = openRunSession(limited, { mode: 'once' });
  assert.equal(adoptedBad.adopted, true);
  assert.equal(adoptedBad.session.ledger_corrupt, true);
  assert.equal(limited.__runBudget.spent, 2, '读不出来的金额按额度已用尽处理');

  corrupt();
  const unlimited = makeCfg(root, { runBudgetUsd: null });
  openRunSession(unlimited, { mode: 'once' });
  assert.equal(unlimited.__runBudget.spent, 0);
  assert.ok(Number.isFinite(unlimited.__runBudget.spent));
});

test('openRunSession：runBudgetUsd 不是数字 = 没有限额，不是零额度', (t) => {
  const root = makeRoot(t);
  for (const bad of [undefined, null, '5', Number.NaN]) {
    const cfg = makeCfg(root, { runBudgetUsd: bad });
    fs.rmSync(runSessionFile(cfg), { force: true });
    const { session } = openRunSession(cfg, { mode: 'once' });
    if (Number.isNaN(bad)) {
      // NaN 是 number：如实写进账本，由 canStartSpawn 的比较去兜（NaN 比较恒 false = 只放行）。
      assert.ok(Number.isNaN(session.limit_usd));
    } else {
      assert.equal(session.limit_usd, null, `runBudgetUsd=${String(bad)} 应视为无限额`);
      assert.equal(cfg.__runBudget.limit, null);
      assert.equal(canStartSpawn({ id: 'task-20260920-001', runtime: {} }, cfg, 'maker'), true);
    }
  }
});

test('syncRunSessionCost / noteBatch / closeRunSession：入账即落盘；没有账本时一律 no-op', (t) => {
  const cfg = makeCfg(makeRoot(t));
  openRunSession(cfg, { mode: 'once' });

  cfg.__runBudget.spent = 1.5;
  syncRunSessionCost(cfg);
  assert.equal(readRunSession(cfg).spent_usd, 1.5, '同步的是内存预算的当前值，不是自己再算一遍');

  noteBatch(cfg);
  const afterBatch = readRunSession(cfg);
  assert.equal(afterBatch.batches, 1);
  assert.ok(afterBatch.last_batch_at);

  closeRunSession(cfg); // 不给理由就是 finished
  assert.equal(readRunSession(cfg).end_reason, 'finished');

  // 没开账本的 cfg（`conductor status` 之类的只读路径）调这几个函数必须是纯 no-op。
  const bare = makeCfg(makeRoot(t));
  syncRunSessionCost(bare);
  noteBatch(bare);
  closeRunSession(bare, 'whatever');
  assert.equal(readRunSession(bare), null, '没有账本就不该凭空造一份出来');
  // 有账本没预算表（还没进调度）时 syncRunSessionCost 也不能乱写。
  bare.__runSession = { spent_usd: 9 };
  syncRunSessionCost(bare);
  assert.equal(bare.__runSession.spent_usd, 9);
});

test('账本写不进去不拖垮 run，但停止请求写不进去必须报错', (t) => {
  const root = makeRoot(t);
  fs.writeFileSync(path.join(root, 'blocked'), '这是个文件，不是目录\n');
  const cfg = makeCfg(root, { stateDir: path.join(root, 'blocked', 'state') });

  // 落盘失败被吞：账本是观测/恢复面，写不进去下次再写，绝不因此让整次 run 起不来。
  const { session, adopted } = openRunSession(cfg, { mode: 'once' });
  assert.equal(adopted, false);
  assert.ok(session.session_id);
  assert.equal(readRunSession(cfg), null, '确实没写进去');
  cfg.__runBudget.spent = 1;
  syncRunSessionCost(cfg);
  noteBatch(cfg);
  closeRunSession(cfg, 'idle');
  assert.equal(cfg.__runSession.end_reason, 'idle', '内存账本照常推进');

  // 停止请求不是 best-effort：写不进去就该抛，绝不能让人以为「已经让它停了」。
  assert.throws(() => requestStop(cfg, { reason: 'conductor stop' }));
  assert.equal(stopRequested(cfg), false);
});

test('requestStop / readStopRequest / stopRequested / clearStopRequest：盘上停止请求的一个来回', (t) => {
  const cfg = makeCfg(makeRoot(t));
  assert.equal(stopRequested(cfg), false, 'stateDir 还没建出来时也只是「没人要求停」');
  assert.equal(readStopRequest(cfg), null);

  requestStop(cfg, { reason: '人按了 ctrl-c 之外的路', now: true });
  const req = readStopRequest(cfg);
  assert.equal(req.reason, '人按了 ctrl-c 之外的路');
  assert.equal(req.now, true);
  assert.equal(req.by_pid, process.pid, '谁要求停的要留痕');
  assert.ok(req.requested_at);

  assert.equal(stopRequested(cfg), true);
  assert.equal(cfg.__stop.reason, '人按了 ctrl-c 之外的路', '命中后缓存进内存：后续每步不必再读盘');

  clearStopRequest(cfg);
  assert.equal(fs.existsSync(stopFile(cfg)), false);
  assert.equal(cfg.__stop, undefined);
  assert.equal(stopRequested(cfg), false);

  // 默认参数：`conductor stop` 不带 --now。
  requestStop(cfg);
  assert.deepEqual(
    { reason: readStopRequest(cfg).reason, now: readStopRequest(cfg).now },
    { reason: 'conductor stop', now: false },
  );
});

test('stopRequested：内存信号标记优先；停止文件坏掉也不许把停止请求吞掉', (t) => {
  const cfg = makeCfg(makeRoot(t));

  // SIGINT / SIGTERM 只在内存里插旗，没有盘上文件——一样必须停。
  cfg.__stop = { reason: 'SIGINT' };
  assert.equal(stopRequested(cfg), true);
  delete cfg.__stop;

  // 文件在但内容读不动：停止意图仍然成立（宁可多停一次，绝不把「停」读丢）。
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(stopFile(cfg), '半行被截断的 JSON');
  assert.equal(stopRequested(cfg), true);
  assert.deepEqual(cfg.__stop, { reason: 'stop file' }, '解析不出理由就给一个兜底理由，而不是 null');

  // 没有 stateDir 的 cfg / 空对象 / null 都只是「没人要求停」，不该抛。
  assert.equal(stopRequested({}), false);
  assert.equal(stopRequested(null), false);
  assert.equal(stopRequested(undefined), false);
});

test('clearStopRequest：清两次不抛，且把内存标记一并清掉', (t) => {
  const cfg = makeCfg(makeRoot(t));
  requestStop(cfg, { reason: '上一次运行的遗留请求' });
  assert.equal(stopRequested(cfg), true);

  clearStopRequest(cfg);
  clearStopRequest(cfg); // 幂等：run 启动时无条件清一次，那时通常本来就没有
  assert.equal(fs.existsSync(stopFile(cfg)), false);
  assert.equal('__stop' in cfg, false, '只删文件不删内存标记的话，新 runner 一起来就自认被停了');
  assert.equal(stopRequested(cfg), false);

  // 目录都不存在时也不能抛（`conductor run` 的第一步就是它）。
  const virgin = makeCfg(makeRoot(t));
  clearStopRequest(virgin);
  assert.equal(stopRequested(virgin), false);
});
