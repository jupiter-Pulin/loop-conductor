#!/usr/bin/env bash
# tools/link-loop-memory.sh — 把私有记忆库装配进 loop（换机冷启动的唯一额外步骤）。
#
# 架构：fable-loop-PROMPT.md 是协议（代码，随框架仓公开）；fable-loop-STATE.md /
# fable-loop-ARCHIVE.md 是研究记忆（数据，含业务上下文，存私有记忆库，框架仓 gitignore）。
# 本脚本用符号链接把记忆库文件装回仓库根——loop 协议按原文件名读写，零改动透明生效。
#
# 用法：
#   ./tools/link-loop-memory.sh /path/to/will-loop-memory
#
# 换机冷启动全流程：
#   git clone <framework-repo> && git clone <private-memory-repo>
#   cd will-workflow && ./tools/link-loop-memory.sh ../will-loop-memory
#   （记忆的提交/推送在记忆库目录里正常 git 操作即可）
#
# 首次建库：把仓库根现有的 fable-loop-STATE.md / fable-loop-ARCHIVE.md 移入记忆库目录，
# 在那边 git init + 建私有远端，然后回来跑本脚本。
set -euo pipefail

MEM_DIR="${1:?用法: $0 <私有记忆库路径>}"
MEM_DIR="$(cd "$MEM_DIR" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILES=(fable-loop-STATE.md fable-loop-ARCHIVE.md)

for f in "${FILES[@]}"; do
  src="$MEM_DIR/$f"
  dst="$ROOT/$f"
  if [ ! -f "$src" ]; then
    echo "✖ 记忆库缺 $f（首次建库请先把仓库根的该文件移过去）" >&2
    exit 1
  fi
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "✖ $dst 是实体文件——为防覆盖研究记忆，请人工核对后移入记忆库再重跑（本脚本绝不删实体文件）" >&2
    exit 1
  fi
  ln -sfn "$src" "$dst"
  echo "✔ $f → $src"
done
echo "装配完成：loop 按原路径读写，记忆的版本管理在 $MEM_DIR 内进行。"
