# Router few-shot（记录 / 事实 → 决定）

来源标注见每条；「构造」= 无真实案卷的推演。

```text
1. 记录为空；brief 含复现步骤与期望行为（「STATUS.md 里出现 /Users/<name>/…，期望落盘前替换为 ~」）
   → {"action":"maker","summary":"bugfix 有复现与期望行为，brief 即 spec，直接实现"}
   来源：task-20260802-004（$3.69，一轮 done）

2. 记录为空；brief 是新能力、跨多个文件并定义新接口（「实现 LaunchFactory/LaunchDeployer/BondingCurve…」）
   → {"action":"spec","summary":"新能力且改接口，先出 spec 交人审"}
   来源：task-20260829-001

3. spec 已批准（摘要：AC×42；原 spec 提议 7 个工作包，P-002/P-003 只依赖 P-001；未决问题含「两条链的合约地址仓库里没有记录」
   与「索引器 codegen 能否在没有数据库时完成」）；记录里还没有任何执行
   → {"action":"dispatch","summary":"先立工具链骨架；两个会改变后续计划的未知同时派探针，互不依赖","assignments":[
      {"key":"toolchain","profile":"write","intent":"implement","title":"仓库骨架与工具链",
       "purpose":"建立 workspace 与根脚本，让后续各包有地方落、有命令可跑",
       "inputs":["spec:L65-68（AC-001..004）","spec:L158（原 spec 对 P-001 的提议，仅供参考）"],
       "scope":"只建根配置与空包骨架；不写任何业务包的实现；lockfile 由你独占写入",
       "deliverables":"根 package.json / workspace / turbo / tsconfig / 测试入口；四个根脚本可执行",
       "done_when":"零环境变量下 install、build、test、typecheck 四条命令退出码为 0","paths":["package.json","pnpm-workspace.yaml","turbo.json","tsconfig.base.json","tools/**","scripts/**"]},
      {"key":"nodb-probe","profile":"sandbox","intent":"experiment","title":"无数据库时索引器能否 codegen/build",
       "purpose":"AC-025 假设索引器的 codegen 与 build 不需要数据库；在依赖它排期之前先验证这个假设",
       "inputs":["spec:L108（AC-025）","spec:L178（待决：无 Docker / anvil）"],
       "scope":"只在实验目录里装依赖、跑最小配置；结果不并入产品",
       "deliverables":"报告：版本、命令、输出、结论（可行 / 不可行 / 有条件可行），附最小复现",
       "done_when":"在未设置 DATABASE_URL、无数据库进程的环境里给出确定结论"},
      {"key":"addr-check","profile":"read","intent":"investigate","title":"核实两条链的合约地址来源",
       "purpose":"AC-008 要求每个地址有效且可追溯；原文的 safe default（取不到留 null）只是提议，不能当已批准",
       "inputs":["spec:L75（AC-008）","spec:L172（待决问题与 safe default）"],
       "scope":"只查官方来源并记录；不改任何文件",
       "deliverables":"报告：逐条地址、来源 URL、核实日期；查不到的单列",
       "done_when":"每个需要的地址要么有官方来源，要么明确标为查不到"}]}
   来源：构造（task-20260920-001 的三个未知）

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

16. r5 worker nodb-probe outcome=ok「codegen 可离线完成；build 阶段会尝试连库，设置某开关后可跳过（报告 §3）」；台账：toolchain integrated
    → {"action":"dispatch","summary":"探针推翻了「build 天然不连库」的假设：索引器委派改为带上该开关并加一条断言；AC-025 不变；无关的链配置照常推进","assignments":[
       {"key":"indexer","profile":"write","intent":"implement","title":"索引器配置骨架（按探针结论）", …"inputs":["worker-nodb-probe-r5.report.md §3","spec:L106-108"], …"paths":["apps/indexer/**"]},
       {"key":"chains","profile":"write","intent":"implement","title":"三链与费用配置", …"paths":["packages/chains/**"]}]}
    并在工作记忆里：facts 加一条（source=worker-nodb-probe-r5.report.md），对应 hypothesis 删掉，changelog 记「r6：探针结论改变索引器委派内容」
    来源：构造（依赖假设被新证据推翻：改委派，不改产品承诺）

17. r5 worker addr-check outcome=ok「链 8453 的三个地址查到官方来源；链 1 有两条查不到」；其余委派仍可推进
    → 先继续不受影响的工作（同 16），把「查不到的两条怎么办」记进 questions(status=open)；等没有别的可做、或它开始挡路时：
    → {"action":"human","summary":"AC-008 要求全部地址有效且可追溯，但链 1 有两条官方来源查不到（worker-addr-check-r5.report.md）。原 spec 的 safe default 是留 null，这会改变 AC-008 的检验范围，需要你裁决：允许留 null 并改 spec，还是由你提供地址"}
    来源：构造（safe default 不是已批准事实；产品承诺的变化交人）

18. 台账：contract integrated（共用 schema 已在任务分支上，r7 的 check 委派确认 API 与 UI 依赖的导出都在）；api 与 web 互不 import，对方只经 schema 类型耦合
    → {"action":"dispatch","summary":"共用契约已稳定，API 骨架与 fixture 驱动的 UI 无真实依赖，并行；声明路径不相交","assignments":[
       {"key":"api","profile":"write", …"paths":["apps/api/**"]},
       {"key":"web","profile":"write", …"paths":["apps/web/**"]}]}
    若契约还在变：先只派 api，web 下一轮再派——并行不是目标。
    来源：构造

19. 台账：api state=integrated last=r9 outcome=partial truncated=yes 可续接=continue_from:9；remaining: 「/v1/pools 两条路由」「路由测试」
    → {"action":"dispatch","summary":"api 撞会话上限，已完成部分已集成；续接原会话做剩余两项","assignments":[{"key":"api", …"continue_from":9,"purpose":"完成 remaining 里的两项","done_when":"remaining 清空且路由测试通过"}]}
    remaining 太大就别续：拆成更小的委派重派。
    来源：构造

20. 台账：web state=conflict conflict_files=package.json（与同轮的 api 都改了根 package.json）
    → {"action":"dispatch","summary":"web 集成冲突在根 package.json：在已含 api 的当前 HEAD 上重做这一处，单独一轮","assignments":[{"key":"web-rebase","profile":"write","intent":"fix", …"inputs":["分支 task/<id>--web 保留了上一版改动，可 git diff 参考"]}]}
    来源：构造（共享写入没串行的代价）

21. 事实：review@H 已判 30/42，fail 0，未判 12；need_review=true
    → {"action":"review","summary":"上一轮 review 判了 30 条就到上限，HEAD 未变，继续判剩余 12 条"}
    事实若是 fail 2：先派 fix 委派修这两条，H 变了之后旧判决全部作废，再整体 review。
    来源：构造

22. 已裁决事项：human kind=spec approved notes="待决 1 取 A；不做制裁筛查"
    → 不得 human 询问这两件事；→ 继续派工
    来源：构造（Invariant 7）

坏决定（不要这样做）：
- reviewer 声明 integration 却选 {"action":"precommit","tier":"unit"}：内核会拒绝，白烧一轮。
- need_review=true 或 need_precommit=true 时选 merge：内核会拒绝。人的 notes 说「我看过了」也一样。
- 第三次派 maker 修同一条同因 fail 的 AC：第二次就该叫人。
- 对已裁决事项再次 human（「要不要拆包」「取 A 还是 B」）：只有新事实才能重新求助。
- 同一轮派两个 write 却不声明 paths、或声明的 paths 重叠：内核会拒绝。
- 委派只写「实现 P-003」：接收者看不到你的上下文，purpose / inputs / scope / deliverables / done_when 必须自成一体。
- 把装依赖、跑测试、codegen 派成 profile=read：read 没有命令执行能力，它只会回来说「未验证」。
- 把 worker 的「已完成」当成 AC 通过，或因为各子任务都 ok 就跳过整体 review 直接 merge：内核会拒绝 merge。
- 探针结论与 AC 冲突时改小 AC、或把原文的 safe default 当成已批准：要么找到满足 AC 的做法，要么 spec / human 交人裁决。
- 委派撞上限就原样重派一遍：先看 done / remaining 与已集成的改动，续接或缩小。
```
