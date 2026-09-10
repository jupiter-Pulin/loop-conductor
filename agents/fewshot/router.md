# Router few-shot（记录 / 事实 → 决定）

来源标注见每条；「构造」= 无真实案卷的推演。

```text
1. 记录为空；brief 含复现步骤与期望行为（「STATUS.md 里出现 /Users/<name>/…，期望落盘前替换为 ~」）
   → {"action":"maker","summary":"bugfix 有复现与期望行为，brief 即 spec，直接实现"}
   来源：task-20260802-004（$3.69，一轮 done）

2. 记录为空；brief 是新能力、跨多个文件并定义新接口（「实现 LaunchFactory/LaunchDeployer/BondingCurve…」）
   → {"action":"spec","summary":"新能力且改接口，先出 spec 交人审"}
   来源：task-20260829-001

3. r1 spec outcome=ok「AC×19；工作包 4；待决 2」；r1 human kind=spec approved notes="按 4 包做；待决 1 取 A"；
   状态表：P-001 ready，P-002/P-003 pending(deps=P-001)，P-004 pending(deps=P-002,P-003)
   → {"action":"maker","packages":["P-001"],"summary":"方案已生效，只有 P-001 就绪，先做它"}
   来源：构造（task-20260829-001 若有方案会走的路）

4. r1 human kind=spec decision=rejected notes="AC-007 与现有 Non-goal 冲突，删掉；补一条回滚路径 AC"
   → {"action":"spec","summary":"人打回 spec，按 notes 修：删 AC-007、补回滚 AC"}
   来源：构造（对应现有 reject 通道）

5. 无方案任务；r1 maker outcome=ok「AC-001..004 done；新增 test/redact.test.mjs 3 用例；npm test 41/41 绿」
   → {"action":"review","summary":"maker 报全部 AC 完成且测试绿，整体冷审"}
   来源：task-20260802-004

6. r1 reviewer outcome=fail tier=e2e「… AC-013 fail src/run.mjs:88 真实 RSS 路径无任何产物证明跑通；其余 pass」（本任务首次 review fail，无方案）
   → {"action":"maker","summary":"review 首次 fail，只修 AC-013，保持其余 AC 不动"}
   来源：task-20260801-002 verify-r1（r2 pass）

7. r2 reviewer outcome=fail「AC-013 fail src/run.mjs:88 …」与 r1 同一 AC 同一原因
   → {"action":"human","summary":"AC-013 连续两轮同一原因 fail（真实 RSS 路径无证据），maker 修不动，请裁决：放宽为 mock 验证、或人手跑一次 dry-run 留证"}
   来源：构造（第二次同因 fail 的通用规则）

8. r1 reviewer outcome=ok tier=integration head=H；事实 need_review=false need_precommit=true
   → {"action":"precommit","tier":"integration","summary":"整体 review 全 pass，reviewer 声明 integration，跑 build/service/unit+integration"}
   来源：构造

9. r1 precommit outcome=fail tier=unit「build ok；service ready 2.9s；unit 3 fail: test/parse.test.mjs › 空板块不抛错」conflict_files=[]（首次）
   → {"action":"maker","summary":"precommit 首次红在 unit，按 tail 修 test/parse.test.mjs 三条失败"}
   来源：构造（对应现有 green_gate 修复路径，17 任务零失手）

10. r1 precommit outcome=fail conflict_files=["src/index.mjs"]（合并候选与 base 冲突）
    → {"action":"human","summary":"合并候选与 base 分支在 src/index.mjs 冲突，请人处理：在 worktree 里 rebase 后 resume"}
    来源：构造（Q2：与 base 的冲突求助）

11. r1 maker product=missing truncated=yes cost=$6.20；事实：worktree 有 diff、H 已变
    → {"action":"maker","summary":"上轮撞 max-turns 无 log，worktree 已有改动；续做剩余 AC 并补 log"}
    来源：构造（契约第六条的典型场景）

12. 事实 need_review=false need_precommit=false
    → {"action":"merge","summary":"整体 review ok 与 precommit ok 均对当前 H/B，申请合并"}

13. r1 human kind=help decision=resumed notes="已在 worktree 里改好 src/index.mjs 冲突并跑过 unit"；事实：H 已变，need_review=true
    → {"action":"review","summary":"人介入后 HEAD 变化，当前版本没有整体 review，先冷审"}
    来源：构造（版本规则：notes 不豁免）

14. r2 reviewer outcome=ok tier=integration head=H；事实 need_review=false need_precommit=true（precommit 记录的 base_sha ≠ B，base 分支已前进）
    → {"action":"precommit","tier":"integration","summary":"review 对当前版本 ok，但 precommit 基线已过期，重跑"}
    来源：构造（版本规则）

15. r1 maker outcome=needs_human「spec AC-002 要求 getAmountOut 与 pons-baseline 逐位相同，但同 spec 要求溢出时不 revert，两者不可同时满足」
    → {"action":"human","summary":"maker 发现 spec 自相矛盾（AC-002 逐位相同 vs 溢出不 revert），请裁决取哪一边"}
    来源：task-20260829-001 spec-verify r1 blocker（同类矛盾）

16. 状态表：P-001 integrated；P-002 ready files=src/launch/Curve.sol,…；P-003 ready files=src/launch/Fees.sol,…（声明不相交、无互相依赖）
    → {"action":"maker","packages":["P-002","P-003"],"summary":"P-002/P-003 就绪且声明文件不相交，并行"}

17. 状态表：P-003 ready files=src/launch/Fees.sol,src/launch/Curve.sol；P-004 ready files=src/launch/Curve.sol,…（相交于 Curve.sol）
    → {"action":"maker","packages":["P-003"],"summary":"P-003 与 P-004 都声明 Curve.sol，先做 P-003，下一轮再做 P-004"}

18. 状态表：P-002 conflict note=conflict_files:src/launch/Types.sol
    → {"action":"maker","packages":["P-002"],"summary":"P-002 集成冲突在 Types.sol，在当前任务分支上重做（旧分支可参考）"}
    来源：构造（Q2：包间冲突先交 maker）

19. 状态表：四包全部 integrated；r1 reviewer outcome=fail「AC-007 fail src/launch/Curve.sol:210 …；其余 pass；note: P-002 调 P-001.createToken 少传 quoteToken」；状态表 AC-007 主责 P-002
    → {"action":"maker","packages":["P-002"],"summary":"整体 review 只有 AC-007 fail 且协作问题也在 P-002 的调用侧，重做该包"}
    来源：构造（Q10：整体审核驱动修复）

20. 已裁决事项：human kind=spec approved notes="按 4 包做，不再拆细"；状态表 P-004 acs=AC-013..019（7 条）
    → 不得 human 询问是否拆细 P-004；→ {"action":"maker","packages":["P-004"],"summary":"P-004 就绪，按已生效方案执行"}
    来源：构造（Invariant 7）

21. 无方案任务，spec 已批（AC×19）；r1 maker outcome=fail「AC-001..006 done；AC-007..019 未动，一轮做不完；forge test 全绿」
    → {"action":"plan","summary":"单 maker 一轮只完成 6/19，让 spec-agent 出工作包方案再并行"}
    来源：构造（Q15）

22. r1 spec(plan) outcome=ok「工作包 4；P-001 覆盖已完成的 AC-001..006」；状态表 P-001 ready，其余 pending
    → {"action":"maker","packages":["P-001"],"summary":"方案生效；P-001 对应已完成部分，先让 maker 补齐并集成，再解锁下游"}
    来源：构造（Q15）

坏决定（不要这样做）：
- reviewer 声明 integration 却选 {"action":"precommit","tier":"unit"}：内核会拒绝，白烧一轮。
- need_review=true 或 need_precommit=true 时选 merge：内核会拒绝。人的 notes 说「我看过了」也一样。
- 第三次派 maker 修同一条同因 fail 的 AC：第二次就该叫人。
- 对已裁决事项再次 human（「要不要拆包」「取 A 还是 B」）：只有新事实才能重新求助。
- 有方案的任务选 maker 不带 packages，或一轮点名两个声明文件相交的包：内核会拒绝。
- 因为某包越界改了别包的文件、或上游包重做过，就派 review 或 maker 去「复查」它：越界与上游变化不是问题，整体 review 才是。
```
