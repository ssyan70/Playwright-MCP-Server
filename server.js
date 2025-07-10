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

// Global browser instance only - NO global page/context
let browser;

// Session management for workflows
const sessions = new Map(); // sessionId -> { context, page, lastUsed }
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Helper function to ensure browser is running
async function ensureBrowser() {
  try {
    // Check if browser exists and is connected
    if (browser) {
      try {
        await browser.version(); // Test connection
        return browser;
      } catch (error) {
        console.log('Browser connection lost, will reinitialize');
        browser = null;
      }
    }
    
    // Initialize browser if needed
    if (!browser) {
      console.log('Launching browser...');
      browser = await chromium.launch({ 
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });
    }
    
    return browser;
    
  } catch (error) {
    console.error('Browser initialization failed:', error);
    browser = null;
    throw new Error(`Browser initialization failed: ${error.message}`);
  }
}

// Clean up expired sessions
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastUsed > SESSION_TIMEOUT) {
      console.log(`Cleaning up expired session: ${sessionId}`);
      session.context.close().catch(e => console.warn('Session cleanup error:', e.message));
      sessions.delete(sessionId);
    }
  }
}

// Get or create session-based context
async function getSessionContext(sessionId = 'default') {
  // Cleanup expired sessions periodically
  if (Math.random() < 0.1) { // 10% chance to cleanup on each call
    cleanupExpiredSessions();
  }
  
  // Check if session exists and is still valid
  if (sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    try {
      // Test if context is still valid
      await session.page.evaluate(() => true);
      session.lastUsed = Date.now();
      console.log(`Reusing existing session: ${sessionId}`);
      return { context: session.context, page: session.page };
    } catch (error) {
      console.log(`Session ${sessionId} is invalid, creating new one`);
      sessions.delete(sessionId);
    }
  }
  
  // Create new session
  const browserInstance = await ensureBrowser();
  const context = await browserInstance.newContext({
    viewport: { width: 1200, height: 800 }
  });
  const page = await context.newPage();
  
  sessions.set(sessionId, {
    context,
    page,
    lastUsed: Date.now()
  });
  
  console.log(`Created new session: ${sessionId}`);
  return { context, page };
}

// Screenshot capture function
async function captureScreenshot(page, filename = null) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotName = filename || `screenshot-${timestamp}.png`;
    
    // Capture screenshot as base64
    const screenshot = await page.screenshot({ 
      fullPage: true,
      type: 'png'
    });
    
    // Convert to base64 string
    const base64Screenshot = screenshot.toString('base64');
    
    return {
      success: true,
      filename: screenshotName,
      base64: base64Screenshot,
      url: page.url(),
      timestamp: new Date().toISOString(),
      size: screenshot.length
    };
  } catch (error) {
    return {
      success: false,
      error: `Screenshot capture failed: ${error.message}`,
      timestamp: new Date().toISOString()
    };
  }
}

// HouseSigma Chart Data Extraction Function
async function extractHouseSigmaChartData(page, url) {
  const chartApiData = [];
  let responseHandler;
  
  try {
    // Set up response monitoring for chart API data
    responseHandler = async (response) => {
      const responseUrl = response.url();
      
      // Capture the specific chart API endpoint
      if (responseUrl.includes('/api/stats/trend/chart')) {
        try {
          const text = await response.text();
          const parsedData = JSON.parse(text);
          
          chartApiData.push({
            url: responseUrl,
            status: response.status(),
            contentType: response.headers()['content-type'] || '',
            timestamp: new Date().toISOString(),
            data: parsedData
          });
          
          console.log('Chart API data captured successfully');
        } catch (e) {
          console.warn('Failed to parse chart API response:', e.message);
        }
      }
    };
    
    page.on('response', responseHandler);
    
    // Navigate to the market trends page
    console.log('Navigating to market trends page');
    await page.goto(url, { waitUntil: 'networkidle' });
    
    // Wait for API calls to complete
    await page.waitForTimeout(10000);
    
    // Check if authentication is required
    const needsAuth = await page.evaluate(() => {
      return document.querySelectorAll('.blur-light, .blur, .auth-btn, [class*="login"]').length > 0;
    });
    
    if (needsAuth) {
      console.log('Authentication required - attempting login');
      
      // Navigate to login page
      await page.goto('https://housesigma.com/web/en/signin', { waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);
      
      // Fill login form
      const loginSuccess = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input');
        let emailInput = null;
        let passwordInput = null;
        
        for (let input of inputs) {
          const type = input.type.toLowerCase();
          const placeholder = (input.placeholder || '').toLowerCase();
          
          if (type === 'email' || placeholder.includes('email') || placeholder.includes('username')) {
            emailInput = input;
          } else if (type === 'password') {
            passwordInput = input;
          }
        }
        
        if (emailInput && passwordInput) {
          emailInput.value = 'sandeep@syans.com';
          emailInput.dispatchEvent(new Event('input', { bubbles: true }));
          
          passwordInput.value = '1856HS!';
          passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
          
          // Submit form
          const submitButton = document.querySelector('button[type="submit"], input[type="submit"]') || 
                             Array.from(document.querySelectorAll('button')).find(btn => 
                                 btn.textContent.toLowerCase().includes('sign in') || 
                                 btn.textContent.toLowerCase().includes('login'));
          
          if (submitButton) {
            submitButton.click();
            return true;
          }
        }
        return false;
      });
      
      if (loginSuccess) {
        await page.waitForTimeout(5000);
        
        // Navigate back to market trends page after login
        await page.goto(url, { waitUntil: 'networkidle' });
        await page.waitForTimeout(10000);
      }
    }
    
    // Return the chart data
    if (chartApiData.length > 0) {
      const latestChartData = chartApiData[chartApiData.length - 1];
      
      return {
        success: true,
        url: page.url(),
        chartData: latestChartData.data,
        apiUrl: latestChartData.url,
        timestamp: latestChartData.timestamp,
        summary: {
          dataPointsCount: latestChartData.data?.data?.chart?.length || 0,
          status: latestChartData.status
        }
      };
    } else {
      return {
        success: false,
        error: 'No chart API data was captured',
        url: page.url(),
        timestamp: new Date().toISOString()
      };
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    return {
      success: false,
      error: error.message,
      url: page.url(),
      timestamp: new Date().toISOString()
    };
  } finally {
    // Clean up event listener
    if (responseHandler) {
      try {
        page.removeListener('response', responseHandler);
      } catch (e) {
        console.warn('Event listener cleanup error:', e.message);
      }
    }
  }
}

// Define tools list response (complete with all tools)
const toolsList = {
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
      name: 'wait_for_content',
      description: 'Wait for dynamic content to load on the page',
      inputSchema: {
        type: 'object',
        properties: {
          seconds: {
            type: 'number',
            description: 'Number of seconds to wait (default: 3)',
            default: 3
          }
        },
        required: []
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
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 60000)',
            default: 60000
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
    },
    {
      name: 'capture_screenshot',
      description: 'Capture a screenshot of the current page and return as base64',
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Optional filename for the screenshot (default: auto-generated)',
            default: null
          }
        },
        required: []
      }
    },
    {
      name: 'get_screenshot_url',
      description: 'Capture screenshot and return a viewable data URL',
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Optional filename for the screenshot (default: auto-generated)',
            default: null
          }
        },
        required: []
      }
    },
    {
      name: 'extract_housesigma_chart',
      description: 'Extract chart data from HouseSigma market trends page with automatic authentication handling',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The HouseSigma market trends URL to extract chart data from'
          }
        },
        required: ['url']
      }
    }
  ]
};

// Tool implementations
server.setRequestHandler(ListToolsRequestSchema, async () => toolsList);

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  console.log(`Executing tool: ${name}`);
  
  let context = null;
  let page = null;
  
  try {
    // Create fresh context and page for each tool call
    ({ context, page } = await createFreshContext());
    
    switch (name) {
      case 'navigate_to_url':
        console.log(`Navigating to: ${args.url}`);
        await page.goto(args.url, { waitUntil: 'networkidle' });
        // Wait for dynamic content to load
        await page.waitForTimeout(3000);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully navigated to ${args.url} and waited for content to load`
            }
          ]
        };
        
      case 'wait_for_content':
        const waitSeconds = args.seconds || 3;
        await page.waitForTimeout(waitSeconds * 1000);
        return {
          content: [
            {
              type: 'text',
              text: `Waited ${waitSeconds} seconds for content to load`
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
        const timeout = args.timeout || 60000;
        // Wait for element to be visible and clickable before attempting click
        await page.waitForSelector(args.selector, { timeout: timeout, state: 'visible' });
        await page.click(args.selector, { timeout });
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

      case 'capture_screenshot':
        const screenshotResult = await captureScreenshot(page, args.filename);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(screenshotResult, null, 2)
            }
          ]
        };

      case 'get_screenshot_url':
        const screenshotUrlResult = await captureScreenshot(page, args.filename);
        if (screenshotUrlResult.success) {
          const dataUrl = `data:image/png;base64,${screenshotUrlResult.base64}`;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ...screenshotUrlResult,
                  dataUrl: dataUrl,
                  viewInstructions: "Copy the dataUrl value and paste it into your browser address bar to view the image"
                }, null, 2)
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(screenshotUrlResult, null, 2)
              }
            ]
          };
        }

      case 'extract_housesigma_chart':
        const chartResult = await extractHouseSigmaChartData(page, args.url);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(chartResult, null, 2)
            }
          ]
        };
        
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error(`Tool execution failed for ${name}:`, error);
    throw new Error(`Tool execution failed: ${error.message}`);
  } finally {
    // CRITICAL: Always cleanup context to prevent memory leaks
    if (context) {
      try {
        console.log('Closing browser context...');
        // Add a small delay to ensure operations complete before cleanup
        await new Promise(resolve => setTimeout(resolve, 100));
        await context.close();
      } catch (e) {
        console.warn('Context cleanup error:', e.message);
      }
    }
  }
});

// Helper functions to handle MCP requests directly
async function handleToolsList() {
  return toolsList;
}

async function handleToolsCall(request) {
  const { name, arguments: args } = request.params;
  
  try {
    // Use session-based context instead of fresh context
    const { context, page } = await getSessionContext();
    
    switch (name) {
      case 'navigate_to_url':
        await page.goto(args.url, { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully navigated to ${args.url} and waited for content to load`
            }
          ]
        };
        
      case 'wait_for_content':
        const waitDuration = args.seconds || 3;
        await page.waitForTimeout(waitDuration * 1000);
        return {
          content: [
            {
              type: 'text',
              text: `Waited ${waitDuration} seconds for content to load`
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
        const timeout = args.timeout || 60000;
        // Wait for element to be visible and clickable before attempting click
        await page.waitForSelector(args.selector, { timeout: timeout, state: 'visible' });
        await page.click(args.selector, { timeout });
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

      case 'capture_screenshot':
        const screenshotResult = await captureScreenshot(page, args.filename);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(screenshotResult, null, 2)
            }
          ]
        };

      case 'extract_housesigma_chart':
        const chartResult = await extractHouseSigmaChartData(page, args.url);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(chartResult, null, 2)
            }
          ]
        };
        
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    throw new Error(`Tool execution failed: ${error.message}`);
  }
  // No finally block - sessions are managed separately
}

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
      tools: ['navigate_to_url', 'wait_for_content', 'fill_form', 'click_element', 'get_page_content', 'capture_screenshot', 'get_screenshot_url', 'extract_housesigma_chart'],
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // MCP HTTP Streamable endpoint - supports both GET and POST
  if (req.url === '/mcp' || req.url === '/') {
    if (req.method === 'GET') {
      // GET request for SSE fallback (legacy compatibility)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no'
      });

      const connectionId = Math.random().toString(36).substring(7);
      console.log(`New SSE connection: ${connectionId}`);
      connections.set(connectionId, res);

      // Send endpoint event for legacy SSE clients
      res.write(`data: /mcp\n\n`);

      req.on('close', () => {
        console.log(`SSE connection closed: ${connectionId}`);
        connections.delete(connectionId);
      });

      return;
    }

    if (req.method === 'POST') {
      // HTTP Streamable transport - modern MCP
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });

      req.on('end', async () => {
        let request;
        try {
          console.log('Received MCP request:', body);
          request = JSON.parse(body);
          
          let response;
          let sessionId;
          
          // Handle MCP JSON-RPC requests
          if (request.jsonrpc === '2.0') {
            if (request.method === 'initialize') {
              // Generate session ID for stateful sessions
              sessionId = Math.random().toString(36).substring(2, 15);
              
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
            } else if (request.method === 'notifications/initialized') {
              // Handle initialization notification (no response needed)
              console.log('Client initialized');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(); 
              return;
            } else if (request.method === 'tools/list') {
              const toolsResponse = await handleToolsList();
              
              response = {
                jsonrpc: '2.0',
                id: request.id,
                result: toolsResponse
              };
            } else if (request.method === 'tools/call') {
              const toolResponse = await handleToolsCall(request);
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
            
            // Set headers for HTTP Streamable
            const headers = {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            };
            
            // Add session ID if this is initialization
            if (sessionId) {
              headers['Mcp-Session-Id'] = sessionId;
            }
            
            res.writeHead(200, headers);
            res.end(JSON.stringify(response));
            console.log('Sent MCP response');
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON-RPC request' }));
          }
        } catch (error) {
          console.error('Error processing MCP request:', error);
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
  }

  // 404 for other routes
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  
  // Close all sessions
  for (const [sessionId, session] of sessions.entries()) {
    try {
      await session.context.close();
    } catch (e) {
      console.warn(`Error closing session ${sessionId}:`, e.message);
    }
  }
  sessions.clear();
  
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  
  // Close all sessions
  for (const [sessionId, session] of sessions.entries()) {
    try {
      await session.context.close();
    } catch (e) {
      console.warn(`Error closing session ${sessionId}:`, e.message);
    }
  }
  sessions.clear();
  
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`Playwright MCP Server running on port ${PORT}`);
  console.log(`HTTP Streamable endpoint: /mcp`);
  console.log(`Health check endpoint: /health`);
  console.log('Available tools: navigate_to_url, wait_for_content, fill_form, click_element, get_page_content, capture_screenshot, get_screenshot_url, extract_housesigma_chart');
});
