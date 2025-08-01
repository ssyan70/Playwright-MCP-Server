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

// Session management for stateful workflows
const sessions = new Map();
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes for workflow completion
const MAX_SESSIONS = 3; // Allow a few concurrent workflows

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
    '--max-old-space-size=256', // Reduced to 256MB for single task
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

// Get or create session-based context (restored for multi-step workflows)
async function getSessionContext(sessionId = 'default') {
  // Cleanup expired sessions
  cleanupExpiredSessions();
  
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
  
  // Enforce session limits
  await enforceSessionLimits();
  
  // Create new session
  const browserInstance = await ensureBrowser();
  const context = await browserInstance.newContext({
    viewport: { width: 1200, height: 800 }
  });
  const page = await context.newPage();
  
  // Set timeouts
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  
  sessions.set(sessionId, {
    context,
    page,
    lastUsed: Date.now()
  });
  
  console.log(`Created new session: ${sessionId}`);
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

// Complete MLS workflow function
async function completeMlsWorkflow(page, url, municipalitySelector, takeScreenshot, waitSeconds) {
  try {
    console.log(`Starting MLS workflow for: ${url}`);
    
    // Step 1: Navigate to MLS page
    console.log('Step 1: Navigating to MLS page...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000); // Wait for initial load
    
    // Step 2: Click municipality layer
    console.log(`Step 2: Clicking municipality selector: ${municipalitySelector}`);
    await page.waitForSelector(municipalitySelector, { timeout: 30000, state: 'visible' });
    await page.click(municipalitySelector);
    await page.waitForTimeout(waitSeconds * 1000); // Wait for layer to load
    
    // Step 3: Extract page data
    console.log('Step 3: Extracting page content...');
    const pageContent = await page.textContent('body');
    
    // Step 4: Capture screenshot if requested
    let screenshotResult = null;
    if (takeScreenshot) {
      console.log('Step 4: Capturing screenshot...');
      screenshotResult = await captureScreenshot(page);
    }
    
    // Step 5: Return comprehensive results
    const result = {
      success: true,
      workflow: 'complete_mls_workflow',
      steps: [
        { step: 1, action: 'navigate', url: page.url(), status: 'completed' },
        { step: 2, action: 'click_municipality', selector: municipalitySelector, status: 'completed' },
        { step: 3, action: 'extract_content', contentLength: pageContent?.length || 0, status: 'completed' },
        { step: 4, action: 'screenshot', status: takeScreenshot ? 'completed' : 'skipped' }
      ],
      data: {
        url: page.url(),
        pageContent: pageContent || 'No content extracted',
        contentLength: pageContent?.length || 0
      },
      screenshot: screenshotResult,
      timestamp: new Date().toISOString()
    };
    
    console.log('MLS workflow completed successfully');
    return result;
    
  } catch (error) {
    console.error('MLS workflow failed:', error.message);
    return {
      success: false,
      workflow: 'complete_mls_workflow',
      error: error.message,
      url: page.url(),
      timestamp: new Date().toISOString()
    };
  }
}

// Generic navigate-click-extract workflow
async function navigateClickExtract(page, url, clickSelector, extractSelector, waitAfterClick, takeScreenshot) {
  try {
    console.log(`Starting navigate-click-extract workflow for: ${url}`);
    
    // Step 1: Navigate
    console.log('Step 1: Navigating...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    // Step 2: Click element
    console.log(`Step 2: Clicking element: ${clickSelector}`);
    await page.waitForSelector(clickSelector, { timeout: 30000, state: 'visible' });
    await page.click(clickSelector);
    await page.waitForTimeout(waitAfterClick * 1000);
    
    // Step 3: Extract content
    let extractedContent = null;
    if (extractSelector) {
      console.log(`Step 3: Extracting content from: ${extractSelector}`);
      extractedContent = await page.textContent(extractSelector);
    } else {
      console.log('Step 3: Extracting full page content...');
      extractedContent = await page.textContent('body');
    }
    
    // Step 4: Screenshot if requested
    let screenshotResult = null;
    if (takeScreenshot) {
      console.log('Step 4: Capturing screenshot...');
      screenshotResult = await captureScreenshot(page);
    }
    
    return {
      success: true,
      workflow: 'navigate_click_extract',
      steps: [
        { step: 1, action: 'navigate', url: page.url(), status: 'completed' },
        { step: 2, action: 'click', selector: clickSelector, status: 'completed' },
        { step: 3, action: 'extract', selector: extractSelector || 'body', status: 'completed' },
        { step: 4, action: 'screenshot', status: takeScreenshot ? 'completed' : 'skipped' }
      ],
      data: {
        url: page.url(),
        extractedContent: extractedContent || 'No content found',
        contentLength: extractedContent?.length || 0
      },
      screenshot: screenshotResult,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('Navigate-click-extract workflow failed:', error.message);
    return {
      success: false,
      workflow: 'navigate_click_extract',
      error: error.message,
      url: page.url(),
      timestamp: new Date().toISOString()
    };
  }
}
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

// Tool definitions - Updated with workflow-based tools
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
      name: 'complete_mls_workflow',
      description: 'Complete MLS workflow: navigate, click municipalities, gather data, screenshot',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'MLS Communities URL' },
          municipalitySelector: { type: 'string', description: 'CSS selector for municipality layer', default: '#munilayer' },
          takeScreenshot: { type: 'boolean', description: 'Capture screenshot after actions', default: true },
          waitSeconds: { type: 'number', description: 'Seconds to wait after clicking', default: 3 }
        },
        required: ['url']
      }
    },
    {
      name: 'navigate_click_extract',
      description: 'Navigate to URL, click element, extract content - complete workflow',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          clickSelector: { type: 'string', description: 'CSS selector to click' },
          extractSelector: { type: 'string', description: 'CSS selector to extract content from (optional)' },
          waitAfterClick: { type: 'number', description: 'Seconds to wait after clicking', default: 3 },
          takeScreenshot: { type: 'boolean', description: 'Capture screenshot', default: false }
        },
        required: ['url', 'clickSelector']
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
  
  // Extract session ID from arguments (n8n workflows can pass this)
  const sessionId = args.sessionId || 'default';
  
  // Special case: cleanup tool
  if (name === 'cleanup_resources') {
    // If sessionId provided, clean up specific session, otherwise all
    if (args.sessionId && sessions.has(args.sessionId)) {
      const session = sessions.get(args.sessionId);
      try {
        await session.context.close();
        sessions.delete(args.sessionId);
        console.log(`Cleaned up session: ${args.sessionId}`);
      } catch (e) {
        console.warn(`Error cleaning session ${args.sessionId}:`, e.message);
      }
    } else {
      await forceCleanupAll();
    }
    return {
      content: [{
        type: 'text',
        text: 'Browser resources cleaned up successfully'
      }]
    };
  }
  
  // Use session-based context for stateful workflows
  const { context, page } = await getSessionContext(sessionId);
    
  try {
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
        
      case 'complete_mls_workflow':
        const mlsResult = await completeMlsWorkflow(
          page, 
          args.url, 
          args.municipalitySelector || '#munilayer',
          args.takeScreenshot !== false,
          args.waitSeconds || 3
        );
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(mlsResult, null, 2)
          }]
        };
        
      case 'navigate_click_extract':
        const workflowResult = await navigateClickExtract(
          page,
          args.url,
          args.clickSelector,
          args.extractSelector,
          args.waitAfterClick || 3,
          args.takeScreenshot || false
        );
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(workflowResult, null, 2)
          }]
        };
        
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error(`Tool execution failed for ${name}:`, error);
    throw new Error(`Tool execution failed: ${error.message}`);
  }
  // No cleanup - sessions persist for multi-step workflows
});
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
              // Handle tool calls manually - server.handleRequest doesn't exist
              const { name, arguments: args } = request.params;
              console.log(`Executing tool via HTTP: ${name}`);
              
              let context = null;
              let page = null;
              
              try {
                // Handle cleanup_resources tool
                if (name === 'cleanup_resources') {
                  await forceCleanupAll();
                  response = {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                      content: [{
                        type: 'text',
                        text: 'All browser resources cleaned up successfully'
                      }]
                    }
                  };
                } else {
                  // Create fresh context for other tools
                  ({ context, page } = await createFreshContext());
                  
                  let toolResult;
                  
                  switch (name) {
                    case 'navigate_to_url':
                      await page.goto(args.url, { waitUntil: 'networkidle', timeout: 30000 });
                      await page.waitForTimeout(2000);
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: `Successfully navigated to ${args.url}`
                        }]
                      };
                      break;
                      
                    case 'wait_for_content':
                      const waitSeconds = args.seconds || 3;
                      await page.waitForTimeout(waitSeconds * 1000);
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: `Waited ${waitSeconds} seconds for content`
                        }]
                      };
                      break;
                      
                    case 'fill_form':
                      await page.fill(args.selector, args.value);
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: `Filled ${args.selector} with: ${args.value}`
                        }]
                      };
                      break;
                      
                    case 'click_element':
                      const timeout = args.timeout || 30000;
                      await page.waitForSelector(args.selector, { timeout, state: 'visible' });
                      await page.click(args.selector, { timeout });
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: `Clicked element: ${args.selector}`
                        }]
                      };
                      break;
                      
                    case 'get_page_content':
                      const content = await page.textContent('body');
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: content || 'No content found'
                        }]
                      };
                      break;
                      
                    case 'capture_screenshot':
                      const screenshotResult = await captureScreenshot(page, args.filename);
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: JSON.stringify(screenshotResult, null, 2)
                        }]
                      };
                      break;
                      
                    case 'extract_housesigma_chart':
                      const chartResult = await extractHouseSigmaChartData(page, args.url);
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: JSON.stringify(chartResult, null, 2)
                        }]
                      };
                      break;
                      
                    case 'complete_mls_workflow':
                      const mlsResult = await completeMlsWorkflow(
                        page, 
                        args.url, 
                        args.municipalitySelector || '#munilayer',
                        args.takeScreenshot !== false, // Default true
                        args.waitSeconds || 3
                      );
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: JSON.stringify(mlsResult, null, 2)
                        }]
                      };
                      break;
                      
                    case 'navigate_click_extract':
                      const workflowResult = await navigateClickExtract(
                        page,
                        args.url,
                        args.clickSelector,
                        args.extractSelector,
                        args.waitAfterClick || 3,
                        args.takeScreenshot || false
                      );
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: JSON.stringify(workflowResult, null, 2)
                        }]
                      };
                      break;
                      
                    default:
                      throw new Error(`Unknown tool: ${name}`);
                  }
                  
                  response = {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: toolResult
                  };
                }
              } catch (toolError) {
                console.error(`Tool execution failed for ${name}:`, toolError);
                response = {
                  jsonrpc: '2.0',
                  id: request.id,
                  error: {
                    code: -32603,
                    message: `Tool execution failed: ${toolError.message}`
                  }
                };
              } finally {
                // Cleanup context
                if (context) {
                  try {
                    await context.close();
                  } catch (e) {
                    console.warn('Context cleanup error:', e.message);
                  }
                }
              }
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

// Periodic cleanup - more frequent for session-based approach
setInterval(() => {
  const cleaned = cleanupExpiredSessions();
  if (cleaned > 0) {
    console.log(`Periodic cleanup: removed ${cleaned} expired sessions`);
  }
  
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }
}, 60000); // Every 60 seconds

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
  console.log('Memory-optimized for 1 task at a time - SEQUENTIAL EXECUTION ONLY');
});
