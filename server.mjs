import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3002;

try {
  const env = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8');
  env.split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k?.trim()) process.env[k.trim()] = v.join('=').trim();
  });
} catch {}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
}

function respond(res, code, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleDispatch(req, res) {
  const p = await getBody(req);
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('Missing GROQ_API_KEY');

  const droughtPct = p.drought.factor;
  const droughtLevel = droughtPct >= 60 ? 'severe' : droughtPct >= 35 ? 'high' : droughtPct >= 15 ? 'moderate' : 'low';

  const isServiceRequests = !!p.isServiceRequests;
  const prompt = `You are an urban forestry dispatch AI for the Chicago Parks Department. Write a concise field briefing for an arborist heading out today.

Zone: ${p.zone}, Chicago
${isServiceRequests
    ? `311 tree service requests: ${p.totalTrees} total — ${p.criticalCount} critical urgency, ${p.atRiskCount} high urgency`
    : `Trees flagged: ${p.totalTrees} total — ${p.criticalCount} critical condition, ${p.atRiskCount} at risk`}
Average urgency score: ${p.avgRisk}%
Drought stress: ${droughtLevel} (${p.drought.precipMM}mm rain in last 30 days vs ${p.drought.expectedMM}mm expected)
Request types present: ${p.topSpecies}

Priority locations to visit first:
${p.topTrees.map((t, i) => `${i + 1}. ${t.species || 'Unknown'} — status: ${t.health || 'Open'}, urgency ${t.risk}% | ${t.address || 'address unknown'}`).join('\n')}

Write a practical 2-paragraph dispatch briefing (under 120 words total). Include:
- Why this zone is today's priority (unresolved requests + drought conditions)
- Which locations to hit first and what to look for on the ground
- How drought is amplifying tree stress in this area and estimated work scope

Write like an experienced Chicago urban forestry supervisor. Be specific and actionable. No bullet points.

Return JSON: { "briefing": "<briefing text>" }`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.5,
    }),
  });

  if (!r.ok) throw new Error(await r.text());
  const d = await r.json();
  respond(res, 200, d.choices?.[0]?.message?.content || '{}');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/dispatch' && req.method === 'POST') {
    try { await handleDispatch(req, res); }
    catch (e) { respond(res, 500, { error: e.message }); }
    return;
  }

  const staticDir = path.join(__dirname, 'public');
  const filePath = path.join(staticDir, url.pathname === '/' ? 'index.html' : url.pathname);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(staticDir, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Canopy running at http://localhost:${PORT}`));
