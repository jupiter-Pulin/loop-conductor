// stages/await_human.mjs — 三道人闸（spec / merge / help）的停车位。
//
// handler 本身**不推进**：进闸的产物（human-r<n>.json）、runtime.awaiting 与事件
// human_gate_opened 都在进闸那一刻由 router-kernel.mjs::openHumanGate 写好了；
// 这里只负责让 drain 停下来（changed: false），等 CLI（approve / reject / resume）落裁决。
//
// 为什么还需要一个 handler：scheduler 见到没有 handler 的 stage 会打「未知 stage」并跳过，
// 那既噪音又像故障。一个显式的空 handler 才是「在等人，不是出问题了」。

import * as state from '../lib/state.mjs';

export default async function awaitHumanHandler(ts, cfg) {
  const kind = ts.runtime.awaiting?.kind ?? null;
  if (kind == null) {
    // awaiting 缺失说明产物与状态不一致（人工改过 runtime，或崩在两次写盘之间）。
    // 不自作主张回 ROUTING（那会重开一道人已经在看的闸），只留一行给人。
    state.appendTimeline(cfg, ts.id, 'AWAIT_HUMAN 但 runtime.awaiting 为空：等人用 approve / reject / resume 处理');
  }
  return { changed: false };
}
