// 单元：tools/slack-notify.mjs —— Slack 发送契约（E22/H28）。
// fetch 全部注入 mock，测试零网络。核心不变量：Slack 失败也返回 HTTP 200，必须看 body.ok；
// sendSlackMessage 从不 throw（观测面纪律——发送失败绝不打断调用方主链）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendSlackMessage } from '../../tools/slack-notify.mjs';

test('sendSlackMessage：成功路径带 Bearer 头与 JSON body', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { json: async () => ({ ok: true, channel: 'C123', ts: '1720.001' }) };
  };
  const res = await sendSlackMessage({ token: 'xoxb-test', channel: 'C123', text: 'hello', fetchImpl });
  assert.deepEqual(res, { ok: true, channel: 'C123', ts: '1720.001' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer xoxb-test');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { channel: 'C123', text: 'hello' });
});

test('sendSlackMessage：API 层失败（HTTP 200 + ok:false）原样透传 error', async () => {
  const fetchImpl = async () => ({ json: async () => ({ ok: false, error: 'not_in_channel' }) });
  const res = await sendSlackMessage({ token: 'xoxb-test', channel: 'C123', text: 'x', fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_in_channel');
});

test('sendSlackMessage：网络异常不 throw，收敛为 ok:false', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNRESET');
  };
  const res = await sendSlackMessage({ token: 'xoxb-test', channel: 'C123', text: 'x', fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /^network: ECONNRESET/);
});

test('sendSlackMessage：缺 token/channel/text 前置拒绝，不打网络', async () => {
  let called = 0;
  const fetchImpl = async () => {
    called++;
    return { json: async () => ({ ok: true }) };
  };
  const noToken = await sendSlackMessage({ token: null, channel: 'C1', text: 'x', fetchImpl });
  assert.equal(noToken.ok, false);
  assert.match(noToken.error, /missing_token/);
  const noChannel = await sendSlackMessage({ token: 't', channel: null, text: 'x', fetchImpl });
  assert.match(noChannel.error, /missing_channel/);
  const noText = await sendSlackMessage({ token: 't', channel: 'C1', text: '  ', fetchImpl });
  assert.equal(noText.error, 'empty_text');
  assert.equal(called, 0);
});
