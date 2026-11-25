// English School: "ינשופי" bot.
// mode "say"  : Hebrew question -> simple English phrase, Hebrew pronunciation, likely replies.
// mode "tutor": short English conversation practice with gentle corrections in Hebrew.
// The Gemini key stays on the server (Netlify environment variable GEMINI_API_KEY).
const MODELS = [process.env.GEMINI_MODEL, "gemini-flash-lite-latest", "gemini-flash-latest", "gemini-4-hydrogen", "gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash"].filter(Boolean);
let goodModel = null;       // remember the first model that answered, so later questions are fast
let noThinking = true;      // try to switch off "thinking" (faster); turned off if a model rejects it
const cache = new Map();
const hits = new Map();
const NO_SOUNDS = 'Never write owl sounds such as "הו-הו" or "הוּ".';

function sayPrompt(q, g) {
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
"note": a short practical tip in Hebrew (max 15 words), friendly, or an empty string.
Address the tourist in Hebrew ${g === "m" ? "masculine" : "feminine"} form. ${NO_SOUNDS}
If the request is not something to say in English, still give the most useful tourist phrase for it.`;
}

const SCEN = {
  cafe: "You are a friendly barista in a cafe in London. The learner is a customer ordering.",
  hotel: "You are a hotel receptionist in New York. The learner is a guest checking in.",
  border: "You are a passport control officer at an airport. The learner is a tourist arriving.",
  shop: "You are a shop assistant in a clothing store. The learner is a customer.",
  street: "You are a local person on the street. The learner is a tourist asking for directions.",
  free: "You are a friendly English teacher having a light everyday chat with the learner.",
  explain: "The learner asks, in Hebrew, about something in English they did not understand (a word, grammar, a sentence)."
};

function tutorPrompt(scen, msgs, g) {
  const form = g === "m" ? "masculine" : "feminine";
  const hist = msgs.map(m => (m.r === "t" ? "Tutor: " : "Learner: ") + m.t).join("\n");
  if (scen === "explain") {
    return `You are "Yanshufi" (ינשופי), a warm, patient English teacher for Hebrew speakers with a low English level.
${SCEN.explain}
Conversation so far:
${hist}

Answer the learner's last message. Reply with ONLY one JSON object with these fields:
"he": a clear, short explanation in simple Hebrew (max 60 words), addressing the learner in ${form} form,
"en": one short English example sentence that shows the point,
"tr": how to pronounce "en" in Hebrew letters,
"fix": null,
"tip": a short Hebrew tip (max 12 words) or "",
"sug": an array of 2 short follow-up questions in Hebrew the learner might ask next.
${NO_SOUNDS}`;
  }
  return `You are "Yanshufi" (ינשופי), a warm English conversation tutor for a Hebrew speaker with a low English level.
Role play: ${SCEN[scen] || SCEN.free}
Use very simple English (A1-A2), short sentences, max 2 sentences per turn, and always end with a question or a clear next step so the conversation continues.
Conversation so far:
${hist}

Continue the role play with the tutor's next turn. Reply with ONLY one JSON object with these fields:
"en": the tutor's next line in simple English,
"he": its Hebrew translation,
"tr": how to pronounce "en" in Hebrew letters,
"fix": if the learner's LAST message has a real English mistake, an object {"wrong": the wrong part, "right": the corrected sentence, "why": a very short explanation in Hebrew (max 15 words), addressing the learner in ${form} form}; otherwise null. Ignore small punctuation and capital letter issues. If the learner wrote in Hebrew, set "right" to how to say it in English and "why" to "כך אומרים את זה באנגלית".
"tip": a short encouraging Hebrew line (max 10 words) or "",
"sug": an array of 2 short, simple English answers the learner could say next.
${NO_SOUNDS}`;
}


// Find the Gemini key even if the environment variable got a different name.
const KEY_NAMES = ["GEMINI_API_KEY", "DefaultGeminiAPIKey", "GOOGLE_API_KEY", "GEMINI_KEY", "API_KEY"];
function envGet(n) { try { if (typeof Netlify !== "undefined" && Netlify.env) { const v = Netlify.env.get(n); if (v) return v; } } catch {} return process.env[n]; }
function findKey() {
  for (const n of KEY_NAMES) { const v = envGet(n); if (v && v.trim()) return { key: v.trim(), name: n }; }
  let all = {};
  try { if (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.toObject) all = Netlify.env.toObject(); } catch {}
  all = Object.assign({}, process.env, all);
  for (const [n, v] of Object.entries(all)) if (typeof v === "string" && /^AIza[0-9A-Za-z_\-]{20,}$/.test(v.trim())) return { key: v.trim(), name: n };
  return { key: null, name: null };
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

async function callModel(key, model, text, think) {
  const generationConfig = { temperature: 0.4, responseMimeType: "application/json", maxOutputTokens: 500 };
  if (think) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }], generationConfig }),
    signal: AbortSignal.timeout(12000)
  });
}

async function ask(key, text) {
  const t0 = Date.now();
  const order = goodModel ? [goodModel, ...MODELS.filter(m => m !== goodModel)] : MODELS;
  let lastErr = "unknown";
  for (const model of order) {
    if (Date.now() - t0 > 20000) { lastErr = "timeout"; break; }
    try {
      let r = await callModel(key, model, text, noThinking);
      if (r.status === 400 && noThinking) { noThinking = false; r = await callModel(key, model, text, false); }
      if (r.status === 404 || r.status === 400) { lastErr = "model_" + r.status; if (goodModel === model) goodModel = null; continue; }
      if (r.status === 429) return { error: "quota" };
      if (!r.ok) { lastErr = "http_" + r.status; continue; }
      const data = await r.json();
      const txt = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) { lastErr = "no_json"; continue; }
      goodModel = model;
      return { obj: JSON.parse(m[0]), model };
    } catch (e) { lastErr = e?.name === "TimeoutError" ? "timeout" : "fetch"; }
  }
  return { error: lastErr };
}

const S = (v, n = 300) => String(v ?? "").replace(/הוּ-הוּ[!,.]?\s*|הו-הו[!,.]?\s*/g, "").slice(0, n);

export default async (req, context) => {
  const found = findKey();
  // GET /api/bot = quick health check (never shows the key itself)
  if (req.method === "GET") return json({ ok: true, hasKey: !!found.key, keyName: found.name || null, model: goodModel });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const key = found.key;
  if (!key) return json({ error: "no_key" }, 503);

  let d;
  try { d = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const g = d.g === "m" ? "m" : "f";
  const mode = d.mode === "tutor" ? "tutor" : "say";

  // light abuse protection: max 20 questions per minute per visitor
  const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "x";
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (list.length >= 20) return json({ error: "rate_limited" }, 429);
  list.push(now); hits.set(ip, list);

  if (mode === "tutor") {
    const scen = SCEN[d.scen] ? d.scen : "free";
    const msgs = (Array.isArray(d.msgs) ? d.msgs : []).slice(-10)
      .map(m => ({ r: m && m.r === "t" ? "t" : "u", t: String((m && m.t) || "").slice(0, 300) })).filter(m => m.t);
    if (!msgs.length) return json({ error: "empty" }, 400);
    const res = await ask(key, tutorPrompt(scen, msgs, g));
    if (res.error) return json({ error: res.error }, res.error === "quota" ? 429 : 502);
    const o = res.obj;
    if (typeof o.en !== "string" && typeof o.he !== "string") return json({ error: "bad_answer" }, 502);
    const fix = o.fix && typeof o.fix === "object" && o.fix.right ? { wrong: S(o.fix.wrong, 120), right: S(o.fix.right, 200), why: S(o.fix.why, 160) } : null;
    const sug = Array.isArray(o.sug) ? o.sug.slice(0, 3).map(x => S(x, 90)).filter(Boolean) : [];
    return json({ answer: { en: S(o.en), he: S(o.he, 500), tr: S(o.tr), fix, tip: S(o.tip, 120), sug }, model: res.model });
  }

  const q = String(d.q || "").trim().slice(0, 200);
  if (!q) return json({ error: "empty" }, 400);
  const ck = g + ":" + q;
  if (cache.has(ck)) return json({ answer: cache.get(ck), cached: true });
  const res = await ask(key, sayPrompt(q, g));
  if (res.error) return json({ error: res.error }, res.error === "quota" ? 429 : 502);
  const o = res.obj;
  for (const k of ["en", "tr", "he", "ren", "rhe", "ben", "btr", "bhe"]) {
    if (typeof o[k] !== "string" || !o[k].trim()) return json({ error: "bad_answer" }, 502);
  }
  const out = {};
  for (const k of ["q", "en", "tr", "he", "ren", "rhe", "ben", "btr", "bhe", "note"]) out[k] = S(o[k], 220);
  if (cache.size > 500) cache.clear();
  cache.set(ck, out);
  return json({ answer: out, model: res.model });
};

export const config = { path: "/api/bot" };
