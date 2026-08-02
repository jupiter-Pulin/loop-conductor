// dashboard/static/*.css 滚动条隐藏规则单测：解析 CSS 文本，断言看板内部滚动容器
// 同时被 Firefox（scrollbar-width: none）与 WebKit（::-webkit-scrollbar{display:none}）分支命中，
// overflow 取值不漂移，且规则不外溢到 * / html / body（页面级滚动条保留）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../conductor/dashboard/static',
);

// 看板内部滚动容器：抽屉、面板、抽屉时间线、审查页右栏、日志/输出块、diff 代码块。
const SCROLL_CONTAINERS = [
  '.drawer',
  '.panel',
  '.drawer-timeline .timeline-scroll',
  '.task-aside-inner',
  'pre.readonly',
  '.stream-tail-pre',
  '.diff-patch',
];

// 改动前逐条抄录的 overflow 期望值表——任一条被改成 hidden 即 fail。
const EXPECTED_OVERFLOW = {
  '.drawer': { 'overflow-y': 'auto' },
  '.panel': { 'overflow-y': 'auto' },
  '.drawer-timeline .timeline-scroll': { 'overflow-y': 'auto' },
  '.task-aside-inner': { 'overflow-y': 'auto' },
  'pre.readonly': { 'overflow-y': 'auto' },
  '.stream-tail-pre': { 'overflow-y': 'auto' },
  '.diff-patch': { 'overflow-x': 'auto' },
};

// 页面级选择器：滚动条隐藏规则一旦命中这三类，整页滚动条就跟着消失。
const PAGE_LEVEL_SELECTORS = new Set(['*', 'html', 'body']);

function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

function parseDeclarations(body) {
  const decls = [];
  for (const chunk of splitTopLevel(body, ';')) {
    const idx = chunk.indexOf(':');
    if (idx < 0) continue;
    const prop = chunk.slice(0, idx).trim().toLowerCase();
    const value = chunk.slice(idx + 1).trim().toLowerCase();
    if (prop && value) decls.push({ prop, value });
  }
  return decls;
}

// 极简 CSS 规则扫描：剥注释后线性扫描，at-rule（@media 等）只作为上下文入栈，
// 样式规则体内不会再嵌套花括号，直接取到下一个 '}' 即可。
function parseRules(cssText) {
  const text = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const atRules = [];
  let prelude = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      const head = prelude.trim().replace(/\s+/g, ' ');
      prelude = '';
      if (head.startsWith('@')) { atRules.push(head); continue; }
      let close = text.indexOf('}', i);
      if (close < 0) close = text.length;
      rules.push({
        selectors: splitTopLevel(head, ',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean),
        declarations: parseDeclarations(text.slice(i + 1, close)),
        atRules: [...atRules],
      });
      i = close;
    } else if (ch === '}') {
      atRules.pop();
    } else if (ch === ';' && prelude.trim().startsWith('@')) {
      prelude = '';
    } else {
      prelude += ch;
    }
  }
  // @keyframes 内的 0%/100% 帧不是样式规则，排除以免污染选择器断言。
  return rules.filter((r) => !r.atRules.some((at) => at.startsWith('@keyframes')));
}

function loadStaticRules() {
  const files = fs.readdirSync(STATIC_DIR).filter((f) => f.endsWith('.css')).sort();
  assert.ok(files.length > 0, `${STATIC_DIR} 下没有 CSS 文件`);
  return files.flatMap((f) => parseRules(fs.readFileSync(path.join(STATIC_DIR, f), 'utf8'))
    .map((rule) => ({ ...rule, file: f })));
}

const RULES = loadStaticRules();

function hasDeclaration(rule, prop, value) {
  return rule.declarations.some((d) => d.prop === prop && d.value === value);
}

test('滚动容器同时被 Firefox 与 WebKit 两个滚动条隐藏分支命中（AC-001）', () => {
  for (const selector of SCROLL_CONTAINERS) {
    const firefox = RULES.some(
      (rule) => rule.selectors.includes(selector) && hasDeclaration(rule, 'scrollbar-width', 'none'),
    );
    assert.ok(firefox, `${selector} 未被 Firefox 分支 scrollbar-width: none 命中`);
    const webkit = RULES.some(
      (rule) => rule.selectors.includes(`${selector}::-webkit-scrollbar`)
        && hasDeclaration(rule, 'display', 'none'),
    );
    assert.ok(webkit, `${selector} 未被 WebKit 分支 ::-webkit-scrollbar { display: none } 命中`);
  }
});

test('滚动容器的 overflow 取值与改动前逐条一致，且都不是 hidden（AC-002）', () => {
  for (const [selector, expected] of Object.entries(EXPECTED_OVERFLOW)) {
    const actual = {};
    for (const rule of RULES) {
      if (!rule.selectors.includes(selector)) continue;
      for (const d of rule.declarations) {
        if (d.prop === 'overflow' || d.prop === 'overflow-x' || d.prop === 'overflow-y') {
          actual[d.prop] = d.value;
        }
      }
    }
    assert.deepEqual(actual, expected, `${selector} 的 overflow 取值发生漂移`);
    for (const [prop, value] of Object.entries(actual)) {
      assert.notEqual(value, 'hidden', `${selector} 的 ${prop} 被改成 hidden，滚动能力丢失`);
    }
  }
});

test('滚动条隐藏规则不作用于 *、html、body，页面级滚动条保留（AC-003）', () => {
  for (const rule of RULES) {
    for (const selector of rule.selectors) {
      const base = selector.replace(/::-webkit-scrollbar(-[a-z-]+)?$/, '');
      if (!PAGE_LEVEL_SELECTORS.has(base)) continue;
      assert.ok(
        !hasDeclaration(rule, 'scrollbar-width', 'none'),
        `${rule.file} 中 ${selector} 上出现 scrollbar-width: none，会隐藏页面级滚动条`,
      );
      assert.ok(
        !selector.includes('::-webkit-scrollbar'),
        `${rule.file} 中出现 ${selector} 规则，会隐藏页面级滚动条`,
      );
    }
  }
});
