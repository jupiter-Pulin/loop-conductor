#!/usr/bin/env node
// tools/slack-notify.mjs — 零依赖 Slack 发送通道（传感层，fable-loop E22/H28）。
// env 契约与 tools/slack-smoke.mjs 同源：SLACK_BOT_TOKEN + SLACK_DEFAULT_CHANNEL（.env，process.loadEnvFile）。
// fetch 可注入 → 单测不打网络。Slack Web API 的失败也返回 200，必须看 body.ok。
// 用法：node tools/slack-notify.mjs --text "..."（或 stdin 管道）[--channel C..] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 读 .env（Node 20.12+ 内置）+ process.env，返回 {token, channel}。缺失字段为 null，由调用方裁决。 */
export function loadSlackEnv(root = process.cwd()) {
  try {
    process.loadEnvFile(path.join(root, '.env'));
  } catch { /* .env 可缺失：CI / 只跑 --dry-run 的场景 */ }
  return {
    token: process.env.SLACK_BOT_TOKEN ?? null,
    channel: process.env.SLACK_DEFAULT_CHANNEL ?? null,
  };
}

/**
 * 发一条消息。返回 {ok, channel, ts, error}，从不 throw（观测面纪律：发送失败绝不打断调用方主链）。
 * fetchImpl 注入点是单测唯一需要的缝。
 */
export async function sendSlackMessage({ token, channel, text, fetchImpl = fetch }) {
  if (!token) return { ok: false, error: 'missing_token（SLACK_BOT_TOKEN 未设置）' };
  if (!channel) return { ok: false, error: 'missing_channel（SLACK_DEFAULT_CHANNEL 未设置且未传 --channel）' };
  if (!text || !text.trim()) return { ok: false, error: 'empty_text' };
  try {
    const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text }),
    });
    const body = await res.json();
    return body.ok
      ? { ok: true, channel: body.channel, ts: body.ts }
      : { ok: false, error: body.error ?? 'unknown_slack_error' };
  } catch (err) {
    return { ok: false, error: `network: ${err?.message ?? String(err)}` };
  }
}

/**
 * 经 incoming webhook 发消息（告警通道优先走 webhook：无需 bot 入频道，密钥粒度独立可撤销）。
 * webhook 成功返回 HTTP 200 + 文本 "ok"（非 JSON）。同样从不 throw。
 */
export async function sendSlackWebhook({ url, text, fetchImpl = fetch }) {
  if (!url) return { ok: false, error: 'missing_webhook_url（SLACK_WEBHOOK_URL 未设置）' };
  if (!text || !text.trim()) return { ok: false, error: 'empty_text' };
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text }),
    });
    const body = await res.text();
    return res.status === 200 && body === 'ok'
      ? { ok: true }
      : { ok: false, error: `webhook_${res.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: `network: ${err?.message ?? String(err)}` };
  }
}

// ---- CLI ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? null) : null;
  };
  let text = flag('--text');
  if (!text && !process.stdin.isTTY) {
    text = fs.readFileSync(0, 'utf8');
  }
  const env = loadSlackEnv();
  const channel = flag('--channel') ?? env.channel;

  if (args.includes('--dry-run')) {
    process.stdout.write(`--- dry-run（未发送）---\nchannel: ${channel}\n${text ?? '(无内容)'}\n`);
    process.exit(0);
  }
  const res = await sendSlackMessage({ token: env.token, channel, text });
  if (res.ok) {
    process.stdout.write(`已发送：channel=${res.channel} ts=${res.ts}\n`);
  } else {
    process.stderr.write(`发送失败：${res.error}\n`);
    process.exit(1);
  }
}
