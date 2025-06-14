import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright';
import http from 'http';

const PORT = process.env.PORT || 10000;

// Create MCP Server instance
const server = new Server(
  {
    name: 'playwright-mcp-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools for MCP
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'navigate_to_url',
        description: 'Navigate to a specific URL and take a screenshot',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to navigate to',
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'fill_form',
        description: 'Fill out form fields on a webpage',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL of the page with the form',
            },
            fields: {
              type: 'array',
              description: 'Array of form fields to fill',
            },
          },
          required: ['url', 'fields'],
        },
      },
      {
        name: 'click_element',
        description: 'Click on an element on a webpage',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL of the page',
            },
            selector: {
              type: 'string',
              description: 'CSS selector for the element to click',
            },
          },
          required: ['url', 'selector'],
        },
      },
      {
        name: 'get_page_content',
        description: 'Get the HTML content and form structure of a webpage',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL of the page to inspect',
            },
            selector: {
              type: 'string',
              description: 'Optional CSS selector to get content from specific element only',
            },
            includeFormStructure: {
              type: 'boolean',
              description: 'Whether to include detailed form field information',
              default: true,
            },
          },
          required: ['url'],
        },
      },
    ],
  };
});

// Handle tool execution for MCP
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;
    switch (name) {
      case 'navigate_to_url':
        result = await handleNavigateToUrl(args);
        break;
      case 'fill_form':
        result = await handleFillForm(args);
        break;
      case 'click_element':
        result = await handleClickElement(args);
        break;
      case 'get_page_content':
        result = await handleGetPageContent(args);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// Tool implementation functions
async function handleNavigateToUrl(args) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  try {
    await page.goto(args.url);
    const screenshot = await page.screenshot({ fullPage: true });
    await browser.close();
    
    return {
      success: true,
      message: `Successfully navigated to ${args.url}`,
      screenshot: screenshot.toString('base64'),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function handleFillForm(args) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  try {
    await page.goto(args.url);
    
    for (const field of args.fields) {
      await page.fill(field.selector, field.value);
    }
    
    const screenshot = await page.screenshot({ fullPage: true });
    await browser.close();
    
    return {
      success: true,
      message: `Successfully filled ${args.fields.length} form fields`,
      screenshot: screenshot.toString('base64'),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function handleClickElement(args) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  try {
    await page.goto(args.url);
    await page.click(args.selector);
    
    const screenshot = await page.screenshot({ fullPage: true });
    await browser.close();
    
    return {
      success: true,
      message: `Successfully clicked element: ${args.selector}`,
      screenshot: screenshot.toString('base64'),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function handleGetPageContent(args) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  try {
    await page.goto(args.url);
    
    let content;
    if (args.selector) {
      const element = await page.$(args.selector);
      content = element ? await element.innerHTML() : null;
    } else {
      content = await page.content();
    }
    
    let formStructure = null;
    if (args.includeFormStructure !== false) {
      const forms = await page.$$eval('form', forms => 
        forms.map((form, index) => ({
          formIndex: index,
          action: form.action || '',
          method: form.method || 'GET',
          fields: Array.from(form.querySelectorAll('input, textarea, select')).map(field => ({
            name: field.name || '',
            id: field.id || '',
            type: field.type || 'text',
            placeholder: field.placeholder || '',
            required: field.required || false,
            value: field.value || '',
            selector: field.id ? `#${field.id}` : field.name ? `[name="${field.name}"]` : '',
          }))
        }))
      );
      formStructure = forms;
    }
    
    const title = await page.title();
    await browser.close();
    
    return {
      success: true,
      url: args.url,
      title: title,
      content: content,
      formStructure: formStructure,
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// HTTP Server to handle MCP over HTTP
const httpServer = http.createServer(async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    // Health check endpoint
    res.writeHead(200);
    res.end(JSON.stringify({ 
      status: 'healthy', 
      service: 'playwright-mcp-server',
      tools: ['navigate_to_url', 'fill_form', 'click_element', 'get_page_content'],
      timestamp: new Date().toISOString()
    }));
    return;
  }

  if (req.method === 'POST' && (req.url === '/messages' || req.url === '/mcp' || req.url === '/')) {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        console.log('Received MCP request:', body);
        console.log('Request URL:', req.url);
        console.log('Request method:', req.method);
        const request = JSON.parse(body);
        
        // Handle MCP JSON-RPC requests
        if (request.jsonrpc === '2.0') {
          let response;
          
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
            const callResponse = await server.requestHandlers.get(CallToolRequestSchema.name)({
              params: request.params,
              method: 'tools/call',
              id: request.id
            });
            
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result: callResponse
            };
          } else {
            response = {
              jsonrpc: '2.0',
              id: request.id,
              error: {
                code: -32601,
                message: 'Method not found'
              }
            };
          }
          
          res.writeHead(200);
          res.end(JSON.stringify(response));
          console.log('Sent response:', JSON.stringify(response));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON-RPC request' }));
        }
      } catch (error) {
        console.error('Error processing request:', error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal server error', details: error.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Playwright MCP Server running on port ${PORT}`);
  console.log(`HTTP Health server running on port ${PORT}`);
  console.log(`MCP over HTTP available at: https://playwright-mcp-server.onrender.com`);
});

console.log('Playwright MCP Server running on port 10000');
