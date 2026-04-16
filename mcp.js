/**
 * mcp.js  –  Transport stdio  (Claude Desktop + ChatGPT Desktop)
 * Lancement : node --env-file=.env mcp.js
 */
'use strict';

const { Server }               = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { TOOLS, handleTool, initConfig } = require('./lib/tools.js');

const LOG_LEVEL = ({ none:0, error:1, info:2, debug:3 })[process.env.LOG_LEVEL ?? 'error'] ?? 1;
const log = {
  info:  (...a) => LOG_LEVEL >= 2 && process.stderr.write('[INF] ' + a.join(' ') + '\n'),
  error: (...a) => LOG_LEVEL >= 1 && process.stderr.write('[ERR] ' + a.join(' ') + '\n'),
};

const { USE_SANDBOX } = initConfig();

const server = new Server(
  { name: 'proxy-avocat', version: '4.3.2' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  log.info('tool: ' + name);
  try {
    const result = await handleTool(name, args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message, status: err.status ?? 500 }) }],
      isError: true,
    };
  }
});

async function main() {
  if (!process.env.LF_CLIENT_ID) process.stderr.write('[WARN] LF_CLIENT_ID non défini\n');
  log.info('proxy-avocat MCP stdio (' + (USE_SANDBOX ? 'SANDBOX' : 'PRODUCTION') + ')');
  await server.connect(new StdioServerTransport());
}

main().catch(err => { process.stderr.write('[FATAL] ' + err.message + '\n'); process.exit(1); });
