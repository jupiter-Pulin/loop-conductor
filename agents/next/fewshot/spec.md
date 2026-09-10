# Spec few-shot

```text
A. AC 写法
   坏：AC-005: 主循环收到 amountSpecified - creatorFee。
       —— 循环入参不出现在返回值、事件或存储里，验收者无法观察。（task-20260829-002 spec-verify r1）
   好：AC-005: 给定 amountSpecified=1000、creatorFeeBps=100 的 buy，返回的 amountIn 等于 1000，且 creatorFees(quote) 增加 10。

   坏：AC-003: 处理路径泄漏。
   好：AC-003: 构造含 /Users/fakeuser/logs/x.log 与真实 process.env.HOME 拼接路径的 Error message，走真实写盘管道（可注入临时目录），断言落盘产物 0 命中 /Users/ 且 HOME 实际值不出现。（task-20260802-004）

B. 事实接地
   坏：AC-003 要求验证第三方经 NonfungiblePositionManager.createAndInitializePoolIfNecessary() 建池 revert
       —— 该函数在仓库 periphery 中不存在，全仓 grep 为零。（task-20260829-002 spec-verify r1 blocker）
   好：先 Grep 确认入口存在；不存在则写「新增 createAndInitializePoolIfNecessary()」或改用仓库里真实存在的建池入口。

C. 范围与拆分
   坏：brief 覆盖 5 个核心合约 → 只写 Factory + Token 的 8 条 AC，其余挪进 Non-goals，log 报 needs_human 建议拆单。
       —— 需求被 spec 自行裁剪，人要为「做不做」再审一次，router 事后还会为拆分求助。
   坏：19 条 AC 一单交付、不给方案 → 单 maker 一轮做不完。（task-20260829-001，六轮打不平 $44 收箱）
   好：19 条 AC 全写；packages.json 给 4 包（P-001 Factory+Token AC-001..004 / P-002 Curve AC-005..009 deps=P-001 / P-003 Fees AC-010..012 deps=P-001 / P-004 Graduation AC-013..019 deps=P-002,P-003）；
       「待决问题」列「snipe 税默认值 0 还是沿用 Pons 的 50？safe default 0」；log {"outcome":"ok","summary":"AC×19；触及 src/launch/**、test/launch/**；工作包 4；待决 2"}。

D. 保护性 AC
   坏：只写新行为，不写「哪些现有行为不许变」。
   好：AC-004: 现有 mean/sum 的返回值与调用签名保持不变。

E. 工作包声明
   坏：files:["src/**"]，depends_on 空，四个包全这样写。
       —— 内核无法判断能否并行，四个包只能串行；接口约定缺失，下游包只能猜。
   好：files 精确到文件；interfaces 写「P-001 暴露 ILaunchFactory.createToken(LaunchParams) returns (address token, address curve)；P-002 只依赖此签名」；depends_on 只列真实依赖。

F. 方案模式（plan）
   坏：看到任务分支已实现 AC-001..006，就把方案写成只覆盖 AC-007..019 的 3 包。
       —— AC 集合与冻结 spec 不等，内核拒绝生效；已完成部分也需要一个包来集成。
   好：4 包覆盖全部 19 条；P-001 主责 AC-001..006 并在 goal 写「任务分支已实现，补测试与遗漏后集成」；其余按依赖排。
       log {"outcome":"ok","summary":"工作包 4；P-001 覆盖已完成的 AC-001..006；P-002/P-003 依赖 P-001，P-004 依赖 P-002/P-003"}

G. log summary
   好：AC×19；触及 src/launch/**、test/launch/**；工作包 4；待决 2
   坏：已完成 spec 撰写，涵盖全部需求，请审阅。
       —— router 不知道规模、位置、是否有方案，等于没写。
```
