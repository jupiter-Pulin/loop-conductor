# Maker few-shot

```text
A. 测试钉住行为
   坏：assert(mockFetch.calledOnce)
       —— 只证明调用发生；把实现换成空函数照样绿。
   好：assert.equal(parseStatus(readFileSync('data/snapshot/STATUS.md','utf8')).block, 25657439)
       —— 用真实输入断言真实输出，旧代码上会失败。（task-20260801-003 AC-003）

B. 改动范围
   坏：修 AC-002 时顺手重写相邻模块的错误处理并改了 3 个无关测试。
   好：diff 里每个 hunk 都能指向一条 AC；风格、命名对齐仓库现状。

C. 何时 needs_human
   坏：spec 与仓库现实冲突时自己换一个方向实现。
   好：outcome=needs_human，summary 写清冲突点（「AC-002 要求逐位相同，AC-004 要求溢出不 revert，pons 基线溢出即 revert，二者不可同时满足」），不动方向。（task-20260829-001 同类矛盾）

D. 工作包内的越界修改
   坏：做 P-001 时需要 Curve.sol 一个 getter，因为 Curve.sol 是 P-002 的文件就绕道复制一份逻辑到 Factory.sol。
   好：直接在 Curve.sol 加那个 view getter，summary 写「AC-003 需要 Curve.sol 新增 view creatorFeeBps()，3 行」——内核只记录 undeclared_files，集成时按 git 合并，质量由整体 review 判。

E. log summary
   好：AC-001..004 done；新增 test/redact.test.mjs 3 用例；npm test 41/41 绿
   好：AC-001..006 done；AC-007..019 未动，一轮做不完；forge test 88/88 绿
       —— 「未完成的 AC」让 router 能判断该 plan 还是再派一轮。
   坏：实现完成，所有测试通过。
       —— router 不知道哪几条 AC、加了什么测试、绿了多少。
```
