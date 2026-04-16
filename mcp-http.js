/**
 * mcp-http.js  –  Transport SSE/HTTP  (ChatGPT web Pro/Plus/Business)
 */
'use strict';

const express = require('express');
const cors    = require('cors');
const { Server }             = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { TOOLS, handleTool, initConfig } = require('./lib/tools.js');

// ─── Logging ──────────────────────────────────────────────────────────────────

const LOG_LEVEL = ({ none:0, error:1, info:2, debug:3 })[process.env.LOG_LEVEL ?? 'info'] ?? 2;
const log = {
  error: (...a) => LOG_LEVEL >= 1 && console.error('[ERR]', new Date().toISOString(), ...a),
  info:  (...a) => LOG_LEVEL >= 2 && console.log('[INF]', new Date().toISOString(), ...a),
  debug: (...a) => LOG_LEVEL >= 3 && console.log('[DBG]', new Date().toISOString(), ...a),
};

// ─── Configuration ────────────────────────────────────────────────────────────

const { USE_SANDBOX } = initConfig();
const MCP_PORT   = Number(process.env.MCP_PORT  || 3001);
const MCP_SECRET = process.env.MCP_SECRET || '';

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

// Contournement de la page d'avertissement ngrok
app.use((_req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// Authentification Bearer optionnelle
function authMiddleware(req, res, next) {
  if (!MCP_SECRET) return next();
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token === MCP_SECRET) return next();
  log.error('Auth refusée depuis ' + (req.ip || 'unknown'));
  res.status(401).json({ error: 'Unauthorized — Bearer token invalide' });
}

// ─── Santé ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({
  ok: true, service: 'proxy-avocat-mcp-http', version: '4.3.2',
  sandbox: USE_SANDBOX, sessions: sessions.size,
  auth: !!MCP_SECRET,
}));

// ─── Sessions SSE ─────────────────────────────────────────────────────────────

const sessions = new Map();

app.get('/sse', authMiddleware, async (req, res) => {
  log.info('Nouvelle connexion SSE depuis ' + (req.ip || 'unknown'));
  const transport = new SSEServerTransport('/messages', res);
  const mcpServer = createMcpServer();
  sessions.set(transport.sessionId, { transport, mcpServer });
  log.info('Session ouverte : ' + transport.sessionId + ' (total: ' + sessions.size + ')');
  res.on('close', () => {
    sessions.delete(transport.sessionId);
    log.info('Session fermée : ' + transport.sessionId + ' (total: ' + sessions.size + ')');
  });
  await mcpServer.connect(transport);
});

app.post('/messages', authMiddleware, async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'sessionId manquant' });
  const session = sessions.get(sessionId);
  if (!session) {
    log.error('Session introuvable : ' + sessionId);
    return res.status(404).json({ error: 'Session inconnue ou expirée : ' + sessionId });
  }
  try {
    await session.transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    log.error('Erreur handlePostMessage : ' + err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── Fabrique serveur MCP ─────────────────────────────────────────────────────

function createMcpServer() {
  const server = new Server(
    { name: 'proxy-avocat', version: '4.3.2' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log.info('[tool] ' + name);
    try {
      const result = await handleTool(name, args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      log.error('[tool] ' + name + ' → ' + err.message);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message, status: err.status ?? 500 }) }],
        isError: true,
      };
    }
  });
  return server;
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

if (!process.env.LF_CLIENT_ID || !process.env.LF_CLIENT_SECRET) {
  log.error('LF_CLIENT_ID / LF_CLIENT_SECRET non définis — les appels API échoueront');
}
if (!MCP_SECRET) {
  log.info('⚠  MCP_SECRET non défini — endpoint ouvert.');
}

app.listen(MCP_PORT, () => {
  log.info('─────────────────────────────────────────────────────');
  log.info('proxy-avocat MCP HTTP v4.3.2');
  log.info('Mode    : ' + (USE_SANDBOX ? 'SANDBOX' : 'PRODUCTION'));
  log.info('Port    : ' + MCP_PORT);
  log.info('SSE     : http://localhost:' + MCP_PORT + '/sse');
  log.info('Health  : http://localhost:' + MCP_PORT + '/health');
  log.info('Auth    : ' + (MCP_SECRET ? 'Bearer token activé' : 'aucune'));
  log.info('─────────────────────────────────────────────────────');
});
