// 供 node-version-warning 集成测试用：抢在 conductor.mjs 被 import 前伪造 process.version，
// 驱动其 main() 走真实 CLI 子命令路径（conductor.mjs 自身的顶层自启动 guard 只在直接执行时触发，
// import 时不会自动跑 main，因此这里显式调用）。
import { pathToFileURL } from 'node:url';

const fakeVersion = process.env.FAKE_NODE_VERSION;
if (fakeVersion) Object.defineProperty(process, 'version', { value: fakeVersion, configurable: true });

const conductorEntry = process.env.CONDUCTOR_ENTRY;
const argv = JSON.parse(process.env.FAKE_ARGV || '[]');
const mod = await import(pathToFileURL(conductorEntry).href);
await mod.main(argv);
