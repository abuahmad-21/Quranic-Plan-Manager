#!/usr/bin/env node
/**
 * Claude AI Proxy — Node.js (replaces Python/uv version)
 * Exposes OpenAI-compatible API on port 8082
 * Routes to NVIDIA NIM / OpenRouter / DeepSeek / Pollinations
 */
const http = require('http');
const path = require('path');
const fs   = require('fs');

const PORT    = Number(process.env.PROXY_PORT || process.env.PORT || 8082);
const DB_FILE = path.join(__dirname, 'db.json');

const PROVIDERS = {
  nvidia_nim : { base: 'https://integrate.api.nvidia.com/v1',   def_model: 'meta/llama-3.3-70b-instruct' },
  openrouter : { base: 'https://openrouter.ai/api/v1',           def_model: 'meta-llama/llama-3.3-70b-instruct:free' },
  deepseek   : { base: 'https://api.deepseek.com/v1',            def_model: 'deepseek-chat' },
  kimi       : { base: 'https://api.moonshot.cn/v1',             def_model: 'moonshot-v1-8k' },
  custom     : { base: '',                                        def_model: 'gpt-4o-mini' },
  pollinations: { base: 'https://text.pollinations.ai/openai',   def_model: 'openai-large' },
};

function loadConfig() {
  try {
    const db  = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const s   = db.admin?.ai_settings || {};
    const cp  = s.claude_proxy || {};
    const prov = cp.provider || 'nvidia_nim';
    const pc   = PROVIDERS[prov] || PROVIDERS.nvidia_nim;
    return {
      provider : prov,
      base_url : cp.base_url || pc.base,
      api_key  : cp.api_key  || s.nvidia_nim_key || s.custom_api_key || process.env.NVIDIA_NIM_API_KEY || '',
      model    : cp.model    || s.nvidia_nim_model || pc.def_model,
    };
  } catch (e) {
    const key = process.env.NVIDIA_NIM_API_KEY || '';
    return { provider:'nvidia_nim', base_url: PROVIDERS.nvidia_nim.base, api_key: key, model: PROVIDERS.nvidia_nim.def_model };
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-password');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, code, data) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end',  () => { try { ok(JSON.parse(d||'{}')); } catch { ok({}); } });
    req.on('error', fail);
  });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  /* ── Health / Models ── */
  if (req.method === 'GET' && req.url === '/') {
    return json(res, 200, { status: 'ok', name: 'Claude AI Proxy (Node.js)', port: PORT });
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    const cfg = loadConfig();
    return json(res, 200, {
      object: 'list',
      data: [
        { id: cfg.model,            object: 'model', owned_by: cfg.provider },
        { id: 'claude-sonnet-4-5',  object: 'model', owned_by: 'proxy' },
        { id: 'claude-3-5-haiku',   object: 'model', owned_by: 'proxy' },
      ]
    });
  }

  /* ── Chat Completions ── */
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: { message: 'invalid json' } }); }

    const cfg = loadConfig();
    if (!cfg.api_key && cfg.provider !== 'pollinations') {
      return json(res, 503, { error: { message: 'No API key configured. Set one in Admin → Hermes → Claude AI tab.', type: 'auth_error' } });
    }

    /* Map claude model names to real model */
    const reqBody = { ...body };
    if (!reqBody.model || reqBody.model.startsWith('claude')) {
      reqBody.model = cfg.model;
    }

    const upstream_url = `${cfg.base_url}/chat/completions`;
    try {
      const upstream = await fetch(upstream_url, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${cfg.api_key}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(reqBody),
        signal:  AbortSignal.timeout(120_000),
      });

      /* Stream the response back */
      const contentType = upstream.headers.get('content-type') || 'application/json';
      cors(res);
      res.writeHead(upstream.status, { 'Content-Type': contentType });
      if (!upstream.body) { return res.end('{}'); }
      const reader = upstream.body.getReader();
      const pump = async () => {
        const { done, value } = await reader.read();
        if (done) { return res.end(); }
        res.write(Buffer.from(value));
        return pump();
      };
      await pump();
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: { message: e.message, type: 'proxy_error' } });
      else res.end();
    }
    return;
  }

  /* ── 404 ── */
  json(res, 404, { error: 'Not found', endpoints: ['/v1/models', '/v1/chat/completions'] });
});

server.listen(PORT, () => {
  const cfg = loadConfig();
  console.log(`[ClaudeProxy] Node.js proxy listening on port ${PORT}`);
  console.log(`[ClaudeProxy] Provider: ${cfg.provider} → ${cfg.base_url}`);
  console.log(`[ClaudeProxy] Model:    ${cfg.model}`);
  console.log(`[ClaudeProxy] API key:  ${cfg.api_key ? '✅ set' : '❌ missing'}`);
});

server.on('error', e => console.error('[ClaudeProxy] Error:', e.message));
