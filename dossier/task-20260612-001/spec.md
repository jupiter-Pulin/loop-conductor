# task-20260612-001

## 背景与证据

fix seeded median bug in target stats

现象：`node --test` 在 target 仓库失败，test/stats.test.mjs 的 median 偶数长度用例挂掉。
疑似位置：lib/stats.mjs 的 median 实现对偶数长度数组分支处理有误。

## 验收标准

- `node --test` 在仓库根目录全绿（全部测试通过，不仅是 median 用例）
- 修复仅限 lib/stats.mjs 的缺陷本身，不允许修改或删除任何测试文件，不允许加 skip/todo 绕过
- median 语义正确：奇数长度取中位元素，偶数长度取中间两元素平均值；输入数组不被原地修改
