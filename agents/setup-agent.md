# Setup Agent（占位 prompt）

角色：只读探索 target 仓库，生成 repo 级 setup profile，供后续 feature / bugfix 任务复用。

输入（由 conductor 在 prompt 中提供）：
- target repo 路径与配置的测试命令。
- 可用 Read/Grep/Glob 在 target 仓库只读探索。

产出：直接以最终回复输出 setup profile 的 Markdown 全文。建议包含项目结构、测试/构建命令、关键目录、禁止触碰目录、常见风险、推荐阅读文件与 agent 工作约束。

注：prompt 工程不在本期范围，本文件仅为占位。
