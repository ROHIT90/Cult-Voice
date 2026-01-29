import express from "express";
import { WebSocketServer } from "ws";
import axios from "axios";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const app = express();
app.get("/", (_, res) => res.send("Exotel Voicebot + ElevenLabs + STT ✅"));

const server = app.listen(process.env.PORT || 3000, () =>
  console.log("Listening on", process.env.PORT || 3000)
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** ---------------- ElevenLabs TTS ---------------- */
async function elevenTTS(text) {
  const voiceId = process.env.ELEVEN_VOICE_ID;
  const apiKey = process.env.ELEVEN_API_KEY;
  const modelId = process.env.ELEVEN_MODEL_ID || "eleven_turbo_v2_5";

  if (!voiceId || !apiKey) throw new Error("Missing ELEVEN_VOICE_ID / ELEVEN_API_KEY");

  const r = await axios({
    method: "POST",
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    data: {
      text,
      model_id: modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    responseType: "arraybuffer",
  });

  return Buffer.from(r.data); // mp3
}

/** ---------------- MP3 -> PCM (s16le 8k mono) ---------------- */
async function mp3ToPcm8kS16le(mp3Buf) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-ac", "1",
      "-ar", "8000",
      "-f", "s16le",
      "pipe:1",
    ]);
    const chunks = [];
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("ffmpeg failed"))));
    ff.on("error", reject);
    ff.stdin.write(mp3Buf);
    ff.stdin.end();
  });
}

/** ---------------- Send PCM in 20ms frames ---------------- */
async function sendPcmStream(ws, pcmBuf, chunkBytes = 320, delayMs = 20) {
  for (let i = 0; i < pcmBuf.length; i += chunkBytes) {
    const chunk = pcmBuf.subarray(i, i + chunkBytes);
    ws.send(JSON.stringify({ event: "media", media: { payload: chunk.toString("base64") } }));
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/** ---------------- PCM -> WAV (for Whisper) ---------------- */
function pcmS16leToWav(pcmBuf, sampleRate = 8000, channels = 1) {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuf.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);        // PCM fmt chunk size
  header.writeUInt16LE(1, 20);         // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuf.length, 40);

  return Buffer.concat([header, pcmBuf]);
}

/** ---------------- STT via OpenAI Whisper ---------------- */
async function transcribePcm(pcmBuf) {
  // pcmBuf is s16le, 8kHz, mono
  const wav = pcmS16leToWav(pcmBuf, 8000, 1);

  const file = await toFile(wav, "audio.wav", { type: "audio/wav" });

  const resp = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
    // If you want to bias language, uncomment one:
    // language: "en",
    // language: "hi",
  });

  return (resp.text || "").trim();
}

/** ---------------- Greeting cache ---------------- */
const GREETING_TEXT = "Hello! Welcome to Cult Sector 62. Hindi ya English?";
let cachedGreetingPcm = null;

async function warmupGreeting() {
  const mp3 = await elevenTTS(GREETING_TEXT);
  cachedGreetingPcm = await mp3ToPcm8kS16le(mp3);
  console.log("Greeting cached ✅");
}
warmupGreeting().catch((e) => console.error("Greeting warmup failed:", e.message));

/** ---------------- WebSocket: Exotel Voicebot ---------------- */
const wss = new WebSocketServer({ server, path: "/voicebot" });

wss.on("connection", (ws) => {
  console.log("WS connected");

  // per-call state
  let inboundChunks = [];
  let silenceTimer = null;
  let isSpeaking = false;      // avoid transcribing our own greeting if Exotel echoes audio
  let transcriptionInFlight = false;

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);

    // If no audio for 800ms, treat as utterance end
    silenceTimer = setTimeout(async () => {
      if (!inboundChunks.length) return;
      if (isSpeaking) return;
      if (transcriptionInFlight) return;

      transcriptionInFlight = true;
      const pcm = Buffer.concat(inboundChunks);
      inboundChunks = [];

      try {
        const text = await transcribePcm(pcm);
        if (text) console.log("USER SAID:", text);
        else console.log("USER SAID: (no speech detected)");
      } catch (e) {
        console.error("Transcription failed:", e.message);
      } finally {
        transcriptionInFlight = false;
      }
    }, 800);
  }

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      console.log("start event received");
      try {
        isSpeaking = true;
        if (!cachedGreetingPcm) await warmupGreeting();
        await sendPcmStream(ws, cachedGreetingPcm);
        console.log("Greeting sent ✅");
      } catch (e) {
        console.error("Greeting send failed:", e.message);
        ws.close();
      } finally {
        // small delay to avoid capturing tail end / echo of greeting
        setTimeout(() => { isSpeaking = false; }, 500);
      }
      return;
    }

    // Incoming caller audio
    if (msg.event === "media") {
      const b64 = msg.media?.payload;
      if (!b64) return;

      // Exotel sends base64 PCM (s16le 8k mono) to us (as per your working setup)
      const audio = Buffer.from(b64, "base64");
      inboundChunks.push(audio);

      resetSilenceTimer();
      return;
    }

    if (msg.event === "stop") {
      console.log("stop event");
      if (silenceTimer) clearTimeout(silenceTimer);
      ws.close();
      return;
    }
  });

  ws.on("close", () => console.log("WS closed"));
});
