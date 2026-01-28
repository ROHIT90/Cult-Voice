import express from "express";
import { WebSocketServer } from "ws";

const app = express();
app.get("/", (_, res) => res.send("Exotel Voicebot POC ✅"));

const server = app.listen(process.env.PORT || 3000, () =>
  console.log("Listening on", process.env.PORT || 3000)
);

/**
 * Exotel Voicebot applet uses WebSocket (ws/wss).
 * Payload audio is base64 raw/slin: 16-bit PCM, 8kHz, mono (little-endian).
 * We'll send a short pre-baked PCM audio buffer (a beep-ish tone) to confirm playback.
 */
const wss = new WebSocketServer({ server, path: "/voicebot" });

function makeTestTonePCM({ seconds = 1.2, freq = 440, sampleRate = 8000 }) {
  const totalSamples = Math.floor(seconds * sampleRate);
  const buf = Buffer.alloc(totalSamples * 2); // 16-bit
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const amp = 0.25; // keep low to avoid clipping
    const sample = Math.round(Math.sin(2 * Math.PI * freq * t) * amp * 32767);
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

// Hardcoded “audio” to send back (tone now; later we’ll replace with ElevenLabs->PCM)
const tonePcm = makeTestTonePCM({ seconds: 1.0, freq: 523.25 }); // C5

wss.on("connection", (ws) => {
  console.log("WS connected");

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Exotel sends events like connected/start/media/dtmf/stop (per docs)
    // We'll respond right after "start" by sending one media frame.
    if (msg.event === "start") {
      console.log("start event received, sending test tone");

      ws.send(JSON.stringify({
        event: "media",
        media: {
          payload: tonePcm.toString("base64")
        }
      }));
    }

    if (msg.event === "stop") {
      console.log("stop event");
      ws.close();
    }
  });

  ws.on("close", () => console.log("WS closed"));
});
