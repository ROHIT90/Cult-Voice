// server.js
import express from "express";
import { WebSocketServer } from "ws";
import axios from "axios";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const app = express();
app.get("/", (_, res) => res.send("Cult Voice ✅ (Greeting + STT + AI Reply)"));

const PORT = Number(process.env.PORT || 3000);

// ✅ Bind immediately (Render needs an open port fast)
const server = app.listen(PORT, () => console.log("Listening on", PORT));

// OpenAI client (don’t crash if missing)
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

  return Buffer.from(r.data); // mp3 bytes
}

/** MP3 -> PCM (s16le 8k mono) for Exotel playback */
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
    ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("ffmpeg mp3->pcm failed"))));
    ff.on("error", reject);

    ff.stdin.write(mp3Buf);
    ff.stdin.end();
  });
}

/** Send PCM frames (20ms @ 8kHz s16le mono => 320 bytes) */
async function sendPcmStream(ws, pcmBuf, chunkBytes = 320, delayMs = 20) {
  for (let i = 0; i < pcmBuf.length; i += chunkBytes) {
    const chunk = pcmBuf.subarray(i, i + chunkBytes);
    ws.send(JSON.stringify({ event: "media", media: { payload: chunk.toString("base64") } }));
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/** RAW inbound -> WAV (16k mono) for Whisper
 * Set env var IN_CODEC to: s16le | mulaw | alaw
 */
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

/** STT via Whisper */
async function transcribeRawInbound(rawBuf) {
  if (!openai) throw new Error("OPENAI_API_KEY not set");
  const inCodec = process.env.IN_CODEC || "s16le";
  const wav = await rawToWavForWhisper(rawBuf, inCodec);
  const file = await toFile(wav, "audio.wav", { type: "audio/wav" });

  const resp = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
  });

  return (resp.text || "").trim();
}

/** AI response (keeps it short + bilingual) */
async function getAIReply(history, userText) {
  if (!openai) throw new Error("OPENAI_API_KEY not set");

  const system = `
You are the front-desk voice assistant for "Cult Sector 62" gym.
Rules:
- Reply in the SAME language as the caller (Hindi if Hindi, English if English).
- Keep answers 1–2 short sentences (call-friendly).
- If user asks for booking: ask whether they want (1) Trial at center or (2) Callback, then ask preferred day/time.
- If user is unclear: ask one clarifying question.
- Do NOT mention you are an AI. Sound like a helpful receptionist.
`;

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userText },
    ],
  });

  return (completion.choices[0]?.message?.content || "").trim();
}

/** Speak helper: text -> ElevenLabs -> PCM -> stream */
async function speak(ws, text) {
  const mp3 = await elevenTTS(text);
  const pcm = await mp3ToPcm8kS16le(mp3);
  await sendPcmStream(ws, pcm);
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
setTimeout(warmupGreeting, 0);

/** ---------------- WebSocket ----------------
 * IMPORTANT: In Exotel flow use STREAM applet (not Voicebot) to get inbound audio frames.
 */
const wss = new WebSocketServer({ server, path: "/voicebot" });

wss.on("connection", (ws) => {
  console.log("WS connected");

  // per-call state
  let inboundChunks = [];
  let silenceTimer = null;
  let isSpeaking = false;
  let inFlight = false;

  // minimal conversation memory (last ~10 turns)
  const history = [];

  function push(role, content) {
    history.push({ role, content });
    while (history.length > 20) history.shift();
  }

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);

    // End-of-utterance: 800ms no frames
    silenceTimer = setTimeout(async () => {
      if (!inboundChunks.length) return;
      if (isSpeaking) return;
      if (inFlight) return;

      inFlight = true;

      const rawInbound = Buffer.concat(inboundChunks);
      inboundChunks = [];

      try {
        const userText = await transcribeRawInbound(rawInbound);
        if (!userText) {
          inFlight = false;
          return;
        }

        console.log("USER SAID:", userText);
        push("user", userText);

        const answer = await getAIReply(history, userText);
        if (!answer) {
          inFlight = false;
          return;
        }

        console.log("ASSISTANT:", answer);
        push("assistant", answer);

        isSpeaking = true;
        await speak(ws, answer);
      } catch (e) {
        console.log("AI/STT skipped:", e.message);
      } finally {
        // small delay so we don't capture echo of our own TTS
        setTimeout(() => {
          isSpeaking = false;
          inFlight = false;
        }, 400);
      }
    }, 800);
  }

  ws.on("message", async (raw) => {
    // Accept JSON messages AND binary frames
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      // binary audio
      inboundChunks.push(Buffer.from(raw));
      resetSilenceTimer();
      return;
    }

    if (msg.event === "start") {
      console.log("start event received");
      try {
        isSpeaking = true;

        // Use cached greeting if ready; else generate on demand
        if (!cachedGreetingPcm) await warmupGreeting();
        if (cachedGreetingPcm) {
          await sendPcmStream(ws, cachedGreetingPcm);
        } else {
          await speak(ws, GREETING_TEXT);
        }

        push("assistant", GREETING_TEXT);
      } catch (e) {
        console.log("Greeting send failed:", e.message);
      } finally {
        setTimeout(() => (isSpeaking = false), 400);
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
      return;
    }
  });

  ws.on("close", () => console.log("WS closed"));
});
