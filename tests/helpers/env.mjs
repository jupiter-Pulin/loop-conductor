// 集成测试环境：临时根目录（独立 config/state/target）+ fake-claude 注入 + conductor 子进程驱动。
// 新布局：任务目录 state/<box>/<id>/{task.json,runtime.json,spec.md}（字段 maker_miss_count/verifier_invalid_count）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initTargetRepo, initTargetRepoWithTrackedHarness } from './target-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const CONDUCTOR = path.join(REPO_ROOT, 'conductor', 'conductor.mjs');
export const FAKE_CLAUDE = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-claude.mjs');

const AGENT_STUBS = {
  'setup-agent.md': '# setup stub\n',
  'feasibility-agent.md': '# feasibility stub\n',
  'spec-agent.md': '# spec stub\n',
  'spec-verifier-agent.md': '# spec verifier stub\n',
  'maker-agent.md': '# maker stub\n',
  'verifier-agent.md': '# verifier stub\n',
  'committer-agent.md': '# committer stub\n',
};

function setupProfileKey(targetRepo) {
  const repo = path.resolve(targetRepo);
  const safe = String(path.basename(repo)).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  const hash = crypto.createHash('sha1').update(repo).digest('hex').slice(0, 12);
  return `${safe}-${hash}`;
}

// bugfix spec.md 草稿默认含 median 两条验收标准 → 抽取出 AC-001 / AC-002。
export const DEFAULT_BUGFIX_SPEC = [
  '# median 偶数分支返回错误',
  '',
  '## 验收标准',
  '',
  '- AC-001 median 偶数长度取中间两数平均',
  '- AC-002 `node --test` 全绿',
  '',
].join('\n');

/** fake-claude 的版本字符串（模型探测缓存键的一半）。每进程只探一次。 */
let fakeClaudeVersion = null;
function detectFakeClaudeVersion() {
  if (fakeClaudeVersion == null) {
    const r = spawnSync(process.execPath, [FAKE_CLAUDE, '--version'], { encoding: 'utf8' });
    fakeClaudeVersion = String(r.stdout ?? '').trim().split('\n')[0].trim() || 'unknown';
  }
  return fakeClaudeVersion;
}

/**
 * 预填模型可用性缓存：默认模型（claude-opus-5）在测试里恒可用，`run` 不该为它多起一次
 * 探测 spawn 而把剧本步骤全部错位。要测 AC-052 的终止路径时，配一个没预填的模型 id 即可。
 */
function seedModelProbeCache(root, models) {
  const version = detectFakeClaudeVersion();
  const entries = {};
  for (const m of models) {
    entries[`${m}@${version}`] = { ok: true, model: m, claude_version: version, checked_at: '2026-01-01T00:00:00.000Z' };
  }
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'state', '.model-probe.json'),
    `${JSON.stringify({ schema_version: 1, entries }, null, 2)}\n`,
  );
}

/** 把仓库里真实的 agents/next（新四角色 prompt + few-shot）复制进临时根，让 prompt 拼装是真的。 */
function copyNextAgents(root) {
  const src = path.join(REPO_ROOT, 'agents', 'next');
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, path.join(root, 'agents', 'next'), { recursive: true });
}

export function makeEnv(t, {
  config = {},
  trackedHarness = false,
  // 缺省把「默认模型 + 本测试配置里出现的每个模型 id」都预填成可用：否则 run 启动的探测会
  // 多消费一个剧本步骤，把整条剧本错位。要测探测本身的测试显式传 seedModels 指定预填集合。
  seedModels = ['claude-opus-5', ...Object.values(config.models ?? {}).filter((m) => typeof m === 'string' && m.trim() !== '')],
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-it-'));
  for (const d of ['state/queue', 'state/done', 'state/failed', 'specs', 'dossier', 'worktrees', 'agents', 'target-profiles']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const [name, content] of Object.entries(AGENT_STUBS)) {
    fs.writeFileSync(path.join(root, 'agents', name), content);
  }
  copyNextAgents(root);
  seedModelProbeCache(root, seedModels);
  // config 默认含 baseBranch:'main'（target fixture 用 main 建仓），可由 config 覆盖。
  const fullConfig = {
    budgetUsd: 5,
    maxTurns: 30,
    testCommand: 'node --test',
    targetRepo: './target',
    baseBranch: 'main',
    ...config,
  };
  fs.writeFileSync(
    path.join(root, 'conductor.config.json'),
    `${JSON.stringify(fullConfig, null, 2)}\n`,
  );
  // 允许测试预先把 target 仓库换成「已追踪 harness」变体（tracked-conflict 用，AC-016）。
  if (trackedHarness) {
    initTargetRepoWithTrackedHarness(path.join(root, 'target'));
  } else {
    initTargetRepo(path.join(root, 'target'));
  }

  const scenarioPath = path.join(root, 'fake-claude.scenario.json');
  const logPath = path.join(root, 'fake-claude.log');

  const queueDir = path.join(root, 'state', 'queue');

  const api = {
    root,
    scenarioPath,
    logPath,
    targetDir: path.join(root, 'target'),

    /** 覆写 conductor.config.json（merge 既有值）。 */
    writeConfig(patch) {
      const p = path.join(root, 'conductor.config.json');
      const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
      fs.writeFileSync(p, `${JSON.stringify({ ...cur, ...patch }, null, 2)}\n`);
    },

    /** 写 fake-claude 剧本；reset=true 时清零调用计数与日志。 */
    setScenario(steps, { reset = true } = {}) {
      fs.writeFileSync(scenarioPath, JSON.stringify(steps, null, 2));
      if (reset) {
        fs.rmSync(`${scenarioPath}.counter`, { force: true });
        fs.rmSync(logPath, { force: true });
      }
    },

    /**
     * 往剧本尾部追加步骤（不动调用计数）。多轮驱动的测试用它，别用 setScenario(..., {reset:false})：
     * 后者会把已消费的前缀一起覆盖掉，导致下一次调用落在数组外、fake-claude exit 2。
     */
    appendScenario(steps) {
      const cur = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
      fs.writeFileSync(scenarioPath, JSON.stringify([...cur, ...steps], null, 2));
    },

    /** 跑一次 conductor 子命令，返回 { status, stdout, stderr }。 */
    run(...args) {
      return api.runWithEnv({}, ...args);
    },

    /** 同 run，但可覆盖子进程环境变量（如 CLAUDE_BIN 指向坏二进制，模拟 spawn 层故障）。 */
    runWithEnv(overrides, ...args) {
      const env = {
        ...process.env,
        CONDUCTOR_ROOT: root,
        CLAUDE_BIN: FAKE_CLAUDE,
        FAKE_CLAUDE_SCRIPT: scenarioPath,
        FAKE_CLAUDE_LOG: logPath,
        ...overrides,
      };
      // 不能让外层 node:test 的 child 标记泄漏进 conductor：否则 green gate 的
      // `node --test` 会自认是 test-runner 子进程而恒 exit 0（红灯被吞）。
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(process.execPath, [CONDUCTOR, ...args], { encoding: 'utf8', env });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },

    /**
     * 直接落盘一个任务目录（绕过 new，便于构造特定前置状态）。
     * 字段一律新名：maker_miss_count / verifier_invalid_count。
     * bugfix（默认）写 spec.md 草稿（默认含 AC-001/AC-002 两条验收标准）。
     */
    writeTask(id, {
      kind = 'bugfix',
      stage = 'READY',
      miss = 0,
      invalid = 0,
      spent = 0,
      sessionId = null,
      approval = null,
      baseBranch = 'main',
      testCommand = 'node --test',
      currentRound = 0,
      lastFailureType = null,
      targetRepo = path.join(root, 'target'), // 任务级 targetRepo 快照；缺省与 cfg.targetRepo 一致
      bodyAc,        // 自定义 spec.md 草稿正文（含 ## 验收标准）；不给用默认
      specDraft,     // 直接给 spec.md 全文（优先于 bodyAc）
      gateCommands,  // 不传 = task.json 完全不含该字段（区别于显式空数组，AC-1/AC-5 靠这个区分）
    } = {}) {
      const dir = path.join(queueDir, id);
      fs.mkdirSync(dir, { recursive: true });
      const task = {
        schema_version: 1,
        id,
        kind,
        title: 'median 偶数分支返回错误',
        repo: path.basename(targetRepo),
        targetRepo,
        baseBranch,
        testCommand,
        ...(gateCommands !== undefined ? { gateCommands } : {}),
        created_at: '2026-06-11T00:00:00.000Z',
      };
      const runtime = {
        schema_version: 1,
        stage,
        maker_miss_count: miss,
        verifier_invalid_count: invalid,
        spent_usd: spent,
        approval,
        maker_session_id: sessionId,
        current_round: currentRound,
        last_failure_type: lastFailureType,
        updated_at: '2026-06-11T00:00:00.000Z',
      };
      fs.writeFileSync(path.join(dir, 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, 'runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`);
      if (kind === 'bugfix') {
        const draft = specDraft ?? bodyAc ?? DEFAULT_BUGFIX_SPEC;
        fs.writeFileSync(path.join(dir, 'spec.md'), draft);
      }
      return dir;
    },

    writeApprovedSetupProfile(markdown = '# Setup Profile\n\n- test: node --test\n', { targetRepo = path.join(root, 'target'), gateCommands, precommit } = {}) {
      const key = setupProfileKey(targetRepo);
      const dir = path.join(root, 'target-profiles', key);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'setup-profile.md'), markdown);
      fs.writeFileSync(path.join(dir, 'setup-profile.json'), `${JSON.stringify({
        schema_version: 1,
        profile_key: key,
        targetRepo,
        approved: true,
        approved_at: '2026-06-11T00:00:00.000Z',
        source_task_id: 'test',
        ...(gateCommands !== undefined ? { gateCommands } : {}),
        ...(precommit !== undefined ? { precommit } : {}),
      }, null, 2)}\n`);
      return dir;
    },

    /** 只写 setup-profile.json 的 precommit 段（新 `new` 的建单前置；不需要 approved 那一套）。 */
    writePrecommitProfile(precommit = { unit: 'node --test' }, { targetRepo = path.join(root, 'target') } = {}) {
      const key = setupProfileKey(targetRepo);
      const dir = path.join(root, 'target-profiles', key);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'setup-profile.json'), `${JSON.stringify({
        schema_version: 1, profile_key: key, targetRepo, approved: true, precommit,
      }, null, 2)}\n`);
      return dir;
    },

    /** 落盘一个 brief 文件，返回绝对路径（`new --brief <file>` 用）。 */
    writeBrief(content = '把 median 的偶数分支改成取中间两数平均。\n', name = 'brief.md') {
      const p = path.join(root, name);
      fs.writeFileSync(p, content);
      return p;
    },

    /**
     * 直接落盘一个新状态机任务（stage=ROUTING），绕过 `new`。
     * runtime 字段严格按 spec 列的那几个，便于断言「没有 miss / inval / epoch」。
     */
    writeRouterTask(id, {
      title = 'median 偶数分支返回错误',
      brief = '把 median 的偶数分支改成取中间两数平均，并补一条在旧代码上会失败的测试。\n',
      stage = 'ROUTING',
      baseBranch = 'main',
      testCommand = 'node --test',
      targetRepo = path.join(root, 'target'),
      specApproved = false,
      currentRound = 0,
      awaiting = null,
      spent = 0,
      lastFailureType = null,
      rateLimit = null,
    } = {}) {
      const dir = path.join(queueDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'task.json'), `${JSON.stringify({
        schema_version: 1, id, title, repo: path.basename(targetRepo), targetRepo, baseBranch, testCommand,
        created_at: '2026-09-10T00:00:00.000Z',
      }, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, 'runtime.json'), `${JSON.stringify({
        schema_version: 1,
        stage,
        current_round: currentRound,
        awaiting,
        spec_approved: specApproved,
        plan_active: false,
        plan_source: null,
        rate_limit: rateLimit,
        spent_usd: spent,
        last_failure_type: lastFailureType,
        updated_at: '2026-09-10T00:00:00.000Z',
      }, null, 2)}\n`);
      if (brief != null) fs.writeFileSync(path.join(dir, 'brief.md'), brief);
      return dir;
    },

    /** dossier/<id>/events.jsonl → 事件数组（文件不存在返回 []）。 */
    events(id) {
      const p = path.join(root, 'dossier', id, 'events.jsonl');
      if (!fs.existsSync(p)) return [];
      return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    },

    /** 编辑 queue 中某任务的 spec.md 草稿（bugfix 人类工作流：new 后填验收标准）。 */
    writeQueueSpec(id, content) {
      fs.writeFileSync(path.join(queueDir, id, 'spec.md'), content);
    },

    /** 在 queue/failed/done 三处找任务目录，返回 { box, dir, task, runtime } 或 null。 */
    findTask(id) {
      for (const box of ['queue', 'failed', 'done']) {
        const dir = path.join(root, 'state', box, id);
        if (fs.existsSync(path.join(dir, 'task.json'))) {
          const task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
          const runtime = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
          return { box, dir, task, runtime };
        }
      }
      return null;
    },

    /** 直接读某任务的 runtime.json（找不到抛错）。 */
    readRuntime(id) {
      const ts = api.findTask(id);
      if (!ts) throw new Error(`readRuntime: 找不到任务 ${id}`);
      return ts.runtime;
    },

    /** 直接读某任务的 task.json（找不到抛错）。 */
    readTaskJson(id) {
      const ts = api.findTask(id);
      if (!ts) throw new Error(`readTaskJson: 找不到任务 ${id}`);
      return ts.task;
    },

    /** 某任务 task.json 的原始字节（用于断言跨 stage byte 不变）。 */
    taskJsonBytes(id) {
      const ts = api.findTask(id);
      if (!ts) throw new Error(`taskJsonBytes: 找不到任务 ${id}`);
      return fs.readFileSync(path.join(ts.dir, 'task.json'));
    },

    /** fake-claude 调用日志（每行一个 JSON）。 */
    calls() {
      if (!fs.existsSync(logPath)) return [];
      return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },

    dossier(id, ...rest) {
      return path.join(root, 'dossier', id, ...rest);
    },

    worktree(id, ...rest) {
      return path.join(root, 'worktrees', id, ...rest);
    },

    readJson(p) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    },

    readFile(p) {
      return fs.readFileSync(p, 'utf8');
    },

    exists(p) {
      return fs.existsSync(p);
    },
  };

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return api;
}

/**
 * 并发计数探针（FAKE_CLAUDE_INFLIGHT_LOG）的读侧：同时在飞的 fake-claude 进程数峰值。
 * 相同毫秒上 end 先于 start 结算——宁可低估并发，也绝不把「首尾相接的串行」误报成并行。
 */
export function maxInFlight(logPath) {
  let raw;
  try { raw = fs.readFileSync(logPath, 'utf8'); } catch { return 0; }
  const events = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  events.sort((a, b) => (a.ms - b.ms) || (a.phase === 'end' ? -1 : 1) - (b.phase === 'end' ? -1 : 1));
  let cur = 0;
  let max = 0;
  for (const e of events) {
    if (e.phase === 'end') cur -= 1;
    else { cur += 1; max = Math.max(max, cur); }
  }
  return max;
}

/** 从 fake-claude 日志条目取 prompt 正文（经 stdin 传入，fake-claude 原样记录）。 */
export function promptOf(call) {
  return call.prompt ?? '';
}

/** 日志条目是否为 resume 调用（带 -r <sid>）。 */
export function resumeIdOf(call) {
  const i = call.argv.indexOf('-r');
  return i === -1 ? null : call.argv[i + 1];
}

// ---- per-AC verdict 构造助手：集成测试里 verifier 步骤一律返回新 schema ----

/** 一条结构化 evidence。 */
export function evidence(over = {}) {
  return {
    type: 'source',
    file: 'lib/stats.mjs',
    start_line: 8,
    end_line: 8,
    summary: '偶数分支取中间两数平均',
    ...over,
  };
}

/** 一条 criterion（默认 pass，带 1 条 evidence）。 */
export function criterion(acId, over = {}) {
  const status = over.status ?? 'pass';
  const base = {
    ac_id: acId,
    status,
    reason: `${acId} 裁决依据`,
    evidence: status === 'unknown' ? [] : [evidence()],
  };
  return { ...base, ...over };
}

/**
 * 构造 per-AC verdict 的严格 JSON 字符串（作为 verifier 的 result）。
 * acStatuses = { 'AC-001':'pass', 'AC-002':'fail' }；overall 自动推导（全 pass 才 pass）。
 */
export function verdictJson(round, acStatuses, { non_ac_findings = [] } = {}) {
  const criteria = Object.entries(acStatuses).map(([acId, status]) => criterion(acId, { status }));
  const overall = criteria.every((c) => c.status === 'pass') ? 'pass' : 'fail';
  return JSON.stringify({
    schema_version: 1,
    round,
    overall,
    criteria_results: criteria,
    non_ac_findings,
  });
}

/** verifier 步骤：返回合法 per-AC verdict（默认 AC-001/AC-002 全 pass）。 */
export function verifierStep(round, acStatuses = { 'AC-001': 'pass', 'AC-002': 'pass' }, { cost = 0.02, session_id } = {}) {
  return {
    ...(session_id ? { session_id } : {}),
    cost,
    result: verdictJson(round, acStatuses),
  };
}

export function specVerifierJson(round, overall = 'pass', over = {}) {
  const fail = overall === 'fail';
  return JSON.stringify({
    schema_version: 1,
    round,
    overall,
    summary: over.summary ?? (fail ? 'spec needs repair' : 'spec is reviewable'),
    human_report: over.human_report ?? (fail ? 'Human: ACs need sharpening.' : 'Human: spec is ready for approval.'),
    spec_agent_feedback: over.spec_agent_feedback ?? (fail ? 'Spec agent: make ACs concrete.' : 'Spec agent: no repair needed.'),
    findings: over.findings ?? (fail
      ? [{ severity: 'major', audience: 'both', issue: 'AC is too vague', recommendation: 'Rewrite AC as a measurable bullet.' }]
      : []),
  });
}

export function specVerifierStep(round, overall = 'pass', { cost = 0.02, session_id, over = {} } = {}) {
  return {
    ...(session_id ? { session_id } : {}),
    cost,
    result: specVerifierJson(round, overall, over),
  };
}
