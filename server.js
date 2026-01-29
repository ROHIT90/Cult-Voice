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

/** ---------------- MP3 -> PCM (s16le 8k mono) for Exotel playback ---------------- */
async function mp3ToPcm8kS16le(mp3Buf) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-ac",
      "1",
      "-ar",
      "8000",
      "-f",
      "s16le", // raw signed 16-bit LE PCM
      "pipe:1",
    ]);

    const chunks = [];
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("ffmpeg convert failed"))));
    ff.on("error", reject);

    ff.stdin.write(mp3Buf);
    ff.stdin.end();
  });
}

/** ---------------- Send PCM in small frames (20ms) ----------------
 * 20ms @ 8kHz mono s16le => 160 samples => 320 bytes
 */
async function sendPcmStream(ws, pcmBuf, chunkBytes = 320, delayMs = 20) {
  for (let i = 0; i < pcmBuf.length; i += chunkBytes) {
    const chunk = pcmBuf.subarray(i, i + chunkBytes);
    ws.send(
      JSON.stringify({
        event: "media",
        media: { payload: chunk.toString("base64") },
      })
    );
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/** ---------------- Inbound RAW -> WAV for Whisper using ffmpeg ----------------
 * Exotel inbound audio may be:
 *  - s16le (raw linear PCM)
 *  - mulaw (PCMU)
 *  - alaw  (PCMA)
 *
 * Set env var IN_CODEC to: s16le | mulaw | alaw
 * We'll convert 8kHz mono raw -> WAV 16kHz mono (better for Whisper).
 */
async function rawToWavForWhisper(rawBuf, inCodec = "s16le") {
  return new Promise((resolve, reject) => {
    const fmt = inCodec === "mulaw" ? "mulaw" : inCodec === "alaw" ? "alaw" : "s16le";

    const ff = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      fmt,
      "-ar",
      "8000",
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "wav",
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

/** ---------------- STT via OpenAI Whisper ---------------- */
async function transcribeRawInbound(rawBuf) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const inCodec = process.env.IN_CODEC || "s16le";
  const wav = await rawToWavForWhisper(rawBuf, inCodec);

  const file = await toFile(wav, "audio.wav", { type: "audio/wav" });

  const resp = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
  });

  return (resp.text || "").trim();
}

/** ---------------- Greeting cache ---------------- */
const GREETING_TEXT = "Hello! Welcome to Cult Sector 62. Hindi ya English?";
let cachedGreetingPcm = null;
let greetingReady = false;

async function warmupGreeting() {
  try {
    console.log("Warming up greeting via ElevenLabs...");
    const mp3 = await elevenTTS(GREETING_TEXT);
    cachedGreetingPcm = await mp3ToPcm8kS16le(mp3);
    greetingReady = true;
    console.log("Greeting ready ✅");
  } catch (e) {
    console.error("Greeting warmup failed:", e.message);
    greetingReady = false;
  }
}
warmupGreeting();

/** ---------------- WebSocket: Exotel Voicebot ---------------- */
const wss = new WebSocketServer({ server, path: "/voicebot" });

wss.on("connection", (ws) => {
  console.log("WS connected");

  // per-call state
  let inboundChunks = [];
  let silenceTimer = null;
  let isSpeaking = false; // reduce chance of transcribing our own greeting if audio echo happens
  let transcriptionInFlight = false;

  // debug counters
  let mediaFrames = 0;
  let mediaBytes = 0;
  let debugEvents = 0;

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);

    // If no audio for 800ms, treat as utterance end
    silenceTimer = setTimeout(async () => {
      if (!inboundChunks.length) return;
      if (isSpeaking) return;
      if (transcriptionInFlight) return;

      transcriptionInFlight = true;

      const rawInbound = Buffer.concat(inboundChunks);
      inboundChunks = [];

      try {
        const text = await transcribeRawInbound(rawInbound);
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
    // 1) Try JSON first (start/stop/media usually come as JSON)
    let msg = null;
    try {
      const asText = raw.toString();
      msg = JSON.parse(asText);
    } catch {
      // 2) If not JSON, treat as BINARY AUDIO
      const audioBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      inboundChunks.push(audioBuf);

      mediaFrames++;
      mediaBytes += audioBuf.length;
      if (mediaFrames % 25 === 0) {
        console.log(`(binary) media frames=${mediaFrames} bytes=${mediaBytes}`);
      }

      resetSilenceTimer();
      return;
    }

    // Debug: log first few events so we can confirm structure
    if (debugEvents < 10) {
      console.log("IN EVENT:", msg.event, "keys:", Object.keys(msg));
      debugEvents++;
    }

    if (msg.event === "start") {
      console.log("start event received");

      try {
        isSpeaking = true;
        if (!greetingReady || !cachedGreetingPcm) await warmupGreeting();
        await sendPcmStream(ws, cachedGreetingPcm);
        console.log("Greeting sent ✅");
      } catch (e) {
        console.error("Greeting send failed:", e.message);
        ws.close();
      } finally {
        // short delay to avoid capturing tail end of greeting
        setTimeout(() => {
          isSpeaking = false;
        }, 500);
      }
      return;
    }

    // JSON media event
    if (msg.event === "media") {
      const b64 = msg.media?.payload;
      if (!b64) {
        console.log("media event but no payload");
        return;
      }

      const audio = Buffer.from(b64, "base64");
      inboundChunks.push(audio);

      mediaFrames++;
      mediaBytes += audio.length;
      if (mediaFrames % 25 === 0) {
        console.log(`(json) media frames=${mediaFrames} bytes=${mediaBytes}`);
      }

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
