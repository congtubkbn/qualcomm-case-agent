// scripts/enrich_local.mjs — PHASE 3 (enrichment) on a LOCAL model.
//
//     node enrich_local.mjs <CODE> [--all] [--model <id>] [--endpoint <url>] [--check]
//
// Talks to any OpenAI-compatible /chat/completions server that fits the 4–7 GB
// RAM budget (Ollama, llama.cpp --server, LM Studio, vLLM). See docs/LOCAL_LLM.md
// for which models actually fit and what they can/cannot do here.
//
// Contract is identical to the cloud PHASE 3: it only ever writes under
// `enrichment`, never touches a raw field or `hash`, and is incremental — an
// existing per-comment analysis is kept unless --all is passed.
//
// Failure policy: a comment whose analysis does not come back as valid JSON is
// LEFT UNANALYZED and counted in `failed`. Enrichment is interpretation, and a
// malformed local response is not a licence to invent one — the cloud model (or
// the `qualcomm-enrich` skill) can still fill the gap later.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './_paths.mjs';

// Mutable so the CLI flags below can override the env defaults.
export const cfg = {
  endpoint: process.env.QUALCOMM_LLM_ENDPOINT || 'http://127.0.0.1:11434/v1',
  model: process.env.QUALCOMM_LLM_MODEL || 'qwen2.5:7b-instruct-q4_K_M',
  key: process.env.QUALCOMM_LLM_KEY || 'local',
  timeout: Number(process.env.QUALCOMM_LLM_TIMEOUT_MS || 300000),
};

const ROLES = ['Symptom', 'Question', 'Hypothesis', 'Data-Log', 'Analysis', 'Request', 'Resolution', 'Info'];

const SYSTEM = [
  'You are a senior Qualcomm support engineer with deep 3GPP protocol (NAS/RRC, L1/L2/L3)',
  'and RF (TX/RX sensitivity, desense, ACLR, EVM) expertise.',
  'You answer with ONE JSON object and nothing else. No prose, no markdown fence.',
  'Never invent facts that are not in the text you are given. If a field is not',
  'supported by the text, use an empty string or an empty array.',
].join(' ');

/** Pull the first balanced JSON object out of a model response. Small models
 *  like to wrap JSON in ```json fences or add a sentence before it. */
export function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const str = v => (typeof v === 'string' ? v.trim() : '');
const arr = v => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/** Coerce a model response into the commentAnalyses schema, or null if unusable. */
export function normalizeAnalysis(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const summary = str(obj.summary);
  if (!summary) return null;
  const role = ROLES.find(r => r.toLowerCase() === str(obj.role).toLowerCase()) || 'Info';
  return {
    summary,
    role,
    keyPoints: arr(obj.keyPoints).slice(0, 8),
    citations: arr(obj.citations).slice(0, 8),
    answered: obj.answered === true,
  };
}

/** Coerce a model response into the case-level enrichment fields, or null. */
export function normalizeCaseLevel(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const engineerSummary = str(obj.engineerSummary);
  if (!engineerSummary) return null;
  return {
    engineerSummary,
    currentStatus: str(obj.currentStatus),
    rootCause: str(obj.rootCause) || 'Unresolved',
    openQuestions: arr(obj.openQuestions).slice(0, 10),
    recommendedActions: arr(obj.recommendedActions).slice(0, 10),
    tags: arr(obj.tags).slice(0, 12),
  };
}

async function chat(messages, { maxTokens = 700 } = {}) {
  const res = await fetch(`${cfg.endpoint.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model, messages, temperature: 0.2, max_tokens: maxTokens, stream: false,
    }),
    signal: AbortSignal.timeout(cfg.timeout),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? '';
}

const clip = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) + '\n…[truncated]' : String(s || ''));

function commentPrompt(caseTitle, c, maxBody) {
  return [
    `Case: ${caseTitle}`,
    `Comment by ${c.author || 'unknown'} (${c.timestamp || 'no timestamp'}):`,
    '---',
    clip(c.body, maxBody),
    ...(c.analysisLog?.length ? ['--- analysis log ---', clip(c.analysisLog.join('\n'), 1500)] : []),
    '---',
    'Return JSON exactly like:',
    '{"summary":"2-4 sentences","role":"' + ROLES.join('|') + '",',
    '"keyPoints":["band/EARFCN, dBm, ms, QXDM or error codes actually present"],',
    '"citations":["TS 38.331 §5.3.7 style, only if the text cites it"],',
    '"answered":false}',
  ].join('\n');
}

function casePrompt(data, analyses) {
  const lines = data.comments.slice(0, 40).map((c, i) => {
    const a = analyses[c.id];
    return `${i + 1}. [${a?.role || '?'}] ${c.author || '?'} (${c.timestamp || ''}): ${clip(a?.summary || c.body, 400)}`;
  });
  return [
    `Case ${data.caseNumber} — ${data.title || 'untitled'} (status: ${data.status || 'unknown'})`,
    data.description ? `Description: ${clip(data.description, 1200)}` : '',
    'Comments, newest first:',
    ...lines,
    '',
    'Return JSON exactly like:',
    '{"engineerSummary":"5-8 sentences on symptom, debug so far and where it stands",',
    '"currentStatus":"1-2 sentences","rootCause":"hypothesis + reasoning, or Unresolved",',
    '"openQuestions":["..."],"recommendedActions":["..."],"tags":["..."]}',
  ].filter(Boolean).join('\n');
}

/** Oldest→newest debug narrative, derived from the per-comment roles (no model
 *  call needed — the ordering and roles already carry it). */
export function buildCaseFlow(comments, analyses) {
  return comments
    .slice()
    .reverse()
    .filter(c => analyses[c.id])   // filter BEFORE numbering so steps have no gaps
    .map((c, i) => ({
      step: i + 1,
      phase: analyses[c.id].role,
      date: c.timestamp || '',
      by: c.author || '',
      what: analyses[c.id].summary,
      refComments: [c.id],
    }));
}

async function main(code, opts) {
  const casePath = join(DATA_DIR, code, 'case.json');
  if (!existsSync(casePath)) throw new Error(`no cached case at ${casePath} — run run_case.mjs first`);
  const data = JSON.parse(readFileSync(casePath, 'utf8'));

  const enrichment = data.enrichment || {};
  const analyses = opts.all ? {} : { ...(enrichment.commentAnalyses || {}) };
  const todo = data.comments.filter(c => !analyses[c.id]);

  let failed = 0;
  for (const c of todo) {
    try {
      const raw = await chat([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: commentPrompt(data.title || data.caseNumber, c, opts.maxBody) },
      ]);
      const a = normalizeAnalysis(extractJson(raw));
      if (a) analyses[c.id] = a; else failed++;
    } catch (e) {
      failed++;
      process.stderr.write(`comment ${c.id}: ${e.message}\n`);
    }
  }

  // Case level is ALWAYS re-synthesized — new comments change the conclusion.
  let caseLevel = null;
  try {
    const raw = await chat(
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: casePrompt(data, analyses) }],
      { maxTokens: 1200 },
    );
    caseLevel = normalizeCaseLevel(extractJson(raw));
  } catch (e) {
    process.stderr.write(`case-level: ${e.message}\n`);
  }

  data.enrichment = {
    ...enrichment,
    ...(caseLevel || {}),
    caseFlow: buildCaseFlow(data.comments, analyses),
    timeline: data.comments.map(c => ({ date: c.timestamp || '', event: clip(analyses[c.id]?.summary || c.body, 160) })),
    commentAnalyses: analyses,
    enrichedAt: new Date().toISOString(),
    enrichedBy: `local:${cfg.model}`,
  };
  writeFileSync(casePath, JSON.stringify(data, null, 2), 'utf8');

  const idxPath = join(DATA_DIR, '_index.json');
  if (existsSync(idxPath)) {
    try {
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      if (idx[code]) {
        idx[code].enrichedAt = data.enrichment.enrichedAt;
        writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf8');
      }
    } catch { /* index refresh is best-effort; case.json is the source of truth */ }
  }

  return {
    ok: true, code, model: cfg.model, analyzed: todo.length - failed, failed,
    total: Object.keys(analyses).length, caseLevel: !!caseLevel,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = (process.argv[2] || '').trim();
  const argv = process.argv.slice(3);
  const opts = {
    all: argv.includes('--all'),
    maxBody: Number(argv[argv.indexOf('--max-body') + 1]) || 6000,
  };
  if (argv.includes('--model')) cfg.model = argv[argv.indexOf('--model') + 1];
  if (argv.includes('--endpoint')) cfg.endpoint = argv[argv.indexOf('--endpoint') + 1];

  const done = v => { process.stdout.write(JSON.stringify(v) + '\n'); process.exit(v.ok ? 0 : 1); };

  if (argv.includes('--check')) {
    chat([{ role: 'user', content: 'Reply with {"ok":true}' }], { maxTokens: 20 })
      .then(r => done({ ok: !!extractJson(r), endpoint: cfg.endpoint, model: cfg.model, reply: r.slice(0, 120) }))
      .catch(e => done({ ok: false, endpoint: cfg.endpoint, model: cfg.model, reason: e.message }));
  } else {
    main(code, opts).then(done).catch(e => done({ ok: false, code, reason: e.message }));
  }
}
