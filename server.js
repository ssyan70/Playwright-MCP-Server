import http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright';

// Create MCP server instance
const server = new Server({
  name: 'playwright-mcp-server',
  version: '0.1.0',
}, {
  capabilities: {
    tools: {}
  }
});

// Global browser and page variables
let browser;
let page;

// Helper function to ensure browser is running
async function ensureBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }
  return page;
}

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'navigate_to_url',
      description: 'Navigate to a specific URL',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to navigate to'
          }
        },
        required: ['url']
      }
    },
    {
      name: 'fill_form',
      description: 'Fill out a form field on the current page',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector for the form field'
          },
          value: {
            type: 'string',
            description: 'Value to fill in the field'
          }
        },
        required: ['selector', 'value']
      }
    },
    {
      name: 'click_element',
      description: 'Click on an element on the current page',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector for the element to click'
          }
        },
        required: ['selector']
      }
    },
    {
      name: 'get_page_content',
      description: 'Get the text content of the current page',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  ]
}));

// Tool implementations
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    const page = await ensureBrowser();
    
    switch (name) {
      case 'navigate_to_url':
        await page.goto(args.url);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully navigated to ${args.url}`
            }
          ]
        };
        
      case 'fill_form':
        await page.fill(args.selector, args.value);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully filled form field ${args.selector} with value: ${args.value}`
            }
          ]
        };
        
      case 'click_element':
        await page.click(args.selector);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully clicked element: ${args.selector}`
            }
          ]
        };
        
      case 'get_page_content':
        const content = await page.textContent('body');
        return {
          content: [
            {
              type: 'text',
              text: content || 'No content found'
            }
          ]
        };
        
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    throw new Error(`Tool execution failed: ${error.message}`);
  }
});

// SSE connection management
const connections = new Map();

// HTTP server for SSE
const httpServer = http.createServer((req, res) => {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  console.log(`${req.method} ${req.url}`);

  // Health check endpoint
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      service: 'playwright-mcp-server',
      tools: ['navigate_to_url', 'fill_form', 'click_element', 'get_page_content'],
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // SSE endpoint
  if (req.method === 'GET' && (req.url === '/sse' || req.url === '/')) {
    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // Generate connection ID
    const connectionId = Math.random().toString(36).substring(7);
    console.log(`New SSE connection: ${connectionId}`);

    // Store connection
    connections.set(connectionId, res);

    // Send initial endpoint event - try different format
    res.write(`event: endpoint\n`);
    res.write(`data: /mcp\n\n`);
    
    // Also send a ready event that some MCP clients expect
    res.write(`event: ready\n`);
    res.write(`data: {"endpoint": "/mcp"}\n\n`);

    // Keep connection alive with periodic heartbeats
    const heartbeat = setInterval(() => {
      try {
        res.write(`event: heartbeat\n`);
        res.write(`data: ${Date.now()}\n\n`);
      } catch (error) {
        console.log(`Heartbeat failed for connection ${connectionId}:`, error.message);
        clearInterval(heartbeat);
        connections.delete(connectionId);
      }
    }, 30000); // Every 30 seconds

    // Handle connection close
    req.on('close', () => {
      console.log(`SSE connection closed: ${connectionId}`);
      clearInterval(heartbeat);
      connections.delete(connectionId);
    });

    return;
  }

  // MCP JSON-RPC endpoint
  if (req.method === 'POST' && req.url === '/mcp') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        console.log('Received MCP request:', body);
        const request = JSON.parse(body);
        
        let response;
        
        // Handle MCP JSON-RPC requests
        if (request.jsonrpc === '2.0') {
          if (request.method === 'initialize') {
            // Handle MCP initialization
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                protocolVersion: '2025-03-26',
                capabilities: {
                  tools: {},
                  prompts: {},
                  resources: {}
                },
                serverInfo: {
                  name: 'playwright-mcp-server',
                  version: '0.1.0'
                }
              }
            };
          } else if (request.method === 'tools/list') {
            const toolsResponse = await server.requestHandlers.get(ListToolsRequestSchema.name)({
              params: {},
              method: 'tools/list',
              id: request.id
            });
            
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result: toolsResponse
            };
          } else if (request.method === 'tools/call') {
            const toolResponse = await server.requestHandlers.get(CallToolRequestSchema.name)(request);
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result: toolResponse
            };
          } else {
            response = {
              jsonrpc: '2.0',
              id: request.id,
              error: {
                code: -32601,
                message: `Method not found: ${request.method}`
              }
            };
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
          console.log('Sent response:', JSON.stringify(response));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON-RPC request' }));
        }
      } catch (error) {
        console.error('Error processing request:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: request?.id || null,
          error: {
            code: -32603,
            message: `Internal error: ${error.message}`
          }
        }));
      }
    });
    return;
  }

  // 404 for other routes
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`Playwright MCP Server running on port ${PORT}`);
  console.log(`SSE endpoint: https://playwright-mcp-server.onrender.com/sse`);
  console.log(`MCP endpoint: https://playwright-mcp-server.onrender.com/mcp`);
});
