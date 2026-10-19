import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Groq usa el mismo formato que OpenAI, por eso se conecta con este paquete
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// Ajustes pensados para velocidad
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b"; // modelo muy rápido
const MAX_TOKENS = 1024; // respuestas acotadas = menos espera
const MAX_HISTORY = 12;  // menos contexto = respuesta más rápida
const SYSTEM =
  "Eres un asistente útil. Responde en el idioma del usuario, de forma clara y concisa.";

app.use(express.json({ limit: "100kb" }));

// Solo se sirve index.html (así server.js y .env nunca quedan expuestos)
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/api/chat", async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).send("Falta GROQ_API_KEY en el archivo .env");
  }

  const messages = (Array.isArray(req.body.messages) ? req.body.messages : [])
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .slice(-MAX_HISTORY);

  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length) return res.status(400).send("Mensaje vacío");

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no", // evita que un proxy retenga el streaming
  });

  // Si el usuario cierra la pestaña o pulsa "detener", se corta la generación
  const ctrl = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ctrl.abort();
  });

  try {
    const stream = await client.chat.completions.create(
      {
        model: MODEL,
        stream: true,
        max_completion_tokens: MAX_TOKENS,
        // Los modelos gpt-oss "piensan" antes de responder; en modo bajo es más rápido
        ...(MODEL.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
        messages: [{ role: "system", content: SYSTEM }, ...messages],
      },
      { signal: ctrl.signal }
    );

    for await (const chunk of stream) {
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) res.write(text);
    }
  } catch (err) {
    if (!ctrl.signal.aborted) {
      console.error(err);
      const detalle = `${err.status ? "código " + err.status + ": " : ""}${err.message || err}`;
      res.write(`\n\n[Error de la IA (${MODEL}) - ${detalle}]`);
    }
  }
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Chat listo en http://localhost:${PORT}`));
