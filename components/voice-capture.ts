// 语音捕获：麦克风 → 16kHz PCM → 基于音量的断句（VAD）→ 整句 WAV（base64）。
// 用途：Chrome 的原生语音识别（SpeechRecognition）在国内网络不可达时，
// 改走"本地录音 + 服务端云端识别"链路。
export interface VoiceCapture {
  stop(): void;
}

export interface VoiceCaptureOptions {
  /** 一句话结束（静音超时）时回调，wavB64 为 16kHz 单声道 WAV 的 base64 */
  onUtterance: (wavB64: string, durationMs: number) => void;
  onError?: (code: string) => void;
}

const TARGET_RATE = 16000;
const RMS_SPEAK = 0.022; // 说话判定阈值
const RMS_SILENT = 0.012; // 静音判定阈值
const SPEECH_START_FRAMES = 3; // 连续 N 帧超阈值 = 开口
const SPEECH_END_FRAMES = 10; // 连续 N 帧低于阈值 = 说完（≈0.34s/帧@4096/48k）
const MIN_UTTERANCE_FRAMES = 5; // 最短一句话长度，过滤误触发

function encodeWavB64(samples: Int16Array, rate: number): string {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const w = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  // ArrayBuffer → base64
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)) as unknown as number[]);
  }
  return btoa(bin);
}

export async function startVoiceCapture(opts: VoiceCaptureOptions): Promise<VoiceCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  src.connect(proc);
  // 静音增益节点（ScriptProcessor 需要连接到目的地才会跑）
  const sink = ctx.createGain();
  sink.gain.value = 0;
  proc.connect(sink);
  sink.connect(ctx.destination);

  let stopped = false;
  let speaking = false;
  let loudFrames = 0;
  let silentFrames = 0;
  let buffer: Int16Array[] = [];
  let bufferLen = 0;

  const finishUtterance = () => {
    const total = bufferLen;
    if (total >= (TARGET_RATE * MIN_UTTERANCE_FRAMES * 4096) / 48000) {
      const merged = new Int16Array(total);
      let off = 0;
      for (const chunk of buffer) {
        merged.set(chunk, off);
        off += chunk.length;
      }
      const durationMs = Math.round((total / TARGET_RATE) * 1000);
      try {
        opts.onUtterance(encodeWavB64(merged, TARGET_RATE), durationMs);
      } catch {
        // 上游处理失败不影响继续录音
      }
    }
    buffer = [];
    bufferLen = 0;
  };

  proc.onaudioprocess = (e) => {
    if (stopped) return;
    const input = e.inputBuffer.getChannelData(0);
    // 均方根（音量）
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);

    // Float32 → Int16 + 降采样到 16k（48k → 1/3）
    const out = new Int16Array(Math.floor(input.length / 3));
    for (let i = 0; i < out.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i * 3]));
      out[i] = Math.round(s * 32767);
    }

    if (!speaking) {
      if (rms > RMS_SPEAK) {
        loudFrames += 1;
        if (loudFrames >= SPEECH_START_FRAMES) {
          speaking = true;
          silentFrames = 0;
          // 回补最近 3 帧，避免吃掉句首
          buffer = buffer.slice(-2);
          bufferLen = buffer.reduce((s, c) => s + c.length, 0);
          buffer.push(out);
          bufferLen += out.length;
        } else {
          buffer.push(out);
          bufferLen += out.length;
          if (buffer.length > 6) {
            buffer.shift();
            bufferLen -= out.length;
          }
        }
      } else {
        loudFrames = 0;
        buffer = buffer.slice(-2);
      }
    } else {
      buffer.push(out);
      bufferLen += out.length;
      if (rms < RMS_SILENT) {
        silentFrames += 1;
        if (silentFrames >= SPEECH_END_FRAMES) {
          speaking = false;
          loudFrames = 0;
          if (buffer.length >= MIN_UTTERANCE_FRAMES) finishUtterance();
          else {
            buffer = [];
            bufferLen = 0;
          }
        }
      } else {
        silentFrames = 0;
      }
    }
  };

  return {
    stop() {
      stopped = true;
      try {
        proc.disconnect();
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
      } catch {
        // 忽略
      }
    },
  };
}
