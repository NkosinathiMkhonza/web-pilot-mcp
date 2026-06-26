import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import './index.ts';

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/sse', (req, res) => {
  console.log('SSE connection');
  const transport = new SSEServerTransport('/messages', res);
  const server = new Server({ name: 'web-pilot-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (globalThis as any).__WEB_PILOT_TOOLS__ }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return (globalThis as any).__WEB_PILOT_HANDLE__(name, args || {});
  });
  server.connect(transport);
});

app.post('/messages', express.json(), (req, res) => {
  res.status(200).end();
});

app.get('/', (req, res) => {
  res.json({ name: 'web-pilot-mcp', version: '1.0.0', sse: '/sse' });
});

app.listen(PORT, () => console.log('Web Pilot running on port ' + PORT));
