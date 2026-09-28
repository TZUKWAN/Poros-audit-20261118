// vitest 全局 setup：pi-web-ui 为 Lit 浏览器组件库，其依赖 pdfjs-dist 在顶层
// 引用浏览器全局（DOMMatrix/Path2D）。Node 测试环境补最小 stub（DECISIONS D7）。
type MatrixLike = { multiply: () => MatrixLike; translate: () => MatrixLike; scale: () => MatrixLike };
type GlobalsWithBrowserBits = typeof globalThis & {
  DOMMatrix?: (new () => MatrixLike) & { fromMatrix: () => MatrixLike };
  Path2D?: new () => unknown;
};

const matrixStub: MatrixLike = {
  multiply: () => matrixStub,
  translate: () => matrixStub,
  scale: () => matrixStub,
};
type MatrixCtor = new () => MatrixLike;
const matrixCtor = class DOMMatrix implements MatrixLike {
  multiply = () => matrixStub;
  translate = () => matrixStub;
  scale = () => matrixStub;
  static fromMatrix = () => matrixStub;
} as unknown as GlobalsWithBrowserBits["DOMMatrix"] & MatrixCtor;

const g = globalThis as GlobalsWithBrowserBits;
if (typeof g.DOMMatrix === "undefined") g.DOMMatrix = matrixCtor;
if (typeof g.Path2D === "undefined") g.Path2D = class Path2D {};
