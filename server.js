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

// Global browser instance with resource limits
let browser = null;

// Session management - reduced timeout and max sessions
const sessions = new Map();
const SESSION_TIMEOUT = 2 * 60 * 1000; // Reduced to 2 minutes
const MAX_SESSIONS = 5; // Limit concurrent sessions
const MAX_PAGES_PER_CONTEXT = 3; // Limit pages per context

// Browser configuration with memory limits
const BROWSER_CONFIG = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-web-security',
    '--disable-features=TranslateUI',
    '--disable-ipc-flooding-protection',
    '--memory-pressure-off',
    '--max-old-space-size=512', // Limit V8 heap to 512MB
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-networking'
  ]
};

// Helper function to ensure browser with resource monitoring
async function ensureBrowser() {
  try {
    if (browser) {
      try {
        await browser.version();
        return browser;
      } catch (error) {
        console.log('Browser connection lost, reinitializing...');
        browser = null;
      }
    }
    
    if (!browser) {
      console.log('Launching browser with memory limits...');
      browser = await chromium.launch(BROWSER_CONFIG);
      
      // Monitor browser resource usage
      browser.on('disconnected', () => {
        console.log('Browser disconnected');
        browser = null;
        // Force cleanup all sessions when browser disconnects
        sessions.clear();
      });
    }
    
    return browser;
    
  } catch (error) {
    console.error('Browser initialization failed:', error);
    browser = null;
    throw new Error(`Browser initialization failed: ${error.message}`);
  }
}

// Aggressive session cleanup
function cleanupExpiredSessions() {
  const now = Date.now();
  const expiredSessions = [];
  
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastUsed > SESSION_TIMEOUT) {
      expiredSessions.push(sessionId);
    }
  }
  
  // Close expired sessions
  expiredSessions.forEach(async (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) {
      console.log(`Cleaning up expired session: ${sessionId}`);
      try {
        await session.context.close();
      } catch (e) {
        console.warn(`Session cleanup error for ${sessionId}:`, e.message);
      }
      sessions.delete(sessionId);
    }
  });
  
  return expiredSessions.length;
}

// Enforce session limits
async function enforceSessionLimits() {
  if (sessions.size >= MAX_SESSIONS) {
    // Close oldest session
    let oldestSessionId = null;
    let oldestTime = Date.now();
    
    for (const [sessionId, session] of sessions.entries()) {
      if (session.lastUsed < oldestTime) {
        oldestTime = session.lastUsed;
        oldestSessionId = sessionId;
      }
    }
    
    if (oldestSessionId) {
      const session = sessions.get(oldestSessionId);
      console.log(`Closing oldest session to enforce limits: ${oldestSessionId}`);
      try {
        await session.context.close();
      } catch (e) {
        console.warn(`Error closing oldest session:`, e.message);
      }
      sessions.delete(oldestSessionId);
    }
  }
}

// Create context with strict resource limits
async function createResourceLimitedContext() {
  const browserInstance = await ensureBrowser();
  
  const context = await browserInstance.newContext({
    viewport: { width: 1200, height: 800 },
    // Resource limits
    ignoreHTTPSErrors: true,
    bypassCSP: true,
    // Reduce memory usage
    reducedMotion: 'reduce',
    colorScheme: 'no-preference'
  });
  
  // Set page limits and error handling
  context.setDefaultTimeout(30000); // 30s timeout
  context.setDefaultNavigationTimeout(30000);
  
  return context;
}

// SINGLE STRATEGY: Always create fresh context per tool call
async function createFreshContext() {
  console.log('Creating fresh context for tool execution...');
  
  const context = await createResourceLimitedContext();
  const page = await context.newPage();
  
  // Set aggressive timeouts
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  
  // Disable unnecessary features to save memory
  await page.setViewportSize({ width: 1200, height: 800 });
  
  return { context, page };
}

// Force cleanup of all resources
async function forceCleanupAll() {
  console.log('Forcing cleanup of all resources...');
  
  // Close all sessions
  const sessionCleanupPromises = [];
  for (const [sessionId, session] of sessions.entries()) {
    sessionCleanupPromises.push(
      session.context.close().catch(e => 
        console.warn(`Error closing session ${sessionId}:`, e.message)
      )
    );
  }
  
  await Promise.allSettled(sessionCleanupPromises);
  sessions.clear();
  
  // Close browser if needed
  if (browser) {
    try {
      await browser.close();
      browser = null;
      console.log('Browser closed successfully');
    } catch (e) {
      console.warn('Error closing browser:', e.message);
      browser = null;
    }
  }
}

// Screenshot with memory management
async function captureScreenshot(page, filename = null) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotName = filename || `screenshot-${timestamp}.png`;
    
    // Capture full quality for AI analysis
    const screenshot = await page.screenshot({ 
      fullPage: true, // Full page for complete AI analysis
      type: 'png'
      // No quality reduction - AI needs full quality
    });
    
    const base64Screenshot = screenshot.toString('base64');
    
    // Clear screenshot buffer immediately after conversion
    screenshot.fill(0);
    
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

// HouseSigma extraction with better memory management
async function extractHouseSigmaChartData(page, url) {
  const chartApiData = [];
  let responseHandler = null;
  
  try {
    // Create handler with automatic cleanup
    responseHandler = async (response) => {
      const responseUrl = response.url();
      
      if (responseUrl.includes('/api/stats/trend/chart')) {
        try {
          const text = await response.text();
          const parsedData = JSON.parse(text);
          
          // Only keep the most recent data to save memory
          if (chartApiData.length > 2) {
            chartApiData.shift(); // Remove oldest
          }
          
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
    
    // Navigate with timeout
    console.log('Navigating to market trends page');
    await page.goto(url, { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });
    
    // Reduced wait time
    await page.waitForTimeout(5000);
    
    // Check authentication
    const needsAuth = await page.evaluate(() => {
      return document.querySelectorAll('.blur-light, .blur, .auth-btn, [class*="login"]').length > 0;
    });
    
    if (needsAuth) {
      console.log('Authentication required - attempting login');
      
      await page.goto('https://housesigma.com/web/en/signin', { 
        waitUntil: 'networkidle',
        timeout: 30000 
      });
      await page.waitForTimeout(2000);
      
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
        await page.waitForTimeout(3000);
        await page.goto(url, { 
          waitUntil: 'networkidle',
          timeout: 30000 
        });
        await page.waitForTimeout(5000);
      }
    }
    
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
    // Guaranteed cleanup
    if (responseHandler) {
      try {
        page.removeListener('response', responseHandler);
        console.log('Response handler cleaned up');
      } catch (e) {
        console.warn('Event listener cleanup error:', e.message);
      }
    }
  }
}

// Tool definitions
const toolsList = {
  tools: [
    {
      name: 'navigate_to_url',
      description: 'Navigate to a specific URL',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to navigate to' }
        },
        required: ['url']
      }
    },
    {
      name: 'wait_for_content',
      description: 'Wait for dynamic content to load',
      inputSchema: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'Seconds to wait (default: 3)', default: 3 }
        },
        required: []
      }
    },
    {
      name: 'fill_form',
      description: 'Fill out a form field',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector' },
          value: { type: 'string', description: 'Value to fill' }
        },
        required: ['selector', 'value']
      }
    },
    {
      name: 'click_element',
      description: 'Click on an element',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector' },
          timeout: { type: 'number', description: 'Timeout in ms', default: 30000 }
        },
        required: ['selector']
      }
    },
    {
      name: 'get_page_content',
      description: 'Get page text content',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'capture_screenshot',
      description: 'Capture screenshot as base64',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Optional filename', default: null }
        },
        required: []
      }
    },
    {
      name: 'extract_housesigma_chart',
      description: 'Extract HouseSigma chart data with auth',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HouseSigma trends URL' }
        },
        required: ['url']
      }
    },
    {
      name: 'cleanup_resources',
      description: 'Force cleanup all browser resources',
      inputSchema: { type: 'object', properties: {}, required: [] }
    }
  ]
};

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => toolsList);

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  console.log(`Executing tool: ${name}`);
  
  // Special case: cleanup tool
  if (name === 'cleanup_resources') {
    await forceCleanupAll();
    return {
      content: [{
        type: 'text',
        text: 'All browser resources cleaned up successfully'
      }]
    };
  }
  
  let context = null;
  let page = null;
  
  try {
    // Always use fresh context for each tool call
    ({ context, page } = await createFreshContext());
    
    switch (name) {
      case 'navigate_to_url':
        console.log(`Navigating to: ${args.url}`);
        await page.goto(args.url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);
        return {
          content: [{
            type: 'text',
            text: `Successfully navigated to ${args.url}`
          }]
        };
        
      case 'wait_for_content':
        const waitSeconds = args.seconds || 3;
        await page.waitForTimeout(waitSeconds * 1000);
        return {
          content: [{
            type: 'text',
            text: `Waited ${waitSeconds} seconds for content`
          }]
        };
        
      case 'fill_form':
        await page.fill(args.selector, args.value);
        return {
          content: [{
            type: 'text',
            text: `Filled ${args.selector} with: ${args.value}`
          }]
        };
        
      case 'click_element':
        const timeout = args.timeout || 30000;
        await page.waitForSelector(args.selector, { timeout, state: 'visible' });
        await page.click(args.selector, { timeout });
        return {
          content: [{
            type: 'text',
            text: `Clicked element: ${args.selector}`
          }]
        };
        
      case 'get_page_content':
        const content = await page.textContent('body');
        return {
          content: [{
            type: 'text',
            text: content || 'No content found'
          }]
        };

      case 'capture_screenshot':
        const screenshotResult = await captureScreenshot(page, args.filename);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(screenshotResult, null, 2)
          }]
        };

      case 'extract_housesigma_chart':
        const chartResult = await extractHouseSigmaChartData(page, args.url);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(chartResult, null, 2)
          }]
        };
        
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error(`Tool execution failed for ${name}:`, error);
    throw new Error(`Tool execution failed: ${error.message}`);
  } finally {
    // CRITICAL: Always cleanup context immediately
    if (context) {
      try {
        console.log('Closing browser context...');
        await context.close();
        console.log('Context closed successfully');
      } catch (e) {
        console.warn('Context cleanup error:', e.message);
      }
    }
  }
});

// HTTP server
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  console.log(`${req.method} ${req.url}`);

  // Health check with memory info
  if (req.method === 'GET' && req.url === '/health') {
    const memUsage = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      service: 'playwright-mcp-server',
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB'
      },
      activeSessions: sessions.size,
      browserConnected: browser ? true : false,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Cleanup endpoint
  if (req.method === 'POST' && req.url === '/cleanup') {
    forceCleanupAll().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Resources cleaned up' }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // MCP endpoint
  if (req.url === '/mcp' || req.url === '/') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });

      req.on('end', async () => {
        try {
          const request = JSON.parse(body);
          let response;
          
          if (request.jsonrpc === '2.0') {
            if (request.method === 'initialize') {
              response = {
                jsonrpc: '2.0',
                id: request.id,
                result: {
                  protocolVersion: '2025-03-26',
                  capabilities: { tools: {}, prompts: {}, resources: {} },
                  serverInfo: { name: 'playwright-mcp-server', version: '0.1.0' }
                }
              };
            } else if (request.method === 'notifications/initialized') {
              console.log('Client initialized');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(); 
              return;
            } else if (request.method === 'tools/list') {
              response = { jsonrpc: '2.0', id: request.id, result: toolsList };
            } else if (request.method === 'tools/call') {
              const toolResponse = await server.handleRequest(request);
              response = { jsonrpc: '2.0', id: request.id, result: toolResponse };
            } else {
              response = {
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32601, message: `Method not found: ${request.method}` }
              };
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
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
            error: { code: -32603, message: `Internal error: ${error.message}` }
          }));
        }
      });
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Periodic cleanup
setInterval(() => {
  const cleaned = cleanupExpiredSessions();
  if (cleaned > 0) {
    console.log(`Periodic cleanup: removed ${cleaned} expired sessions`);
  }
}, 30000); // Every 30 seconds

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);
  await forceCleanupAll();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start server
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`Optimized Playwright MCP Server running on port ${PORT}`);
  console.log(`Health check: /health`);
  console.log(`Manual cleanup: POST /cleanup`);
  console.log('Memory-optimized for 15 concurrent tasks');
});
