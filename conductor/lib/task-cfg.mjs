// lib/task-cfg.mjs — 任务级配置解析：task.json 快照的 targetRepo 覆盖全局 cfg.targetRepo，
// 使同一次 drain 中面向不同仓库的任务各自命中自己的 target repo。不改 cfg 本体；
// 旧任务（task.json 无 targetRepo 字段）原样返回 cfg（回退现状行为）。
export function taskCfg(ts, cfg) {
  const targetRepo = ts?.task?.targetRepo ?? cfg.targetRepo;
  return targetRepo === cfg.targetRepo ? cfg : { ...cfg, targetRepo };
}
