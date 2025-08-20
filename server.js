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
  'fnf_canada_workflow': 10 * 60 * 1000,    // 10 minutes - FNF Canada workflow
  'default': 5 * 60 * 1000                   // 5 minutes - general fallback
};
const MAX_SESSIONS = 5; // Increased from 3 to handle concurrent workflows

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

// Enhanced session ID extraction with WORKFLOW CONTINUITY
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
  
  // CRITICAL FIX: For non-navigation tools, try to reuse domain-specific sessions first
  if (sessions.size > 0) {
    // Look for existing domain-specific sessions first
    const domainSessions = Array.from(sessions.keys()).filter(id => id.startsWith('auto_'));
    
    if (domainSessions.length === 1) {
      // If there's exactly one domain session, use it (likely the current workflow)
      const sessionId = domainSessions[0];
      console.log(`Reusing domain-specific session for ${toolName}: ${sessionId}`);
      return sessionId;
    } else if (domainSessions.length > 1) {
      // Multiple domain sessions - use the most recently used domain session
      let mostRecentSession = null;
      let mostRecentTime = 0;
      
      for (const sessionId of domainSessions) {
        const session = sessions.get(sessionId);
        if (session && session.lastUsed > mostRecentTime) {
          mostRecentTime = session.lastUsed;
          mostRecentSession = sessionId;
        }
      }
      
      if (mostRecentSession) {
        console.log(`Using most recent domain session for ${toolName}: ${mostRecentSession}`);
        return mostRecentSession;
      }
    }
    
    // Fallback: if only default sessions exist, use the most recent one
    if (sessions.size === 1) {
      const singleSessionId = Array.from(sessions.keys())[0];
      console.log(`Using single existing session: ${singleSessionId}`);
      return singleSessionId;
    }
  }
  
  // Last resort: create new default session
  console.log(`Creating new default session for ${toolName}`);
  return 'default_' + Date.now();
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

// FIXED: Smarter session limit enforcement that preserves workflow continuity
async function enforceSessionLimits() {
  if (sessions.size >= MAX_SESSIONS) {
    // Instead of just closing oldest, prioritize keeping domain-specific sessions
    const sessionEntries = Array.from(sessions.entries());
    
    // Separate domain sessions from default sessions
    const domainSessions = sessionEntries.filter(([id]) => id.startsWith('auto_'));
    const defaultSessions = sessionEntries.filter(([id]) => id.startsWith('default_'));
    
    if (defaultSessions.length > 0) {
      // Close oldest default session first (these are less important)
      const oldestDefault = defaultSessions.sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      const [sessionId, session] = oldestDefault;
      
      console.log(`Enforcing limits: closing oldest default session: ${sessionId}`);
      try {
        await session.context.close();
        sessions.delete(sessionId);
        return;
      } catch (e) {
        console.warn(`Error closing default session ${sessionId}:`, e.message);
        sessions.delete(sessionId);
        return;
      }
    }
    
    // Only if no default sessions exist, close oldest domain session
    if (domainSessions.length > 0) {
      const oldestDomain = domainSessions.sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      const [sessionId, session] = oldestDomain;
      
      console.log(`Enforcing limits: closing oldest domain session: ${sessionId}`);
      try {
        await session.context.close();
        sessions.delete(sessionId);
      } catch (e) {
        console.warn(`Error closing domain session ${sessionId}:`, e.message);
        sessions.delete(sessionId);
      }
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
  } else if (sessionId.includes('fnf') || sessionId.includes('appraiserconnect')) {
    return {
      ...baseConfig,
      // FNF Canada optimizations
      viewport: { width: 1200, height: 800 },
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
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
      } else if (url.includes('fnfcanada.ca') || url.includes('appraiserconnect.fnf.ca')) {
        await page.waitForTimeout(2000); // FNF Canada is reasonably fast
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

// NEW TOOL FUNCTIONS

// Wait for selector with timeout
async function waitForSelector(page, selector, options = {}) {
  try {
    const timeout = options.timeout || 30000;
    const state = options.state || 'visible';
    
    console.log(`Waiting for selector: ${selector} (state: ${state}, timeout: ${timeout}ms)`);
    
    await page.waitForSelector(selector, { 
      timeout,
      state: state 
    });
    
    return {
      success: true,
      selector,
      found: true,
      timeout: timeout,
      state: state
    };
  } catch (error) {
    return {
      success: false,
      selector,
      found: false,
      error: error.message,
      timeout: options.timeout || 30000
    };
  }
}

// Check element existence/visibility
async function checkElementExists(page, selector, options = {}) {
  try {
    const checkVisible = options.checkVisible || false;
    
    if (checkVisible) {
      const isVisible = await page.isVisible(selector);
      return {
        exists: true,
        visible: isVisible,
        selector,
        checkType: 'visibility'
      };
    } else {
      const element = await page.$(selector);
      const exists = element !== null;
      
      let visible = false;
      if (exists) {
        visible = await page.isVisible(selector);
      }
      
      return {
        exists,
        visible,
        selector,
        checkType: 'existence'
      };
    }
  } catch (error) {
    return {
      exists: false,
      visible: false,
      selector,
      error: error.message,
      checkType: options.checkVisible ? 'visibility' : 'existence'
    };
  }
}

// Get element text or attributes
async function getElementText(page, selector, options = {}) {
  try {
    const attribute = options.attribute;
    
    if (attribute) {
      const value = await page.getAttribute(selector, attribute);
      return {
        success: true,
        selector,
        attribute,
        value: value || '',
        type: 'attribute'
      };
    } else {
      const text = await page.textContent(selector);
      return {
        success: true,
        selector,
        text: text || '',
        type: 'text'
      };
    }
  } catch (error) {
    return {
      success: false,
      selector,
      error: error.message,
      type: options.attribute ? 'attribute' : 'text'
    };
  }
}

// Extract table data
async function extractTableData(page, tableSelector, options = {}) {
  try {
    const includeHeaders = options.includeHeaders !== false; // Default to true
    
    const tableData = await page.evaluate((selector, includeHeaders) => {
      const table = document.querySelector(selector);
      if (!table) {
        throw new Error(`Table not found with selector: ${selector}`);
      }
      
      const rows = Array.from(table.querySelectorAll('tr'));
      if (rows.length === 0) {
        return { headers: [], data: [], rowCount: 0 };
      }
      
      let headers = [];
      let dataRows = rows;
      
      // Try to detect headers
      const firstRow = rows[0];
      const hasThElements = firstRow.querySelectorAll('th').length > 0;
      const hasTheadParent = firstRow.closest('thead') !== null;
      
      if (hasThElements || hasTheadParent) {
        // First row contains headers
        headers = Array.from(firstRow.querySelectorAll('th, td')).map(cell => 
          cell.textContent.trim()
        );
        dataRows = rows.slice(1);
      } else if (includeHeaders && rows.length > 1) {
        // Assume first row is headers even if no th elements
        headers = Array.from(firstRow.querySelectorAll('td')).map(cell => 
          cell.textContent.trim()
        );
        dataRows = rows.slice(1);
      }
      
      // Extract data rows
      const data = dataRows.map(row => {
        return Array.from(row.querySelectorAll('td')).map(cell => 
          cell.textContent.trim()
        );
      }).filter(row => row.length > 0); // Filter out empty rows
      
      return {
        headers,
        data,
        rowCount: data.length,
        columnCount: headers.length || (data[0]?.length || 0)
      };
    }, tableSelector, includeHeaders);
    
    return {
      success: true,
      tableSelector,
      ...tableData
    };
  } catch (error) {
    return {
      success: false,
      tableSelector,
      error: error.message,
      headers: [],
      data: [],
      rowCount: 0
    };
  }
}

// View screenshot function
async function viewScreenshot(base64Data, filename = 'screenshot.png') {
  try {
    console.log('viewScreenshot called with:', {
      dataType: typeof base64Data,
      dataLength: base64Data ? base64Data.length : 0,
      filename: filename
    });

    // Handle different input formats
    let cleanBase64 = base64Data;
    
    // If it's a JSON string, try to parse it
    if (typeof base64Data === 'string' && base64Data.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(base64Data);
        cleanBase64 = parsed.base64 || parsed.base64Data || base64Data;
        console.log('Parsed JSON input, extracted base64 length:', cleanBase64.length);
      } catch (parseError) {
        console.log('Failed to parse as JSON, treating as raw base64');
        cleanBase64 = base64Data;
      }
    }

    // Validate base64 data
    if (!cleanBase64 || typeof cleanBase64 !== 'string') {
      throw new Error('Invalid base64 data provided');
    }

    // Clean base64 data (remove data URL prefix if present)
    if (cleanBase64.startsWith('data:image/')) {
      cleanBase64 = cleanBase64.split(',')[1];
      console.log('Removed data URL prefix');
    }

    // Validate it's proper base64
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(cleanBase64)) {
      throw new Error('Invalid base64 format');
    }

    // Calculate image size
    const binaryLength = Math.ceil(cleanBase64.length * 0.75);
    const sizeKB = Math.round(binaryLength / 1024);

    // Create data URL for immediate viewing
    const dataUrl = `data:image/png;base64,${cleanBase64}`;

    console.log('Successfully processed screenshot:', {
      originalLength: base64Data.length,
      cleanLength: cleanBase64.length,
      sizeKB: sizeKB
    });

    return {
      success: true,
      filename: filename,
      dataUrl: dataUrl,
      base64: cleanBase64,
      sizeKB: sizeKB,
      viewInstructions: "Copy the dataUrl and paste into browser address bar to view",
      timestamp: new Date().toISOString(),
      // For N8N binary data format
      binaryData: {
        data: cleanBase64,
        mimeType: 'image/png',
        fileName: filename,
        fileExtension: 'png'
      }
    };
  } catch (error) {
    console.error('viewScreenshot error:', error);
    return {
      success: false,
      error: `Screenshot viewing failed: ${error.message}`,
      filename: filename,
      timestamp: new Date().toISOString(),
      debugInfo: {
        inputType: typeof base64Data,
        inputLength: base64Data ? base64Data.length : 0,
        inputSample: base64Data ? base64Data.substring(0, 100) : 'null'
      }
    };
  }
}
async function getCookies(page, domain = null) {
  try {
    const context = page.context();
    const allCookies = await context.cookies();
    
    let filteredCookies = allCookies;
    if (domain) {
      filteredCookies = allCookies.filter(cookie => 
        cookie.domain.includes(domain) || domain.includes(cookie.domain)
      );
    }
    
    // Format cookies for easy use in HTTP requests
    const cookieString = filteredCookies
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
    
    return {
      success: true,
      domain: domain || 'all',
      cookieCount: filteredCookies.length,
      cookieString,
      cookies: filteredCookies,
      url: page.url()
    };
  } catch (error) {
    return {
      success: false,
      domain: domain || 'all',
      error: error.message,
      cookieCount: 0,
      cookieString: '',
      cookies: []
    };
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
      name: 'wait_for_selector',
      description: 'Wait for a specific element to appear',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for' },
          timeout: { type: 'number', description: 'Timeout in ms (default: 30000)', default: 30000 },
          state: { type: 'string', description: 'Element state to wait for (visible, attached, detached, hidden)', default: 'visible' },
          sessionId: { type: 'string', description: 'Session ID for stateful workflows', default: 'default' }
        },
        required: ['selector']
      }
    },
    {
      name: 'check_element_exists',
      description: 'Check if element exists or is visible',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector' },
          checkVisible: { type: 'boolean', description: 'Check visibility instead of existence', default: false },
          sessionId: { type: 'string', description: 'Session ID for stateful workflows', default: 'default' }
        },
        required: ['selector']
      }
    },
    {
      name: 'get_element_text',
      description: 'Extract text content or attributes from specific elements',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector' },
          attribute: { type: 'string', description: 'Optional: get attribute value instead of text' },
          sessionId: { type: 'string', description: 'Session ID for stateful workflows', default: 'default' }
        },
        required: ['selector']
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
      name: 'get_page_html',
      description: 'Get full HTML content of the current page',
      inputSchema: { 
        type: 'object', 
        properties: {
          sessionId: { type: 'string', description: 'Session ID for stateful workflows', default: 'default' }
        }, 
        required: [] 
      }
    },
    {
      name: 'extract_table_data',
      description: 'Extract data from HTML tables',
      inputSchema: {
        type: 'object',
        properties: {
          tableSelector: { type: 'string', description: 'CSS selector for table' },
          includeHeaders: { type: 'boolean', description: 'Include header row', default: true },
          sessionId: { type: 'string', description: 'Session ID for stateful workflows', default: 'default' }
        },
        required: ['tableSelector']
      }
    },
    {
      name: 'get_cookies',
      description: 'Extract browser cookies for session transfer',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Optional: filter by domain' },
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
      name: 'view_screenshot',
      description: 'Display base64 screenshot as viewable image data',
      inputSchema: {
        type: 'object',
        properties: {
          base64Data: { type: 'string', description: 'Base64 screenshot data from capture_screenshot' },
          filename: { type: 'string', description: 'Optional filename for the image', default: 'screenshot.png' }
        },
        required: ['base64Data']
      }
    }
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

      case 'wait_for_selector':
        const selectorResult = await waitForSelector(page, args.selector, {
          timeout: args.timeout,
          state: args.state
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(selectorResult, null, 2)
          }]
        };

      case 'check_element_exists':
        const existsResult = await checkElementExists(page, args.selector, {
          checkVisible: args.checkVisible
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(existsResult, null, 2)
          }]
        };

      case 'get_element_text':
        const textResult = await getElementText(page, args.selector, {
          attribute: args.attribute
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(textResult, null, 2)
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

      case 'get_page_html':
        const html = await page.content();
        return {
          content: [{
            type: 'text',
            text: html || 'No HTML content found'
          }]
        };

      case 'extract_table_data':
        const tableResult = await extractTableData(page, args.tableSelector, {
          includeHeaders: args.includeHeaders
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(tableResult, null, 2)
          }]
        };

      case 'get_cookies':
        const cookiesResult = await getCookies(page, args.domain);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(cookiesResult, null, 2)
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

      case 'view_screenshot':
        const viewResult = await viewScreenshot(args.base64Data, args.filename);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(viewResult, null, 2)
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

                    case 'wait_for_selector':
                      const selectorResult = await waitForSelector(page, args.selector, {
                        timeout: args.timeout,
                        state: args.state
                      });
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: JSON.stringify(selectorResult, null, 2)
                        }]
                      };
                      break;

                    case 'check_element_exists':
                      const existsResult = await checkElementExists(page, args.selector, {
                        checkVisible: args.checkVisible
                      });
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: JSON.stringify(existsResult, null, 2)
                        }]
                      };
                      break;

                    case 'get_element_text':
                      const textResult = await getElementText(page, args.selector, {
                        attribute: args.attribute
                      });
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: JSON.stringify(textResult, null, 2)
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
                      
                    case 'get_page_html':
                      const html = await page.content();
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: html || 'No HTML content found'
                        }]
                      };
                      break;

                    case 'extract_table_data':
                      const tableResult = await extractTableData(page, args.tableSelector, {
                        includeHeaders: args.includeHeaders
                      });
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: JSON.stringify(tableResult, null, 2)
                        }]
                      };
                      break;

                    case 'get_cookies':
                      const cookiesResult = await getCookies(page, args.domain);
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: JSON.stringify(cookiesResult, null, 2)
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
                      
                    case 'view_screenshot':
                      const viewResult = await viewScreenshot(args.base64Data, args.filename);
                      toolResult = {
                        content: [{
                          type: 'text',
                          text: JSON.stringify(viewResult, null, 2)
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
  console.log(`Active sessions: ${sessions.size}/${MAX_SESSIONS}`);
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
  console.log('Enhanced with new tools for better workflow automation');
  console.log('Session timeout configurations:', SESSION_TIMEOUTS);
  console.log(`Maximum concurrent sessions: ${MAX_SESSIONS}`);
  console.log('New tools added: wait_for_selector, check_element_exists, get_element_text, extract_table_data, get_cookies');
  console.log('Removed: onland_property_search');
});
