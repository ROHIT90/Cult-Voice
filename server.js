import express from "express";
import { WebSocketServer } from "ws";
import axios from "axios";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";

const app = express();
app.get("/", (_, res) => res.send("Exotel Voicebot + ElevenLabs ✅"));

const server = app.listen(process.env.PORT || 3000, () =>
  console.log("Listening on", process.env.PORT || 3000)
);

/** ---------------- ElevenLabs TTS ---------------- */
async function elevenTTS(text) {
  const voiceId = process.env.ELEVEN_VOICE_ID;
  const apiKey = process.env.ELEVEN_API_KEY;
  const modelId = process.env.ELEVEN_MODEL_ID || "eleven_turbo_v2_5";

  if (!voiceId || !apiKey) {
    throw new Error("Missing ELEVEN_VOICE_ID or ELEVEN_API_KEY");
  }

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

/** ---------------- MP3 -> PCM (s16le 8k mono) ----------------
 * Exotel Voicebot WS typically expects base64 Linear PCM (raw) frames.
 * We convert ElevenLabs MP3 to raw PCM 16-bit little-endian, 8000 Hz, mono.
 */
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
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error("ffmpeg conversion failed"));
    });
    ff.on("error", reject);

    ff.stdin.write(mp3Buf);
    ff.stdin.end();
  });
}

/** ---------------- Send PCM in small frames ----------------
 * 20ms @ 8kHz mono s16le => 160 samples => 320 bytes
 * Chunking avoids “one big payload” issues and feels more like real streaming.
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

/** ---------------- Cache greeting (so every call is fast) ---------------- */
const GREETING_TEXT =
  "Hello! Welcome to Cult Sector 62. Hindi ya English?";

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
// Start warmup (non-blocking)
warmupGreeting();

/** ---------------- WebSocket: Exotel Voicebot ---------------- */
const wss = new WebSocketServer({ server, path: "/voicebot" });

wss.on("connection", (ws) => {
  console.log("WS connected");

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Exotel sends a start event; on start we speak the greeting.
    if (msg.event === "start") {
      console.log("start event received");

      try {
        // If warmup failed (keys missing or first boot), generate on-demand
        if (!greetingReady || !cachedGreetingPcm) {
          console.log("Greeting not cached yet; generating on-demand...");
          const mp3 = await elevenTTS(GREETING_TEXT);
          cachedGreetingPcm = await mp3ToPcm8kS16le(mp3);
          greetingReady = true;
        }

        await sendPcmStream(ws, cachedGreetingPcm);
        console.log("Greeting sent ✅");
      } catch (e) {
        console.error("Failed to send greeting:", e.message);
        // If we fail, just close to avoid hanging the caller
        ws.close();
      }
    }

    if (msg.event === "stop") {
      console.log("stop event");
      ws.close();
    }
  });

  ws.on("close", () => console.log("WS closed"));
});
