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

// Browser management with auto-cleanup
let browser;
let page;
let lastActivity = Date.now();
let isConnected = false;
const BROWSER_TIMEOUT = 300000; // 5 minutes
const MEMORY_CLEANUP_INTERVAL = 60000; // 1 minute

// Optimized browser launch options (conditional for different workflows)
const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--disable-web-security',
  '--disable-features=TranslateUI,BlinkGenPropertyTrees',
  '--disable-ipc-flooding-protection',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-extensions',
  '--disable-plugins',
  '--disable-images', // Will be removed for mapping workflows
  '--disable-javascript', // Will be removed when needed
  '--memory-pressure-off',
  '--max_old_space_size=384', // Increased from 256 for mapping
  '--optimize-for-size'
];

// Helper function to ensure browser is running with workflow-specific optimization
async function ensureBrowser(enableJS = false, highQuality = false) {
  lastActivity = Date.now();
  
  // Check if browser is still connected
  if (browser && isConnected) {
    try {
      // Test if browser is still responsive
      await browser.version();
      return page;
    } catch (error) {
      console.log('Browser connection lost, reinitializing...');
      browser = null;
      page = null;
      isConnected = false;
    }
  }
  
  if (!browser || !isConnected) {
    try {
      let launchArgs = [...BROWSER_ARGS];
      
      // For TREB community mapping, we need images and better quality
      if (highQuality) {
        launchArgs = launchArgs.filter(arg => 
          !arg.includes('--disable-images') && 
          !arg.includes('--disable-javascript')
        );
      }
      
      // Remove --disable-javascript if JS is needed
      if (enableJS) {
        const jsIndex = launchArgs.indexOf('--disable-javascript');
        if (jsIndex > -1) launchArgs.splice(jsIndex, 1);
      }
      
      console.log('Launching new browser instance...');
      browser = await chromium.launch({ 
        headless: true,
        args: launchArgs
      });
      
      const viewportConfig = highQuality ? 
        { width: 1200, height: 800 } :  // Larger viewport for mapping
        { width: 800, height: 600 };   // Smaller for other tasks
      
      page = await browser.newPage({
        viewport: viewportConfig,
        extraHTTPHeaders: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      
      // Conditional resource blocking - allow images for mapping workflows
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        const url = route.request().url();
        
        if (highQuality) {
          // For TREB mapping, only block fonts and media, allow images and CSS
          if (['font', 'media'].includes(resourceType)) {
            route.abort();
          } else {
            route.continue();
          }
        } else {
          // For other workflows, block more aggressively
          if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            route.abort();
          } else {
            route.continue();
          }
        }
      });
      
      isConnected = true;
      console.log('Browser initialized successfully');
      
    } catch (error) {
      console.error('Failed to initialize browser:', error);
      browser = null;
      page = null;
      isConnected = false;
      throw new Error(`Browser initialization failed: ${error.message}`);
    }
  }
  
  return page;
}

// Cleanup browser when idle
async function cleanupBrowser() {
  if (browser && isConnected && (Date.now() - lastActivity) > BROWSER_TIMEOUT) {
    console.log('Cleaning up idle browser...');
    try {
      await browser.close();
    } catch (error) {
      console.error('Error closing browser:', error);
    } finally {
      browser = null;
      page = null;
      isConnected = false;
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
    }
  }
}

// Periodic cleanup
setInterval(cleanupBrowser, MEMORY_CLEANUP_INTERVAL);

// Optimized screenshot capture function with quality options
async function captureScreenshot(page, filename = null, highQuality = false) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotName = filename || `screenshot-${timestamp}.png`;
    
    // Dynamic quality based on use case
    const screenshotOptions = highQuality ? {
      fullPage: true,  // Full page for mapping
      type: 'png',
      // No quality reduction for mapping workflows
    } : {
      fullPage: false, // Only visible area for other uses
      type: 'png',
      quality: 70, // Reduced quality for non-critical screenshots
      clip: { x: 0, y: 0, width: 800, height: 600 }
    };
    
    const screenshot = await page.screenshot(screenshotOptions);
    const base64Screenshot = screenshot.toString('base64');
    
    return {
      success: true,
      filename: screenshotName,
      base64: base64Screenshot,
      url: page.url(),
      timestamp: new Date().toISOString(),
      size: screenshot.length,
      quality: highQuality ? 'high' : 'optimized'
    };
  } catch (error) {
    return {
      success: false,
      error: `Screenshot capture failed: ${error.message}`,
      timestamp: new Date().toISOString()
    };
  }
}

// Optimized HouseSigma extraction with memory management
async function extractHouseSigmaChartData(page, url) {
  const chartApiData = [];
  let responseHandler;
  
  try {
    // Set up response monitoring
    responseHandler = async (response) => {
      const responseUrl = response.url();
      
      if (responseUrl.includes('/api/stats/trend/chart')) {
        try {
          const text = await response.text();
          const parsedData = JSON.parse(text);
          
          // Keep only essential data to reduce memory
          chartApiData.push({
            url: responseUrl,
            status: response.status(),
            timestamp: new Date().toISOString(),
            data: {
              chart: parsedData.data?.chart?.slice(0, 100) || [], // Limit data points
              summary: parsedData.summary || {}
            }
          });
          
          console.log('Chart API data captured');
        } catch (e) {
          console.warn('Failed to parse chart API response:', e.message);
        }
      }
    };
    
    page.on('response', responseHandler);
    
    // Navigate with shorter timeout
    await page.goto(url, { 
      waitUntil: 'domcontentloaded', // Faster than networkidle
      timeout: 30000 
    });
    
    // Reduced wait time
    await page.waitForTimeout(5000);
    
    // Quick auth check
    const needsAuth = await page.evaluate(() => {
      return document.querySelectorAll('.blur-light, .blur, .auth-btn').length > 0;
    });
    
    if (needsAuth) {
      console.log('Authentication required - attempting login');
      
      await page.goto('https://housesigma.com/web/en/signin', { 
        waitUntil: 'domcontentloaded',
        timeout: 20000 
      });
      await page.waitForTimeout(2000);
      
      // Simplified login
      await page.fill('input[type="email"], input[placeholder*="email" i]', 'sandeep@syans.com');
      await page.fill('input[type="password"]', '1856HS!');
      await page.click('button[type="submit"], button:has-text("Sign in")');
      
      await page.waitForTimeout(3000);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
    }
    
    // Clean up event listener
    page.removeListener('response', responseHandler);
    
    if (chartApiData.length > 0) {
      const latestChartData = chartApiData[chartApiData.length - 1];
      
      return {
        success: true,
        url: page.url(),
        chartData: latestChartData.data,
        timestamp: latestChartData.timestamp,
        summary: {
          dataPointsCount: latestChartData.data?.chart?.length || 0,
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
    // Clean up event listener on error
    if (responseHandler) {
      page.removeListener('response', responseHandler);
    }
    
    console.error('Error:', error.message);
    return {
      success: false,
      error: error.message,
      url: page.url(),
      timestamp: new Date().toISOString()
    };
  }
}

// Simplified tools list (static)
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
        }
      }
    },
    {
      name: 'fill_form',
      description: 'Fill form field',
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
      description: 'Click element',
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
      name: 'capture_screenshot',
      description: 'Capture screenshot with quality options for mapping workflows',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Optional filename' },
          highQuality: { type: 'boolean', description: 'Use high quality for mapping (default: false)', default: false }
        }
      }
    },
    {
      name: 'extract_housesigma_chart',
      description: 'Extract HouseSigma chart data',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HouseSigma URL' }
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
  
  try {
    // Determine if JavaScript and high quality are needed
    const needsJS = ['extract_housesigma_chart', 'fill_form', 'click_element'].includes(name);
    const needsHighQuality = name === 'capture_screenshot' && args.highQuality;
    const currentPage = await ensureBrowser(needsJS, needsHighQuality);
    
    switch (name) {
      case 'navigate_to_url':
        // Use high quality mode for TREB community URLs
        const isTREBMapping = args.url.includes('torontomls.net') || args.url.includes('Communities');
        if (isTREBMapping && !needsHighQuality) {
          // Restart browser in high quality mode for TREB mapping
          if (browser && isConnected) {
            try {
              await browser.close();
            } catch (error) {
              console.error('Error closing browser for restart:', error);
            } finally {
              browser = null;
              page = null;
              isConnected = false;
            }
          }
          const mappingPage = await ensureBrowser(true, true);
          await mappingPage.goto(args.url, { 
            waitUntil: 'networkidle',  // Use networkidle for mapping sites
            timeout: 45000 
          });
          await mappingPage.waitForTimeout(3000);
        } else {
          await currentPage.goto(args.url, { 
            waitUntil: 'domcontentloaded',
            timeout: 30000 
          });
          await currentPage.waitForTimeout(2000);
        }
        return {
          content: [{
            type: 'text',
            text: `Navigated to ${args.url}`
          }]
        };
        
      case 'wait_for_content':
        const waitSeconds = Math.min(args.seconds || 3, 10); // Cap at 10 seconds
        await currentPage.waitForTimeout(waitSeconds * 1000);
        return {
          content: [{
            type: 'text',
            text: `Waited ${waitSeconds} seconds`
          }]
        };
        
      case 'fill_form':
        await currentPage.fill(args.selector, args.value, { timeout: 15000 });
        return {
          content: [{
            type: 'text',
            text: `Filled ${args.selector} with: ${args.value}`
          }]
        };
        
      case 'click_element':
        const timeout = Math.min(args.timeout || 30000, 60000); // Cap timeout
        await currentPage.click(args.selector, { timeout });
        return {
          content: [{
            type: 'text',
            text: `Clicked: ${args.selector}`
          }]
        };

      case 'capture_screenshot':
        const screenshotResult = await captureScreenshot(currentPage, args.filename, args.highQuality);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(screenshotResult)
          }]
        };

      case 'extract_housesigma_chart':
        const chartResult = await extractHouseSigmaChartData(currentPage, args.url);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(chartResult)
          }]
        };
        
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error('Tool execution error:', error);
    // Force cleanup on error and reset connection state
    if (browser) {
      try { 
        await browser.close(); 
      } catch (closeError) {
        console.error('Error during emergency browser close:', closeError);
      } finally {
        browser = null;
        page = null;
        isConnected = false;
      }
    }
    throw new Error(`Tool execution failed: ${error.message}`);
  }
});

// Streamlined HTTP server with connection limits
const connections = new Map();
const MAX_CONNECTIONS = 10; // Limit concurrent connections

const httpServer = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      service: 'playwright-mcp-server',
      memory: process.memoryUsage(),
      connections: connections.size,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // MCP endpoint
  if (req.url === '/mcp' || req.url === '/') {
    if (req.method === 'GET') {
      // Limit SSE connections
      if (connections.size >= MAX_CONNECTIONS) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Too many connections');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      const connectionId = Math.random().toString(36).substring(7);
      connections.set(connectionId, res);
      res.write(`data: /mcp\n\n`);

      req.on('close', () => {
        connections.delete(connectionId);
      });
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      const maxSize = 1024 * 1024; // 1MB limit
      let size = 0;

      req.on('data', chunk => {
        size += chunk.length;
        if (size > maxSize) {
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Request too large');
          return;
        }
        body += chunk.toString();
      });

      req.on('end', async () => {
        try {
          const request = JSON.parse(body);
          let response;
          
          if (request.jsonrpc === '2.0') {
            switch (request.method) {
              case 'initialize':
                response = {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: {
                    protocolVersion: '2025-03-26',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'playwright-mcp-server', version: '0.1.0' }
                  }
                };
                break;
                
              case 'notifications/initialized':
                res.writeHead(200);
                res.end();
                return;
                
              case 'tools/list':
                response = {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: toolsList
                };
                break;
                
              case 'tools/call':
                const toolResponse = await server.request(request);
                response = {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: toolResponse.result
                };
                break;
                
              default:
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
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: `Internal error: ${error.message}` }
          }));
        }
      });
      return;
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

// Cleanup handlers
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  if (browser && isConnected) {
    try {
      await browser.close();
    } catch (error) {
      console.error('Error during shutdown:', error);
    }
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (browser && isConnected) {
    try {
      await browser.close();
    } catch (error) {
      console.error('Error during SIGTERM:', error);
    }
  }
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  if (browser && isConnected) {
    browser.close().catch(() => {});
  }
  process.exit(1);
});

// Start server
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`Memory-optimized Playwright MCP Server running on port ${PORT}`);
  console.log(`Max memory: ${process.env.NODE_OPTIONS || 'default'}`);
});
