#!/usr/bin/env node
// Slack 集成冒烟测试：验证 .env 里的三样凭证能不能真用。
// 零依赖，用 Node 内置 fetch 直接打 Slack Web API。
// 跑法：node tools/slack-smoke.mjs        （只读校验，不发消息）
//       node tools/slack-smoke.mjs --send （额外往默认频道发一条测试消息）

// --- 载入 .env（Node 20.12+ 内置，无需 dotenv）---
try {
  process.loadEnvFile('.env');
} catch {
  console.error('✖ 读不到 .env（确认在仓库根目录跑，且 .env 存在）');
  process.exit(1);
}

const BOT = process.env.SLACK_BOT_TOKEN;
const APP = process.env.SLACK_APP_TOKEN;
const CHANNEL = process.env.SLACK_DEFAULT_CHANNEL;
const doSend = process.argv.includes('--send');

const mask = (t) => (t ? `${t.slice(0, 9)}…(${t.length} chars)` : '(未设置)');

// Slack Web API 调用：ok:false 也会返回 200，所以看 body.ok
async function slack(method, token, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// 常见错误 → 人话提示
const HINTS = {
  invalid_auth: 'token 无效/已撤销 —— 检查是不是复制全了、有没有多空格',
  not_authed: 'token 没带上 —— 检查 .env 变量名',
  account_inactive: 'token 对应的 app 被停用了',
  missing_scope: '缺 scope —— 去 OAuth & Permissions 补，然后必须重新 Install to Workspace',
  not_in_channel: '',
  channel_not_found: 'SLACK_DEFAULT_CHANNEL 的频道 ID 不对，或 bot 看不到该频道',
};

let failed = false;
const step = (ok, label, extra = '') =>
  console.log(`${ok ? '✅' : '✖ '} ${label}${extra ? ' — ' + extra : ''}`);

console.log('== Slack 冒烟测试 ==');
console.log(`  SLACK_BOT_TOKEN      ${mask(BOT)}`);
console.log(`  SLACK_APP_TOKEN      ${mask(APP)}`);
console.log(`  SLACK_DEFAULT_CHANNEL ${CHANNEL || '(未设置)'}`);
console.log('');

// 1) bot token 有效性 + 身份
if (!BOT) {
  step(false, 'SLACK_BOT_TOKEN 缺失');
  failed = true;
} else {
  const a = await slack('auth.test', BOT);
  if (a.ok) {
    step(true, 'bot token（auth.test）', `工作区=${a.team} · bot=${a.user} · team_id=${a.team_id}`);
  } else {
    step(false, 'bot token（auth.test）', `${a.error}${HINTS[a.error] ? ' → ' + HINTS[a.error] : ''}`);
    failed = true;
  }
}

// 2) app token（Socket Mode）—— open 一个连接就断，只为验证 xapp- 可用
if (!APP) {
  step(false, 'SLACK_APP_TOKEN 缺失（要 Socket Mode 才需要）');
} else {
  const c = await slack('apps.connections.open', APP);
  if (c.ok) {
    step(true, 'app token（apps.connections.open）', 'Socket Mode 可建立 WebSocket');
  } else {
    step(false, 'app token（apps.connections.open）', `${c.error}${HINTS[c.error] ? ' → ' + HINTS[c.error] : ''}`);
    failed = true;
  }
}

// 3) 发消息（可选，--send 才做）
if (doSend) {
  if (!BOT || !CHANNEL) {
    step(false, '发消息跳过', '缺 SLACK_BOT_TOKEN 或 SLACK_DEFAULT_CHANNEL');
    failed = true;
  } else {
    const m = await slack('chat.postMessage', BOT, {
      channel: CHANNEL,
      text: '✅ Slack 冒烟测试 — conductor bot token 正常（auth.test + chat.postMessage 通过）',
    });
    if (m.ok) {
      step(true, 'chat.postMessage', `已发到 ${m.channel}，ts=${m.ts}`);
    } else if (m.error === 'not_in_channel') {
      step(false, 'chat.postMessage', `not_in_channel → 先在频道里 /invite @你的bot`);
      failed = true;
    } else {
      step(false, 'chat.postMessage', `${m.error}${HINTS[m.error] ? ' → ' + HINTS[m.error] : ''}`);
      failed = true;
    }
  }
} else {
  console.log('ℹ  未加 --send：只做了只读校验，没发消息。想真发一条：node tools/slack-smoke.mjs --send');
}

console.log('');
console.log(failed ? '结果：有失败项 ✖' : '结果：全部通过 ✅');
process.exit(failed ? 1 : 0);
