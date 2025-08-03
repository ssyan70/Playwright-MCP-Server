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

// Session management with workflow-specific timeouts
const sessions = new Map();
const SESSION_TIMEOUTS = {
  'auto_www_onland_ca': 3 * 60 * 1000,      // 3 minutes - OnLand is fast
  'auto_housesigma_com': 8 * 60 * 1000,     // 8 minutes - HouseSigma needs auth
  'auto_www_torontomls_net': 10 * 60 * 1000, // 10 minutes - MLS is complex
  'default': 5 * 60 * 1000                   // 5 minutes - general fallback
};
const MAX_SESSIONS = 3;

// Browser configuration - restored to original working config
const BROWSER_CONFIG = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu'
    // Removed additional args that might interfere with page rendering
  ]
};

// Enhanced session ID extraction with STRICT workflow isolation
function getSessionId(args, toolName) {
  // If sessionId is explicitly provided, use it
  if (args.sessionId) {
    console.log(`Using explicit session ID: ${args.sessionId}`);
    return args.sessionId;
  }
  
  // For navigation tools, auto-generate from URL
  if (args.url && (toolName === 'navigate_to_url' || toolName === 'extract_housesigma_chart')) {
    try {
      const domain = new URL(args.url).hostname.replace(/[^a-zA-Z0-9]/g, '_');
      const sessionId = `auto_${domain}`;
      console.log(`Auto-generated session ID from URL: ${sessionId}`);
      return sessionId;
    } catch (e) {
      console.warn('Failed to parse URL for session ID:', e.message);
      return 'default';
    }
  }
  
  // For non-navigation tools, REQUIRE explicit sessionId or fail gracefully
  // This prevents accidental cross-workflow contamination
  if (sessions.size === 0) {
    console.log('No existing sessions, using default');
    return 'default';
  } else if (sessions.size === 1) {
    // Only if there's exactly ONE session, we can safely reuse it
    const singleSessionId = Array.from(sessions.keys())[0];
    console.log(`Using single existing session: ${singleSessionId}`);
    return singleSessionId;
  } else {
    // Multiple sessions exist - this is dangerous!
    // Log warning and use default to create new isolated session
    console.warn(`Multiple sessions exist (${Array.from(sessions.keys()).join(', ')}), creating new default session for ${toolName} to prevent cross-contamination`);
    return 'default_' + Date.now(); // Unique default session
  }
}

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

// Workflow-aware session cleanup
function cleanupExpiredSessions() {
  const now = Date.now();
  const expiredSessions = [];
  
  for (const [sessionId, session] of sessions.entries()) {
    const timeout = SESSION_TIMEOUTS[sessionId] || SESSION_TIMEOUTS['default'];
    if (now - session.lastUsed > timeout) {
      expiredSessions.push(sessionId);
    }
  }
  
  // Close expired sessions
  expiredSessions.forEach(async (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) {
      console.log(`Cleaning up expired session: ${sessionId} (timeout: ${SESSION_TIMEOUTS[sessionId] || SESSION_TIMEOUTS['default']}ms)`);
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

// Site-specific browser context configurations
function getContextConfig(sessionId) {
  const baseConfig = {
    viewport: { width: 1200, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  
  // Site-specific optimizations
  if (sessionId.includes('housesigma')) {
    return {
      ...baseConfig,
      // HouseSigma optimizations - handle auth cookies
      viewport: { width: 1400, height: 900 }, // Larger for charts
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    };
  } else if (sessionId.includes('torontomls')) {
    return {
      ...baseConfig,
      // MLS optimizations - handle complex map interactions
      viewport: { width: 1600, height: 1000 }, // Larger for maps
      hasTouch: true, // Enable touch events for map interactions
      isMobile: false
    };
  } else if (sessionId.includes('onland')) {
    return {
      ...baseConfig,
      // OnLand optimizations - fast property searches
      viewport: { width: 1200, height: 800 }, // Standard size
      extraHTTPHeaders: {
        'Accept': 'application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    };
  }
  
  return baseConfig;
}

// Get or create session-based context (for multi-step workflows)
async function getSessionContext(sessionId = 'default') {
  console.log(`Getting session context: ${sessionId}`);
  
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
  
  // Create new session with site-specific config
  const browserInstance = await ensureBrowser();
  const contextConfig = getContextConfig(sessionId);
  const context = await browserInstance.newContext(contextConfig);
  const page = await context.newPage();
  
  // Set timeouts
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  
  sessions.set(sessionId, {
    context,
    page,
    lastUsed: Date.now()
  });
  
  console.log(`Created new session: ${sessionId} with config:`, JSON.stringify(contextConfig, null, 2));
  return { context, page };
}

// Enhanced navigation with retry logic
async function robustNavigation(page, url, options = {}) {
  const maxRetries = options.retries || 2;
  const waitTime = options.waitTime || 3000;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Navigation attempt ${attempt}/${maxRetries} to: ${url}`);
      
      await page.goto(url, { 
        waitUntil: 'networkidle', 
        timeout: options.timeout || 30000 
      });
      
      // Site-specific post-navigation waits
      if (url.includes('housesigma.com')) {
        await page.waitForTimeout(5000); // Wait for React to load
      } else if (url.includes('torontomls.net')) {
        await page.waitForTimeout(4000); // Wait for map initialization
      } else if (url.includes('onland.ca')) {
        await page.waitForTimeout(2000); // OnLand is faster
      } else {
        await page.waitForTimeout(waitTime);
      }
      
      // Verify page loaded successfully
      const title = await page.title();
      if (title && !title.includes('Error') && !title.includes('404')) {
        console.log(`Navigation successful: ${title}`);
        return { success: true, title, attempt };
      }
      
    } catch (error) {
      console.warn(`Navigation attempt ${attempt} failed: ${error.message}`);
      if (attempt === maxRetries) {
        throw error;
      }
      await page.waitForTimeout(2000); // Wait before retry
    }
  }
}

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
          url: { type: 'string', description: 'The URL to navigate to' },
          sessionId: { type: 'string', description: 'Session ID for stateful workflows', default: 'default' }
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
          seconds: { type: 'number', description: 'Seconds to wait (default: 3)', default: 3 },
          sessionId: { type: 'string', description: 'Session ID for stateful workflows', default: 'default' }
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
          value: { type: 'string', description: 'Value to fill' },
          sessionId: { type: 'string', description: 'Session ID for stateful workflows', default: 'default' }
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
          timeout: { type: 'number', description: 'Timeout in ms', default: 30000 },
          sessionId: { type: 'string', description: 'Session ID for stateful workflows', default: 'default' }
        },
        required: ['selector']
      }
    },
    {
      name: 'get_page_content',
      description: 'Get page text content',
      inputSchema: { 
        type: 'object', 
        properties: {
          sessionId: { type: 'string', description: 'Session ID for stateful workflows', default: 'default' }
        }, 
        required: [] 
      }
    },
    {
      name: 'capture_screenshot',
      description: 'Capture screenshot as base64',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Optional filename', default: null },
          sessionId: { type: 'string', description: 'Session ID for stateful workflows', default: 'default' }
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
          url: { type: 'string', description: 'HouseSigma trends URL' },
          sessionId: { type: 'string', description: 'Session ID for stateful workflows', default: 'default' }
        },
        required: ['url']
      }
    },
    {
      name: 'onland_property_search',
      description: 'Complete OnLand property search workflow: navigate, search, extract results',
      inputSchema: {
        type: 'object',
        properties: {
          searchQuery: { type: 'string', description: 'Property search query (address, city, etc.)' },
          propertyType: { type: 'string', description: 'Property type filter', default: 'all' },
          takeScreenshot: { type: 'boolean', description: 'Capture screenshot of results', default: true },
          maxResults: { type: 'number', description: 'Maximum results to extract', default: 10 }
        },
        required: ['searchQuery']
      }
    },
  ]
};

// Tool handlers with enhanced session isolation
server.setRequestHandler(ListToolsRequestSchema, async () => toolsList);

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  console.log(`Executing tool: ${name}`);
  
  // Use enhanced session ID extraction
  const sessionId = getSessionId(args, name);
  
  // Special case: cleanup tool
  if (name === 'cleanup_resources') {
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
        console.log(`Navigating to: ${args.url} (session: ${sessionId})`);
        await page.goto(args.url, { waitUntil: 'networkidle', timeout: 30000 });
        // Wait for dynamic content - same as original
        await page.waitForTimeout(3000);
        return {
          content: [{
            type: 'text',
            text: `Successfully navigated to ${args.url} and waited for content to load (session: ${sessionId})`
          }]
        };
        
      case 'wait_for_content':
        const waitSeconds = args.seconds || 3;
        await page.waitForTimeout(waitSeconds * 1000);
        return {
          content: [{
            type: 'text',
            text: `Waited ${waitSeconds} seconds for content (session: ${sessionId})`
          }]
        };
        
      case 'fill_form':
        console.log(`Filling form ${args.selector} in session: ${sessionId}`);
        await page.fill(args.selector, args.value);
        return {
          content: [{
            type: 'text',
            text: `Filled ${args.selector} with: ${args.value} (session: ${sessionId})`
          }]
        };
        
      case 'click_element':
        const timeout = args.timeout || 60000; // Restored original 60s timeout
        console.log(`Clicking element ${args.selector} in session: ${sessionId}`);
        // Wait for element to be visible and clickable before attempting click
        await page.waitForSelector(args.selector, { timeout: timeout, state: 'visible' });
        await page.click(args.selector, { timeout });
        return {
          content: [{
            type: 'text',
            text: `Successfully clicked element: ${args.selector} (session: ${sessionId})`
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
    console.error(`Tool execution failed for ${name} in session ${sessionId}:`, error);
    throw new Error(`Tool execution failed: ${error.message}`);
  }
  // No cleanup - sessions persist for multi-step workflows
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
    const sessionInfo = {};
    for (const [sessionId, session] of sessions.entries()) {
      sessionInfo[sessionId] = { lastUsed: new Date(session.lastUsed).toISOString() };
    }
    
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
      sessionDetails: sessionInfo,
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
              // Call the tool handler directly - same as CallToolRequestSchema
              const { name, arguments: args } = request.params;
              console.log(`Executing tool via HTTP: ${name}`);
              
              // Use enhanced session ID extraction
              const sessionId = getSessionId(args, name);
              
              // Special case: cleanup tool
              if (name === 'cleanup_resources') {
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
                response = {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: {
                    content: [{
                      type: 'text',
                      text: 'Browser resources cleaned up successfully'
                    }]
                  }
                };
              } else {
                // Use session-based context
                const { context, page } = await getSessionContext(sessionId);
                
                let toolResult;
                
                try {
                  switch (name) {
                    case 'navigate_to_url':
                      console.log(`Navigating to: ${args.url} (session: ${sessionId})`);
                      await page.goto(args.url, { waitUntil: 'networkidle', timeout: 30000 });
                      await page.waitForTimeout(2000);
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: `Successfully navigated to ${args.url} (session: ${sessionId})`
                        }]
                      };
                      break;
                      
                    case 'wait_for_content':
                      const waitSeconds = args.seconds || 3;
                      await page.waitForTimeout(waitSeconds * 1000);
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: `Waited ${waitSeconds} seconds for content (session: ${sessionId})`
                        }]
                      };
                      break;
                      
                    case 'fill_form':
                      console.log(`Filling form ${args.selector} in session: ${sessionId}`);
                      await page.fill(args.selector, args.value);
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: `Filled ${args.selector} with: ${args.value} (session: ${sessionId})`
                        }]
                      };
                      break;
                      
                    case 'click_element':
                      const timeout = args.timeout || 30000;
                      console.log(`Clicking element ${args.selector} in session: ${sessionId}`);
                      await page.waitForSelector(args.selector, { timeout, state: 'visible' });
                      await page.click(args.selector, { timeout });
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: `Clicked element: ${args.selector} (session: ${sessionId})`
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
                      
                    default:
                      throw new Error(`Unknown tool: ${name}`);
                  }
                  
                  response = {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: toolResult
                  };
                  
                } catch (toolError) {
                  console.error(`Tool execution failed for ${name} in session ${sessionId}:`, toolError);
                  response = {
                    jsonrpc: '2.0',
                    id: request.id,
                    error: {
                      code: -32603,
                      message: `Tool execution failed: ${toolError.message}`
                    }
                  };
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
          
          // Handle case where request parsing failed
          let requestId = null;
          try {
            const parsedRequest = JSON.parse(body);
            requestId = parsedRequest?.id || null;
          } catch (parseError) {
            // If we can't parse the request, leave requestId as null
          }
          
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
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

// Enhanced periodic session monitoring
setInterval(() => {
  console.log(`Active sessions: ${sessions.size}`);
  for (const [sessionId, session] of sessions.entries()) {
    const age = Date.now() - session.lastUsed;
    const timeout = SESSION_TIMEOUTS[sessionId] || SESSION_TIMEOUTS['default'];
    console.log(`  ${sessionId}: last used ${Math.round(age/1000)}s ago (timeout: ${timeout/1000}s)`);
  }
}, 5 * 60 * 1000); // Every 5 minutes

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
  console.log(`Enhanced Playwright MCP Server running on port ${PORT}`);
  console.log(`Health check: /health`);
  console.log(`Manual cleanup: POST /cleanup`);
  console.log('Enhanced session isolation for concurrent workflows');
  console.log('Session timeout configurations:', SESSION_TIMEOUTS);
});
