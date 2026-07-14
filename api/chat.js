// ═══════════════════════════════════════════════════════════════════════════
// api/chat.js — serverless proxy for the in-app assistant (Anthropic Messages API).
//
//   POST /api/chat  { messages: [{role, content}], context: "<dashboard summary>" }
//     → { reply: "<assistant text>", usage: {...} }
//
// The client sends the current dashboard state as `context` (always in sync with
// what the user sees) plus the running conversation. This function prepends a
// system prompt, calls Claude, and returns the reply text. The API key stays
// server-side. Gated by EDIT_SECRET (same secret the Leadership view uses).
//
// Env vars (Vercel → Project Settings → Environment Variables):
//   ANTHROPIC_API_KEY — Anthropic API key (server-side only)
//   EDIT_SECRET       — shared passphrase; POST requires the x-edit-secret header to match
//
// Returns 503 if ANTHROPIC_API_KEY is unset (client shows a "not configured" note).
// ═══════════════════════════════════════════════════════════════════════════

const KEY = process.env.ANTHROPIC_API_KEY;
const EDIT_SECRET = process.env.EDIT_SECRET || '';
const MODEL = 'claude-opus-4-8';

const SYSTEM_PREAMBLE =
  "You are the assistant for the M3 engagement dashboard, used by Dualboot's PM and leadership. " +
  "Answer questions about the engagement using the PROJECT DATA below as your source of truth. " +
  "Be direct and concise: lead with the answer, no preamble and no commentary about your reasoning. " +
  "Plain text with light markdown (bold, bullets) is fine. If the data doesn't contain the answer, " +
  "say so plainly and point to where in the dashboard to look. Never invent milestones, dates, hours, " +
  "or people that aren't in the data.\n\n";

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-edit-secret');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!KEY) return res.status(503).json({ error: 'Chat not configured' });
  if (EDIT_SECRET && req.headers['x-edit-secret'] !== EDIT_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const context = typeof body.context === 'string' ? body.context : '';
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const clean = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-12)
      .map(m => ({ role: m.role, content: m.content }));
    if (!clean.length || clean[0].role !== 'user') {
      return res.status(400).json({ error: 'messages must start with a user turn' });
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PREAMBLE + '=== PROJECT DATA ===\n' + context,
        messages: clean,
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: `Anthropic API ${r.status}`, detail: detail.slice(0, 500) });
    }
    const j = await r.json();
    if (j.stop_reason === 'refusal') {
      return res.status(200).json({ reply: "I can't help with that request." });
    }
    const reply = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ reply: reply || '(no response)', usage: j.usage });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
