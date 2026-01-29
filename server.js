import express from "express";
import { WebSocketServer } from "ws";
import axios from "axios";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const app = express();

// Health endpoint (Render uses your open port as “healthy”)
app.get("/", (_, res) => res.send("Cult Voice ✅"));

const PORT = Number(process.env.PORT || 3000);

// ✅ Bind immediately (do not wait for warmups)
const server = app.listen(PORT, () => {
  console.log("Listening on", PORT);
});

// Create OpenAI client only if key exists (don’t crash)
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

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

  return Buffer.from(r.data);
}

/** MP3 -> PCM (s16le 8k mono) */
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

/** Send PCM frames */
async function sendPcmStream(ws, pcmBuf, chunkBytes = 320, delayMs = 20) {
  for (let i = 0; i < pcmBuf.length; i += chunkBytes) {
    const chunk = pcmBuf.subarray(i, i + chunkBytes);
    ws.send(JSON.stringify({ event: "media", media: { payload: chunk.toString("base64") } }));
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/** RAW -> WAV (Whisper) */
async function rawToWavForWhisper(rawBuf, inCodec = "s16le") {
  return new Promise((resolve, reject) => {
    const fmt = inCodec === "mulaw" ? "mulaw" : inCodec === "alaw" ? "alaw" : "s16le";
    const ff = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      "-f", fmt,
      "-ar", "8000",
      "-ac", "1",
      "-i", "pipe:0",
      "-ar", "16000",
      "-ac", "1",
      "-f", "wav",
      "pipe:1",
    ]);
    const chunks = [];
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("ffmpeg raw->wav failed"))));
    ff.on("error", reject);
    ff.stdin.write(rawBuf);
    ff.stdin.end();
  });
}

async function transcribeRawInbound(rawBuf) {
  if (!openai) throw new Error("OPENAI_API_KEY not set");
  const inCodec = process.env.IN_CODEC || "s16le";
  const wav = await rawToWavForWhisper(rawBuf, inCodec);
  const file = await toFile(wav, "audio.wav", { type: "audio/wav" });
  const resp = await openai.audio.transcriptions.create({ model: "whisper-1", file });
  return (resp.text || "").trim();
}

/** Greeting cache */
const GREETING_TEXT = "Hello! Welcome to Cult Sector 62. Hindi ya English?";
let cachedGreetingPcm = null;

async function warmupGreeting() {
  try {
    console.log("Warming up greeting...");
    const mp3 = await elevenTTS(GREETING_TEXT);
    cachedGreetingPcm = await mp3ToPcm8kS16le(mp3);
    console.log("Greeting ready ✅");
  } catch (e) {
    console.log("Greeting warmup skipped:", e.message);
  }
}

// ✅ Warmup in background (won’t block deploy)
setTimeout(warmupGreeting, 0);

/** WebSocket */
const wss = new WebSocketServer({ server, path: "/voicebot" });

wss.on("connection", (ws) => {
  console.log("WS connected");

  let inboundChunks = [];
  let silenceTimer = null;
  let transcriptionInFlight = false;

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(async () => {
      if (!inboundChunks.length || transcriptionInFlight) return;

      transcriptionInFlight = true;
      const rawInbound = Buffer.concat(inboundChunks);
      inboundChunks = [];

      try {
        const text = await transcribeRawInbound(rawInbound);
        console.log("USER SAID:", text || "(empty)");
      } catch (e) {
        console.log("STT skipped:", e.message);
      } finally {
        transcriptionInFlight = false;
      }
    }, 800);
  }

  ws.on("message", async (raw) => {
    // Accept both JSON messages and binary frames
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      inboundChunks.push(Buffer.from(raw));
      resetSilenceTimer();
      return;
    }

    if (msg.event === "start") {
      try {
        if (!cachedGreetingPcm) await warmupGreeting();
        if (cachedGreetingPcm) await sendPcmStream(ws, cachedGreetingPcm);
      } catch (e) {
        console.log("Greeting send failed:", e.message);
      }
      return;
    }

    if (msg.event === "media") {
      const b64 = msg.media?.payload;
      if (!b64) return;
      inboundChunks.push(Buffer.from(b64, "base64"));
      resetSilenceTimer();
      return;
    }

    if (msg.event === "stop") {
      console.log("stop event");
      if (silenceTimer) clearTimeout(silenceTimer);
      ws.close();
    }
  });

  ws.on("close", () => console.log("WS closed"));
});
