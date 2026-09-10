# Reviewer few-shot

```text
A. tier 判定
   unit：改动只在 lib/redact.mjs 一个纯函数及其测试；没有跨模块调用、没有 I/O 边界变化。
   integration：改了 LaunchFactory.createToken 的签名且 Router.sol 调用它；或新增 DB 列 / 改了对外部 HTTP 客户端的调用参数。
   e2e：改了从 CLI 入口到落盘报告的整条流程，或 AC 本身要求「跑 npm run dry 命中真实 RSS 并生成含第 4 板块的报告」。（task-20260801-002 AC-013）
   规则：取本次 diff 触及的最高一层；拿不准时取高一层。

B. 证明力
   坏：AC 声明「fetch 超时后进入 degraded」，测试把 fetch 换成立即 resolve 的 mock，永远走不到超时分支 → AC fail，写出测试文件行号。
   好：测试注入 1ms 超时的假服务，用 AbortController 触发中止，断言状态为 degraded。（task-20260801-003 AC-005/006）

C. fail 写法
   好：AC-006 fail src/fetch.mjs:12 未设置超时；test/fetch.test.mjs:30 只断言成功路径
   坏：AC-006 fail 超时处理不完善
       —— maker 拿到这句无法定位，等于没审。

D. 无法判定
   坏：status=unknown（旧契约）。
   好：fail，原因写「静态证据不足：reports/ 下无任何含融资板块的产物」并给出你查过的路径。（task-20260801-002 verify-r1 AC-013）

E. 「保持不变」类 AC
   坏：diff 里没出现该路径就 pass。
   好：追到调用链确认语义未变；若 diff 削弱、删除或跳过了钉住该 AC 的测试，不能仅凭实现代码 pass。

F. 包间协作
   坏：因为 P-002 改了 P-001 声明的 Types.sol 就判 P-001 的 AC fail。
   好：只看行为：P-002 调用 createToken 时少传 quoteToken 导致 P-001 的 AC-002「返回的 curve 绑定正确 quote」在协作路径上不成立 → AC-002 fail src/launch/Curve.sol:88，并加一行 note: 接口约定要求传 quoteToken。

G. log summary（增量示例：判到第 3 条时的文件内容）
   {"role":"reviewer","outcome":"fail","tier":"integration","summary":"AC-001 pass\nAC-002 pass\nAC-003 fail src/launch/Curve.sol:412 sweep 未扣 pendingCreatorFee；test/launch/Sweep.t.sol:57 断言了错误的期望值\n未判: AC-004, AC-005"}
```
