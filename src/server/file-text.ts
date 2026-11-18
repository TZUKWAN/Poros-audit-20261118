import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import { SaxesParser } from "saxes";
import { fromBufferPromise, type ZipFile } from "yauzl";
import path from "node:path";

export const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".pdf", ".docx", ".xlsx"]);
const MAX_TEXT = 24000;
type TextPreview = { text: string; truncated: boolean };

async function xmlParts(data: Buffer, want: (name: string) => boolean) {
  const zip: ZipFile = await fromBufferPromise(data, {
    validateEntrySizes: true,
    strictFileNames: true,
  });
  const parts = new Map<string, string>();
  try {
    if (zip.entryCount > 1500) throw new Error("文档压缩包包含过多条目");
    let expanded = 0;
    for await (const entry of zip.eachEntry()) {
      if (!want(entry.fileName)) continue;
      expanded += entry.uncompressedSize;
      if (expanded > 8 * 1024 * 1024 || entry.uncompressedSize > 3 * 1024 * 1024)
        throw new Error("文档解压文本超过处理上限");
      if (parts.has(entry.fileName)) throw new Error("文档包含重复部件");
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      parts.set(
        entry.fileName,
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    }
    return parts;
  } finally {
    zip.close();
  }
}

type OpenTag = (tag: string, attributes: Record<string, string>) => void;
function readXml(
  content: string,
  open: OpenTag,
  text: (value: string) => void,
  close: (tag: string) => void,
) {
  const parser = new SaxesParser();
  const local = (name: string) => name.slice(name.lastIndexOf(":") + 1);
  parser.on("doctype", () => {
    throw new Error("不支持含 DTD 的文档");
  });
  parser.on("opentag", (tag) => open(local(tag.name), tag.attributes));
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", (tag) => close(local(tag.name)));
  parser.write(content).close();
}

async function wordText(data: Buffer) {
  const xml = (await xmlParts(data, (name) => name === "word/document.xml")).get(
    "word/document.xml",
  );
  if (!xml) throw new Error("没有 Word 正文部件");
  let inText = false;
  let output = "";
  const append = (value: string) => {
    if (output.length <= MAX_TEXT) output += value;
  };
  readXml(
    xml,
    (tag) => {
      if (tag === "t") inText = true;
      if (tag === "tab") append("\t");
      if (tag === "br") append("\n");
    },
    (value) => {
      if (inText) append(value);
    },
    (tag) => {
      if (tag === "t") inText = false;
      if (tag === "p") append("\n");
    },
  );
  return output;
}

async function workbookText(data: Buffer) {
  const parts = await xmlParts(
    data,
    (name) =>
      ["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml"].includes(name) ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(name),
  );
  const workbook = parts.get("xl/workbook.xml"),
    rels = parts.get("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new Error("没有可解析的 Excel 工作簿");
  const targets = new Map<string, string>();
  readXml(
    rels,
    (tag, at) => {
      if (tag !== "Relationship" || at.TargetMode === "External" || !at.Id || !at.Target) return;
      const target = at.Target.startsWith("/")
        ? at.Target.slice(1)
        : path.posix.normalize("xl/" + at.Target);
      if (target.startsWith("xl/worksheets/") && parts.has(target)) targets.set(at.Id, target);
    },
    () => {},
    () => {},
  );
  const names = new Map<string, string>();
  readXml(
    workbook,
    (tag, at) => {
      const target = targets.get(at["r:id"] ?? "");
      if (tag === "sheet" && target && at.name) names.set(target, at.name);
    },
    () => {},
    () => {},
  );
  const shared: string[] = [];
  const sharedXml = parts.get("xl/sharedStrings.xml");
  if (sharedXml) {
    let current = "",
      inText = false;
    readXml(
      sharedXml,
      (tag) => {
        if (tag === "si") current = "";
        if (tag === "t") inText = true;
      },
      (value) => {
        if (inText) current += value;
      },
      (tag) => {
        if (tag === "t") inText = false;
        if (tag === "si") shared.push(current);
      },
    );
  }
  let output = "";
  for (const [part, name] of names) {
    if (output.length > MAX_TEXT) break;
    output += `工作表：${name}\n`;
    let type = "",
      ref = "",
      field = "",
      value = "",
      formula = "";
    readXml(
      parts.get(part)!,
      (tag, at) => {
        if (tag === "c") {
          type = at.t ?? "";
          ref = at.r ?? "";
          value = "";
          formula = "";
        }
        if (tag === "v" || tag === "t" || tag === "f") field = tag;
      },
      (chunk) => {
        if (field === "f") formula += chunk;
        if (field === "v" || field === "t") value += chunk;
      },
      (tag) => {
        if (tag === field) field = "";
        if (tag === "c" && output.length <= MAX_TEXT) {
          const item =
            type === "s" ? shared[Number(value)] : value || (formula ? "=" + formula : "");
          if (item) output += `${ref}=${item}\t`;
        }
        if (tag === "row" && output.length <= MAX_TEXT) output += "\n";
      },
    );
  }
  if (!output.trim()) throw new Error("没有可读取的 Excel 工作表");
  return output;
}

async function pdfText(data: Buffer) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const load = getDocument({
    data: Uint8Array.from(data),
    verbosity: 0,
    stopAtErrors: true,
    useSystemFonts: false,
    disableFontFace: true,
    useWasm: false,
  });
  try {
    const doc = await load.promise;
    let output = "";
    let page = 1;
    for (; page <= Math.min(80, doc.numPages) && output.length <= MAX_TEXT; page++) {
      const source = await doc.getPage(page);
      const content = await source.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
        .join("")
        .trim();
      if (text) output += `第 ${page} 页\n${text}\n\n`;
      source.cleanup();
    }
    return { text: output, truncated: page <= doc.numPages };
  } finally {
    await load.destroy();
  }
}

async function parse(name: string, data: Buffer): Promise<TextPreview> {
  const ext = path.extname(name).toLowerCase();
  let output;
  if (ext === ".pdf") output = await pdfText(data);
  else if (ext === ".xlsx") output = { text: await workbookText(data), truncated: false };
  else if (ext === ".docx") output = { text: await wordText(data), truncated: false };
  else output = { text: new TextDecoder("utf-8", { fatal: true }).decode(data), truncated: false };
  if (!output.text.trim()) throw new Error("文件没有可提取的文本。扫描 PDF 需要先进行文字识别");
  return {
    text: output.text.slice(0, MAX_TEXT).trim(),
    truncated: output.truncated || output.text.length > MAX_TEXT,
  };
}

if (!isMainThread && workerData?.porosFileText) {
  void parse(workerData.name, Buffer.from(workerData.bytes)).then(
    (preview) => parentPort?.postMessage({ preview }),
    (error: unknown) =>
      parentPort?.postMessage({
        error:
          error instanceof Error && /[\u4e00-\u9fa5]/.test(error.message)
            ? error.message
            : "文件格式无效、受密码保护或内容无法读取",
      }),
  );
}

export function extractFileText(
  name: string,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<TextPreview> {
  if (!TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()))
    return Promise.reject(new Error("此格式仅支持保存和下载"));
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { porosFileText: true, name, bytes },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 24 },
    });
    let settled = false;
    const timer = setTimeout(() => finish(new Error("文件解析超时")), 10000);
    const abort = () => finish(signal?.reason ?? new Error("文件解析已取消"));
    const finish = (error?: unknown, result?: TextPreview) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if (result) resolve(result);
      else reject(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: { preview?: TextPreview; error?: string }) =>
      finish(new Error(message.error ?? "文件解析失败"), message.preview),
    );
    worker.once("error", () => finish(new Error("文件解析器无法处理此文档")));
    worker.once("exit", () => finish(new Error("文件解析器已退出")));
  });
}
