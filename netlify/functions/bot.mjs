// English School bot: Hebrew question -> simple English phrase, Hebrew transliteration and likely replies.
// The Gemini key stays on the server (Netlify environment variable GEMINI_API_KEY).
const MODELS = [process.env.GEMINI_MODEL, "gemini-4-hydrogen", "gemini-flash-latest", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"].filter(Boolean);
const cache = new Map();
const hits = new Map();

function prompt(q, g) {
  return `You help an Israeli tourist who speaks Hebrew and knows very little English. They wrote, in Hebrew, what they want to say while abroad:
${JSON.stringify(q)}

Reply with ONLY one JSON object with these string fields:
"q": a short Hebrew title of the situation (max 8 words),
"en": one simple, natural English sentence (max 18 words) that says exactly what they want. Keep every name and number they gave. Write Hebrew names (hotels, streets, people) in Latin letters with their usual English spelling,
"tr": how to pronounce "en", written in Hebrew letters with niqqud where it helps,
"he": what "en" means, in Hebrew,
"ren": what the other person usually answers, in short simple English,
"rhe": its Hebrew translation,
"ben": a short English reply the tourist can say next,
"btr": how to pronounce "ben" in Hebrew letters,
"bhe": its Hebrew translation,
"note": a short practical tip in Hebrew (max 20 words), written warmly and playfully as "ינשופי", a friendly owl who is the app's guide, or an empty string.
Write all Hebrew text addressing the tourist in ${g === "m" ? "masculine" : "feminine"} form.
If the request is not something to say in English, still give the most useful tourist phrase for it.`;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const key = (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.get("GEMINI_API_KEY")) || process.env.GEMINI_API_KEY;
  if (!key) return json({ error: "no_key" }, 503);

  let q = "", g = "f";
  try { const d = await req.json(); q = String(d.q || "").trim().slice(0, 200); g = d.g === "m" ? "m" : "f"; } catch { return json({ error: "bad_request" }, 400); }
  if (!q) return json({ error: "empty" }, 400);

  // light abuse protection: max 20 questions per minute per visitor
  const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "x";
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (list.length >= 20) return json({ error: "rate_limited" }, 429);
  list.push(now); hits.set(ip, list);

  const ck = g + ":" + q;
  if (cache.has(ck)) return json({ answer: cache.get(ck), cached: true });

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt(q, g) }] }],
    generationConfig: { temperature: 0.3, responseMimeType: "application/json", maxOutputTokens: 600 }
  };
  let lastErr = "unknown";
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      if (r.status === 404 || r.status === 400) { lastErr = "model_" + r.status; continue; }
      if (r.status === 429) return json({ error: "quota" }, 429);
      if (!r.ok) { lastErr = "http_" + r.status; continue; }
      const data = await r.json();
      const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) { lastErr = "no_json"; continue; }
      const o = JSON.parse(m[0]);
      const need = ["en", "tr", "he", "ren", "rhe", "ben", "btr", "bhe"];
      if (need.some(k => typeof o[k] !== "string" || !o[k].trim())) { lastErr = "missing_fields"; continue; }
      const out = {};
      ["q", "en", "tr", "he", "ren", "rhe", "ben", "btr", "bhe", "note"].forEach(k => out[k] = String(o[k] || "").slice(0, 220));
      if (cache.size > 500) cache.clear();
      cache.set(ck, out);
      return json({ answer: out, model });
    } catch (e) { lastErr = e && e.name === "TimeoutError" ? "timeout" : "fetch_failed"; }
  }
  return json({ error: lastErr }, 502);
};

export const config = { path: "/api/bot" };
