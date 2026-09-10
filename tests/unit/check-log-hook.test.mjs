// 单元：check-log Stop hook（AC-008）。会话内多一轮近乎免费，冷重派是完整一轮的钱——
// 这个 hook 存在的全部理由就是把「log 写歪了」在会话内改掉。
// 纪律：不合格 exit 2（stderr 喂回模型），stop_hook_active=true 只拦一次即放行，
// 无论结果都写 <role>[-P-xxx]-r<n>.log.hook.json 留证。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK_LOG = path.resolve(HERE, '..', '..', 'conductor', 'hooks', 'check-log.mjs');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runHook(args, stdinObj) {
  return spawnSync(process.execPath, [CHECK_LOG, ...args], {
    encoding: 'utf8',
    input: stdinObj == null ? '' : JSON.stringify(stdinObj),
  });
}

/** 写一份 log 并跑 hook，返回 { r, report, logPath, reportPath }。 */
function scenario(t, { role = 'maker', content, args = [], stdin = {} } = {}) {
  const dir = tmpdir(t);
  const logPath = path.join(dir, `${role}-r1.log.json`);
  const reportPath = path.join(dir, `${role}-r1.log.hook.json`);
  if (content !== undefined) fs.writeFileSync(logPath, content);
  const r = runHook(['--log', logPath, '--role', role, '--report', reportPath, ...args], stdin);
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
  return { r, report, logPath, reportPath };
}

const GOOD_MAKER = JSON.stringify({ role: 'maker', outcome: 'ok', summary: 'AC-001..004 done；npm test 41/41 绿' });

test('AC-008: 合法 log → exit 0，报告 ok=true / blocked=false', (t) => {
  const { r, report } = scenario(t, { content: GOOD_MAKER });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(report.ok, true);
  assert.equal(report.blocked, false);
  assert.deepEqual(report.errors, []);
  assert.equal(report.role, 'maker');
  assert.equal(report.source, 'stop-hook');
});

test('AC-008: log 文件缺失 → exit 2，stderr 指路，报告仍落盘', (t) => {
  const { r, report } = scenario(t, { content: undefined });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /log 文件不存在/);
  assert.match(r.stderr, /用 Write 工具/);
  assert.equal(report.ok, false);
  assert.equal(report.blocked, true);
});

test('AC-008: JSON 非法 / 不合 schema → exit 2 且 stderr 列出错误', (t) => {
  const broken = scenario(t, { content: '{ not json' });
  assert.equal(broken.r.status, 2);
  assert.match(broken.r.stderr, /不是合法 JSON/);

  const badSchema = scenario(t, { content: JSON.stringify({ role: 'maker', outcome: 'ok' }) });
  assert.equal(badSchema.r.status, 2);
  assert.match(badSchema.r.stderr, /summary/);
  assert.ok(badSchema.report.errors.length > 0);
});

test('AC-008: stop_hook_active=true → exit 0（只拦一次），报告标注 blocked=false', (t) => {
  const { r, report } = scenario(t, { content: '{ not json', stdin: { stop_hook_active: true, session_id: 's-1' } });
  assert.equal(r.status, 0, '第二次 stop 必须放行，避免 Stop hook 死循环');
  assert.equal(report.ok, false, '放行不等于合格');
  assert.equal(report.blocked, false);
  assert.equal(report.stop_hook_active, true);
  assert.equal(report.session_id, 's-1');
});

test('AC-008: --role 决定角色规则；router 的 action/tier 受同一份契约管', (t) => {
  const noAction = scenario(t, {
    role: 'router',
    content: JSON.stringify({ role: 'router', outcome: 'ok', summary: '继续' }),
  });
  assert.equal(noAction.r.status, 2);
  assert.match(noAction.r.stderr, /action 必填/);

  const good = scenario(t, {
    role: 'router',
    content: JSON.stringify({ role: 'router', outcome: 'ok', action: 'precommit', tier: 'unit', summary: '跑回归' }),
  });
  assert.equal(good.r.status, 0, good.r.stderr);
});

test('AC-008: --has-plan 打开 packages 规则（缺省关闭）', (t) => {
  const withPackages = JSON.stringify({
    role: 'router', outcome: 'ok', action: 'maker', packages: ['P-001'], summary: '先做 P-001',
  });
  const noPlan = scenario(t, { role: 'router', content: withPackages });
  assert.equal(noPlan.r.status, 2, '无方案任务出现 packages 即非法');
  assert.match(noPlan.r.stderr, /无生效方案/);

  const hasPlan = scenario(t, { role: 'router', content: withPackages, args: ['--has-plan'] });
  assert.equal(hasPlan.r.status, 0, hasPlan.r.stderr);
  assert.equal(hasPlan.report.has_plan, true);
});

test('AC-008: 缺 --log / --role（hook 配置错误）放行，交给内核读取时判定', (t) => {
  const dir = tmpdir(t);
  const noRole = runHook(['--log', path.join(dir, 'x.log.json')], {});
  assert.equal(noRole.status, 0);
  assert.match(noRole.stderr, /hook 配置错误/);
  const noLog = runHook(['--role', 'maker'], {});
  assert.equal(noLog.status, 0);
});

test('AC-008: 报告文件名与 log 同名不同后缀，含包段时一并带上', (t) => {
  const dir = tmpdir(t);
  const logPath = path.join(dir, 'maker-P-001-r2.log.json');
  const reportPath = path.join(dir, 'maker-P-001-r2.log.hook.json');
  fs.writeFileSync(logPath, GOOD_MAKER);
  const r = runHook(['--log', logPath, '--role', 'maker', '--report', reportPath], {});
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.log_path, logPath);
  assert.ok(Date.parse(report.checked_at) > 0);
});
