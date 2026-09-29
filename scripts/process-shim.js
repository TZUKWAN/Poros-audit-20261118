// 浏览器 bundle 的 process shim（@lmstudio/sdk 经 pi-web-ui CustomProviderCard 引入）
const process = {
  env: { NODE_ENV: "production" },
  platform: "browser",
  version: "",
  versions: {},
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  cwd: () => "/",
  argv: [],
  exit: () => {
    /* no-op in browser */
  },
};
export default process;
