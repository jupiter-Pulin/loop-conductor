// 单元：setup-profile.json 的 precommit 段（AC-019 的裁判面 + unit 回落）。
// precommit 各步命令是人手写的产物，内核唯一的权力是「读得对」与「拒得清楚」：
// 缺配置时 `new` 必须把包含全部键的样例打给人，而不是自己编一条命令跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readPrecommitProfile, validatePrecommitProfile, PRECOMMIT_PROFILE_SAMPLE, PRECOMMIT_TIERS,
} from '../../conductor/lib/profile.mjs';

const FULL = {
  precommit: {
    build: 'npm run build',
    service: { start: 'npm start', ready: { url: 'http://127.0.0.1:3000/health' } },
    unit: 'npm test',
    integration: 'npm run test:integration',
    e2e: 'npm run test:e2e',
  },
};

test('readPrecommitProfile：全配时逐键读出', () => {
  const p = readPrecommitProfile(FULL, { testCommand: 'node --test' });
  assert.equal(p.build, 'npm run build');
  assert.equal(p.unit, 'npm test', 'precommit.unit 优先于 task.testCommand');
  assert.equal(p.unit_source, 'precommit.unit');
  assert.equal(p.integration, 'npm run test:integration');
  assert.equal(p.e2e, 'npm run test:e2e');
  assert.equal(p.service.start, 'npm start');
});

test('readPrecommitProfile：unit 缺省回落 task.testCommand', () => {
  const p = readPrecommitProfile({ precommit: { integration: 'x' } }, { testCommand: 'node --test' });
  assert.equal(p.unit, 'node --test');
  assert.equal(p.unit_source, 'task.testCommand');
});

test('readPrecommitProfile：没配的键一律 null（该步 skipped，不是错误）', () => {
  const p = readPrecommitProfile({ precommit: { unit: 'npm test' } }, null);
  assert.equal(p.build, null);
  assert.equal(p.service, null);
  assert.equal(p.integration, null);
  assert.equal(p.e2e, null);
  // profile 整体缺失也不抛错，只是全 null
  const empty = readPrecommitProfile(null, null);
  assert.deepEqual(
    { ...empty },
    { build: null, service: null, unit: null, integration: null, e2e: null, unit_source: null },
  );
});

test('readPrecommitProfile：空串与非字符串视同没配', () => {
  const p = readPrecommitProfile({ precommit: { build: '   ', unit: 42, service: [] } }, { testCommand: '' });
  assert.equal(p.build, null);
  assert.equal(p.unit, null, 'unit 非字符串且 testCommand 为空串 → 无命令');
  assert.equal(p.service, null, 'service 是数组不是对象 → 视同没配');
});

test('validatePrecommitProfile：全配通过', () => {
  const r = validatePrecommitProfile(FULL, { testCommand: 'node --test' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validatePrecommitProfile：profile 缺失 / 缺段 / 无 unit 三种拒绝（AC-019）', () => {
  assert.equal(validatePrecommitProfile(null, { testCommand: 'node --test' }).ok, false);
  const noSection = validatePrecommitProfile({ approved: true }, { testCommand: 'node --test' });
  assert.equal(noSection.ok, false);
  assert.match(noSection.errors.join('\n'), /缺 precommit 段/);
  const noUnit = validatePrecommitProfile({ precommit: { build: 'make' } }, {});
  assert.equal(noUnit.ok, false);
  assert.match(noUnit.errors.join('\n'), /precommit\.unit 与任务的 testCommand 皆缺/);
  // unit 缺但任务有 testCommand → 通过（回落是合法配置）
  assert.equal(validatePrecommitProfile({ precommit: { build: 'make' } }, { testCommand: 'node --test' }).ok, true);
});

test('validatePrecommitProfile：service 的 start 与 ready 二选一规则', () => {
  const bad = (service) => validatePrecommitProfile({ precommit: { unit: 'npm test', service } }, null);
  assert.match(bad({}).errors.join('\n'), /service\.start 必填/);
  assert.match(bad({ start: 'npm start' }).errors.join('\n'), /service\.ready 必填/);
  assert.match(
    bad({ start: 'npm start', ready: {} }).errors.join('\n'),
    /只能给 url 与 command 之一/,
    'ready 两个都不给即非法',
  );
  assert.match(
    bad({ start: 'npm start', ready: { url: 'http://x/h', command: 'curl -sf http://x/h' } }).errors.join('\n'),
    /只能给 url 与 command 之一/,
    'ready 两个都给也非法',
  );
  assert.match(bad({ start: 'npm start', ready: { url: 'not a url' } }).errors.join('\n'), /不是合法 URL/);
  // command 形态合法
  assert.equal(bad({ start: 'npm start', ready: { command: 'curl -sf http://127.0.0.1:3000/h' } }).ok, true);
});

test('validatePrecommitProfile：service 的超时与 env 形状', () => {
  const check = (service) => validatePrecommitProfile({ precommit: { unit: 'npm test', service } }, null);
  const base = { start: 'npm start', ready: { url: 'http://127.0.0.1:3000/h' } };
  assert.match(check({ ...base, ready_timeout_ms: 0 }).errors.join('\n'), /ready_timeout_ms 必须是正数毫秒/);
  assert.match(check({ ...base, stop_grace_ms: -1 }).errors.join('\n'), /stop_grace_ms 必须是正数毫秒/);
  assert.match(check({ ...base, env: { PORT: 3000 } }).errors.join('\n'), /env\.PORT 必须是字符串/);
  assert.equal(check({ ...base, ready_timeout_ms: 5000, stop_grace_ms: 1000, env: { PORT: '3000' } }).ok, true);
});

test('validatePrecommitProfile：配了但为空串的层级键被拒（比静默 skipped 更早暴露手误）', () => {
  const r = validatePrecommitProfile({ precommit: { unit: 'npm test', integration: '' } }, null);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /precommit\.integration 必须是非空字符串/);
});

test('样例文本含全部键并注明哪些可删（AC-019 的 stderr 内容）', () => {
  const sample = validatePrecommitProfile(null, null).sample;
  assert.equal(sample, PRECOMMIT_PROFILE_SAMPLE);
  for (const key of ['build', 'service', ...PRECOMMIT_TIERS]) {
    assert.match(sample, new RegExp(`"${key}"`), `样例缺 ${key} 键`);
  }
  assert.match(sample, /可删的键/);
  assert.match(sample, /必填的键/);
  assert.match(sample, /unit —— 缺省时回落任务的 testCommand/);
});
