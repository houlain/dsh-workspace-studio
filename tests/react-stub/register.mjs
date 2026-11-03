// 测试入口的预加载：注册 react → tests/react-stub/shim.mjs 的解析映射。
// 用法见 package.json 的 test 脚本：node --import ./tests/react-stub/register.mjs ...
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
