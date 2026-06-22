# task-20260613-001

## 背景与证据

fix seeded median bug in stats.mjs

证据：`node --test` 在 target 仓库失败——`median([1,2,3,4])` 返回 3，期望 2.5（lib/stats.mjs 的偶数长度分支取错了元素）。

## 验收标准

- worktree 内 `node --test` 全绿
- median 对偶数长度数组返回中间两数的均值（如 [1,2,3,4] → 2.5），奇数长度行为不变
- 不允许修改或跳过测试文件（test/ 目录只读）
- 改动最小化：只动 lib/stats.mjs 中有缺陷的分支
