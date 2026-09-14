#!/usr/bin/env bash
# loop-task 前置自检：定位 Loop Conductor 仓库 + node ≥ 24 + claude CLI 可解析。
# 用法：eval "$(bash <skill目录>/scripts/precheck.sh)"  —— stdout 只输出 export 行；
# 环境不可用时非零退出，原因在 stderr。
# 背景（E2E 实测）：green gate 继承 PATH，node v22 会把本仓既有测试跑红（TAP 解析差异）；
# 非交互 shell 通常没有 claude 在 PATH，conductor spawn 认 CLAUDE_BIN（缺省字面 'claude'）。
set -euo pipefail

# --- CONDUCTOR_ROOT：本脚本所在的仓库（scripts → loop-task → skills → .claude → 仓库根）。
# cd -P 先把软链接（例如 ~/.claude/skills/loop-task）解析成真实路径，skill 从哪里加载都能找回仓库。
here="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd -P "$here/../../../.." && pwd)"
if [ ! -f "$root/conductor/conductor.mjs" ]; then
  echo "precheck: $root 不是 Loop Conductor 仓库（缺 conductor/conductor.mjs）；skill 要留在仓库的 .claude/skills/ 下，或用软链接指向那里" >&2
  exit 1
fi
# conductor 把 CONDUCTOR_ROOT 当数据根（配置、state、worktrees 都跟着走）；本 skill 在仓库里跑 npm，只支持两者是同一目录。
if [ -n "${CONDUCTOR_ROOT:-}" ] && [ "$(cd "$CONDUCTOR_ROOT" 2>/dev/null && pwd -P)" != "$root" ]; then
  echo "precheck: 环境里的 CONDUCTOR_ROOT=$CONDUCTOR_ROOT 与本 skill 所在仓库 $root 不同；本 skill 只支持数据根就是仓库，先 unset CONDUCTOR_ROOT" >&2
  exit 1
fi
echo "export CONDUCTOR_ROOT=\"$root\""

# --- node ≥ 24：当前不达标时，从 nvm 里挑最新的 v24+ 前置到 PATH ---
major="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)"
if [ "${major:-0}" -lt 24 ]; then
  best="$(ls -d "$HOME/.nvm/versions/node/"v* 2>/dev/null | sort -V | tail -1 || true)"
  best_major="$(basename "${best:-v0}" | sed -E 's/^v([0-9]+).*/\1/')"
  if [ -n "$best" ] && [ "${best_major:-0}" -ge 24 ]; then
    echo "export PATH=\"$best/bin:\$PATH\""
  else
    echo "precheck: 需要 node ≥ 24（当前 v${major:-?}，nvm 里也没有）。先 nvm install 24" >&2
    exit 1
  fi
fi

# --- claude CLI：PATH 没有时挂桌面 App 托管的最新真身 ---
if ! command -v claude >/dev/null 2>&1 && [ -z "${CLAUDE_BIN:-}" ]; then
  bin="$(ls -dt "$HOME/Library/Application Support/Claude/claude-code/"*/claude.app/Contents/MacOS/claude 2>/dev/null | head -1 || true)"
  if [ -n "$bin" ] && [ -x "$bin" ]; then
    echo "export CLAUDE_BIN=\"$bin\""
  else
    echo "precheck: PATH 无 claude、CLAUDE_BIN 未设、桌面 App 托管目录也找不到可执行 CLI" >&2
    exit 1
  fi
fi
