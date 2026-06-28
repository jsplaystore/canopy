export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const p = await req.json();
  const key = process.env.GROQ_API_KEY;
  if (!key) return new Response('Missing GROQ_API_KEY', { status: 500 });

  const droughtFactor = p.drought?.factor ?? 0;
  const droughtLevel  = droughtFactor >= 0.6 ? 'severe' : droughtFactor >= 0.35 ? 'high' : droughtFactor >= 0.15 ? 'moderate' : 'low';

  const hasVuln    = p.hardshipIndex != null;
  const vulnLevel  = !hasVuln ? '' : p.hardshipIndex >= 70 ? 'high-hardship' : p.hardshipIndex >= 45 ? 'moderate-hardship' : 'lower-hardship';
  const vulnLine   = hasVuln
    ? `Community vulnerability: ${vulnLevel} (Chicago Hardship Index ${Math.round(p.hardshipIndex)}/100${p.povertyPct != null ? `, ${Math.round(p.povertyPct)}% below poverty` : ''}) — equity-priority neighborhood with typically less private canopy and fewer resources to maintain trees`
    : '';

  const prompt = `You are an urban forestry dispatch AI for the Chicago Parks Department. Write a concise field briefing for an arborist heading out today.

Zone: ${p.zone}, Chicago
311 tree service requests: ${p.totalTrees} total — ${p.criticalCount} open/unresolved, ${p.atRiskCount} filed in the last 30 days
Average priority score: ${p.avgRisk}%
Drought stress: ${droughtLevel} (${p.drought?.precipMM ?? '--'}mm rain received vs ${p.drought?.expectedMM ?? 75}mm expected)
${vulnLine ? vulnLine + '\n' : ''}Request types present: ${p.topSpecies}

Top priority addresses to visit first:
${(p.topTrees || []).map((t, i) => `${i + 1}. ${t.species || t.type || 'Tree Request'} — status: ${t.health || t.status || 'Open'} | ${t.address || 'address unknown'}`).join('\n')}

Write a practical 2-paragraph dispatch briefing (under 130 words total). Include:
- Why this zone is today's priority (unresolved requests + drought conditions${hasVuln ? ' + canopy-equity need in this higher-vulnerability community' : ''})
- Which addresses to hit first and what to look for on the ground
- How drought is amplifying tree stress and estimated work scope${hasVuln ? '\n- A brief note on the equity case for prioritizing this community' : ''}

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

  if (!r.ok) return new Response(await r.text(), { status: 502 });
  const d = await r.json();
  const content = d.choices?.[0]?.message?.content || '{}';
  return new Response(content, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
