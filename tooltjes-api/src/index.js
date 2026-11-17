// tooltjes-api: hulp-Worker voor de HTML-tools op dirkdoet.github.io/tooltjes.
//   GET  /fetch?url=...  haalt een pagina op (de tools kunnen dat zelf niet door CORS)
//   POST /ai             { system?, messages, zoeken? } -> Claude, antwoord in de vorm
//                        { choices: [{ message: { content } }] } die de tools al lezen
import Anthropic from '@anthropic-ai/sdk';

const TOEGESTAAN = ['https://dirkdoet.github.io'];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': TOEGESTAAN.includes(origin) ? origin : TOEGESTAAN[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!TOEGESTAAN.includes(origin)) return new Response('Geen toegang', { status: 403, headers: cors });

    const { pathname, searchParams } = new URL(request.url);
    try {
      if (pathname === '/fetch' && request.method === 'GET') return await ophalen(searchParams.get('url'), cors);
      if (pathname === '/ai' && request.method === 'POST') return await ai(await request.json(), env, cors);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: cors });
    }
    return new Response('Niet gevonden', { status: 404, headers: cors });
  },
};

async function ophalen(url, cors) {
  if (!/^https?:\/\//i.test(url || '')) return Response.json({ error: 'Geef een geldige url op' }, { status: 400, headers: cors });
  const r = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DirkDoetTooltjes/1.0)' },
  });
  return new Response(r.body, {
    status: r.status,
    headers: { ...cors, 'Content-Type': r.headers.get('Content-Type') || 'text/plain; charset=utf-8', 'X-Final-Url': r.url },
  });
}

async function ai(body, env, cors) {
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return Response.json({ error: 'messages ontbreekt' }, { status: 400, headers: cors });
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const msg = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    ...(body.system ? { system: body.system } : {}),
    ...(body.zoeken ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] } : {}),
    messages: body.messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })),
  });
  if (msg.stop_reason === 'refusal') {
    return Response.json({ error: 'Claude weigert dit verzoek' }, { status: 422, headers: cors });
  }
  const tekst = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return Response.json({ choices: [{ message: { content: tekst } }] }, { headers: cors });
}
