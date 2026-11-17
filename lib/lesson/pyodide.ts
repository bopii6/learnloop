"use client";

// 浏览器内 Python（Pyodide / WebAssembly）：编程类练习就地运行、就地判对错，零服务器成本。
// 首次使用时从 CDN 加载运行时（约 10MB），import 了 pandas / numpy 时自动按需加载对应包。
// 判题：学员代码与参考答案各在独立命名空间里跑一遍（都接在隐藏的 setup 之后），比对打印输出。
// 样板阶段在主线程运行（练习代码都很短）；正式版应挪到 Web Worker，防死循环卡住页面。

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

interface PyodideApi {
  runPythonAsync: (code: string, opts?: { globals?: unknown }) => Promise<unknown>;
  loadPackagesFromImports: (code: string) => Promise<void>;
  setStdout: (opts: { batched: (s: string) => void }) => void;
  setStderr: (opts: { batched: (s: string) => void }) => void;
  globals: { get: (name: string) => (() => unknown) & { call?: unknown } };
}

declare global {
  interface Window {
    loadPyodide?: (opts: { indexURL: string }) => Promise<PyodideApi>;
  }
}

let pyodidePromise: Promise<PyodideApi> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Python 运行环境加载失败，请检查网络后重试"));
    document.head.appendChild(s);
  });
}

/** 预热：进入有编程练习的课时提前加载，学员写完代码点运行时基本已就绪 */
export function getPyodide(): Promise<PyodideApi> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      await loadScript(`${PYODIDE_BASE}pyodide.js`);
      if (!window.loadPyodide) throw new Error("Python 运行环境加载失败");
      return window.loadPyodide({ indexURL: PYODIDE_BASE });
    })();
    pyodidePromise.catch(() => {
      pyodidePromise = null; // 失败可重试
    });
  }
  return pyodidePromise;
}

export interface RunResult {
  stdout: string;
  error?: string;
}

/** 在全新命名空间里运行一段代码，收集打印输出；报错只保留最后几行（学员看得懂的部分） */
export async function runPython(code: string): Promise<RunResult> {
  const py = await getPyodide();
  await py.loadPackagesFromImports(code);
  let out = "";
  py.setStdout({ batched: (s) => (out += s + "\n") });
  py.setStderr({ batched: (s) => (out += s + "\n") });
  const ns = (py.globals.get("dict") as unknown as () => unknown)();
  try {
    await py.runPythonAsync(code, { globals: ns });
    return { stdout: out };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    const lines = msg.trim().split("\n");
    return { stdout: out, error: lines.slice(-4).join("\n") };
  }
}

const norm = (s: string) =>
  s
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim();

export interface JudgeResult {
  pass: boolean;
  learner: RunResult;
  expected: string;
}

/** 判题：学员输出 == 参考答案输出 */
export async function judgeCode(setup: string, learnerCode: string, solution: string): Promise<JudgeResult> {
  const prefix = setup ? `${setup}\n` : "";
  const learner = await runPython(prefix + learnerCode);
  const ref = await runPython(prefix + solution);
  const expected = ref.error ? "" : norm(ref.stdout);
  const pass = !learner.error && expected.length > 0 && norm(learner.stdout) === expected;
  return { pass, learner, expected };
}
