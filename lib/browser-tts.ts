// 浏览器自带语音：云端 TTS 没配置（501）或不可用（未登录）时兜底——课堂不能哑巴。
// Windows / Edge 上是微软音色（Edge 在线的「晓晓」最自然，其次是系统自带的慧慧 / 康康 / 瑶瑶）。
// 进度：优先用 boundary 事件的字符位置，没有就按语速估算（只到 97%，真正结束以 end 事件为准）。

const PREFERRED = [/Xiaoxiao/i, /Xiaoyi/i, /Yunxi/i, /Yunjian/i, /Yunyang/i, /Huihui/i, /Yaoyao/i, /Kangkang/i, /Tingting/i, /Google.*(普通话|Mandarin|中国)/i];

let chosen: SpeechSynthesisVoice | null = null;
// 保持对当前朗读的引用：Chrome 会回收没人引用的 utterance，导致 end 事件不触发
let current: SpeechSynthesisUtterance | null = null;

export function browserTtsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

function pickVoice(): SpeechSynthesisVoice | null {
  const all = window.speechSynthesis.getVoices();
  const zh = all.filter((v) => /^zh/i.test(v.lang) && !/(HK|TW|yue)/i.test(v.lang));
  if (zh.length === 0) return null;
  for (const re of PREFERRED) {
    const hit = zh.find((v) => re.test(v.name));
    if (hit) return hit;
  }
  return zh.find((v) => /Microsoft/i.test(v.name)) || zh[0];
}

/** 音色列表是异步加载的：首次调用最多等 1 秒 */
async function ensureVoice(): Promise<SpeechSynthesisVoice | null> {
  if (chosen) return chosen;
  chosen = pickVoice();
  if (chosen) return chosen;
  await new Promise<void>((resolve) => {
    const done = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", done);
      resolve();
    };
    window.speechSynthesis.addEventListener("voiceschanged", done);
    window.setTimeout(done, 1000);
  });
  chosen = pickVoice();
  return chosen;
}

/** 提前触发音色加载（进课堂时调用一次，开讲时就不用再等） */
export function warmBrowserVoices(): void {
  if (!browserTtsSupported()) return;
  void ensureVoice();
}

export interface BrowserSpeech {
  stop: () => void;
  pause: () => void;
  resume: () => void;
}

/**
 * 朗读一句。返回 null 表示这台机器没有可用的中文音色（调用方退回无声字幕）。
 * onProgress 给 0..1 的进度（驱动字幕与板书），onEnd 在读完 / 被停止时调用一次。
 */
export async function speakBrowser(
  text: string,
  opts: { rate: number; isPaused: () => boolean; onProgress: (p: number) => void; onEnd: () => void }
): Promise<BrowserSpeech | null> {
  if (!browserTtsSupported() || !text) return null;
  const voice = await ensureVoice();
  if (!voice) return null;
  const synth = window.speechSynthesis;
  synth.cancel();

  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = Math.max(0.5, Math.min(2, opts.rate));
  current = u;

  // 估算：中文约每字 230ms（1 倍速）；boundary 来了就以它为准
  const estMs = Math.max(1000, text.length * 230) / u.rate;
  let ended = false;
  let elapsed = 0;
  let last = performance.now();
  let boundaryP = -1;
  let raf = 0;
  const end = () => {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(raf);
    window.clearTimeout(guard);
    if (current === u) current = null;
    opts.onProgress(1);
    opts.onEnd();
  };
  const tick = (now: number) => {
    if (ended) return;
    if (!opts.isPaused()) elapsed += now - last;
    last = now;
    const est = Math.min(0.97, elapsed / estMs);
    // 有 boundary：估算值不许跑到真实位置前面太多，也不往回退
    const p = boundaryP >= 0 ? Math.min(0.97, Math.max(boundaryP, Math.min(est, boundaryP + 0.12))) : est;
    opts.onProgress(p);
    raf = requestAnimationFrame(tick);
  };
  u.onboundary = (e) => {
    const p = (e.charIndex + (e.charLength || 1)) / text.length;
    if (p > boundaryP) boundaryP = Math.min(1, p);
  };
  u.onend = end;
  u.onerror = end;
  // 保险丝：个别浏览器偶发不触发 end
  const guard = window.setTimeout(end, estMs * 2.5 + 4000);

  synth.speak(u);
  if (opts.isPaused()) synth.pause();
  raf = requestAnimationFrame(tick);

  return {
    stop: () => {
      u.onend = null;
      u.onerror = null;
      synth.cancel();
      end();
    },
    pause: () => synth.pause(),
    resume: () => synth.resume(),
  };
}
