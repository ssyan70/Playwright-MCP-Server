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

// Extract map data function
async function extractMapData(page, address = '') {
  try {
    const mapData = await page.evaluate((searchAddress) => {
      const results = {
        address: searchAddress,
        timestamp: new Date().toISOString(),
        communities: [],
        municipalities: [],
        mapLabels: [],
        coordinates: null
      };

      // Try to get all text elements that might contain community names
      const allTextElements = Array.from(document.querySelectorAll('*')).filter(el => {
        const text = el.textContent || '';
        const style = window.getComputedStyle(el);
        // Look for elements that might be map labels
        return text.trim().length > 0 && 
               text.trim().length < 50 && 
               (style.position === 'absolute' || style.position === 'fixed') &&
               !text.includes('©') && 
               !text.includes('Google') &&
               !text.includes('Terms') &&
               !text.includes('Report') &&
               !text.includes('Keyboard') &&
               !text.includes('Map Data');
      });

      // Extract text that might be community names
      allTextElements.forEach(el => {
        const text = el.textContent.trim();
        if (text && text.length > 2 && text.length < 30) {
          results.mapLabels.push({
            text: text,
            className: el.className,
            tagName: el.tagName,
            position: {
              left: el.offsetLeft,
              top: el.offsetTop
            }
          });
        }
      });

      // Look for Google Maps specific data
      try {
        // Try to access Google Maps data if available
        if (window.google && window.google.maps) {
          console.log('Google Maps API detected');
        }

        // Look for any data attributes or hidden inputs with location info
        const inputs = document.querySelectorAll('input[type="hidden"], input[data-*]');
        inputs.forEach(input => {
          if (input.value && (input.value.includes('community') || input.value.includes('municipality'))) {
            results.communities.push(input.value);
          }
        });

        // Check for any div elements with aria-labels that might contain location info
        const ariaElements = document.querySelectorAll('[aria-label*="community"], [aria-label*="Community"], [aria-label*="municipality"], [aria-label*="Municipality"]');
        ariaElements.forEach(el => {
          if (el.getAttribute('aria-label')) {
            results.communities.push(el.getAttribute('aria-label'));
          }
        });

      } catch (e) {
        console.log('Error accessing Google Maps data:', e);
      }

      return results;
    }, address);

    return {
      success: true,
      data: mapData,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    return {
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}
async function extractHouseSigmaChartData(page, url) {
  const chartApiData = [];
  
  // Set up response monitoring for chart API data
  page.on('response', async (response) => {
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
  });
  
  try {
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
  }
}

// Define tools list response (updated with screenshot tool)
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
      name: 'extract_map_data',
      description: 'Extract community and location data from the Google Maps interface',
      inputSchema: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'The address that was searched for',
            default: ''
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
  
  try {
    const currentPage = await ensureBrowser();
    
    switch (name) {
      case 'navigate_to_url':
        await currentPage.goto(args.url, { waitUntil: 'networkidle' });
        // Wait for dynamic content to load
        await currentPage.waitForTimeout(3000);
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
        await currentPage.waitForTimeout(waitSeconds * 1000);
        return {
          content: [
            {
              type: 'text',
              text: `Waited ${waitSeconds} seconds for content to load`
            }
          ]
        };
        
      case 'fill_form':
        await currentPage.fill(args.selector, args.value);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully filled form field ${args.selector} with value: ${args.value}`
            }
          ]
        };
        
      case 'click_element':
        await currentPage.click(args.selector);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully clicked element: ${args.selector}`
            }
          ]
        };
        
      case 'get_page_content':
        const content = await currentPage.textContent('body');
        return {
          content: [
            {
              type: 'text',
              text: content || 'No content found'
            }
          ]
        };

      case 'capture_screenshot':
        const screenshotResult = await captureScreenshot(currentPage, args.filename);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(screenshotResult, null, 2)
            }
          ]
        };

      case 'get_screenshot_url':
        const screenshotUrlResult = await captureScreenshot(currentPage, args.filename);
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


      case 'extract_map_data':
        const mapDataResult = await extractMapData(currentPage, args.address);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(mapDataResult, null, 2)
            }
          ]
      case 'extract_map_data':
        const mapDataResult = await extractMapData(currentPage, args.address);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(mapDataResult, null, 2)
            }
          ]
        };

      case 'extract_housesigma_chart':
        const chartResult = await extractHouseSigmaChartData(currentPage, args.url);
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
});

// Helper functions to handle MCP requests directly
async function handleToolsList() {
  return toolsList;
}

async function handleToolsCall(request) {
  const { name, arguments: args } = request.params;
  
  try {
    const currentPage = await ensureBrowser();
    
    switch (name) {
      case 'navigate_to_url':
        await currentPage.goto(args.url, { waitUntil: 'networkidle' });
        // Wait for dynamic content to load
        await currentPage.waitForTimeout(3000);
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
        await currentPage.waitForTimeout(waitDuration * 1000);
        return {
          content: [
            {
              type: 'text',
              text: `Waited ${waitDuration} seconds for content to load`
            }
          ]
        };
        
      case 'fill_form':
        await currentPage.fill(args.selector, args.value);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully filled form field ${args.selector} with value: ${args.value}`
            }
          ]
        };
        
      case 'click_element':
        await currentPage.click(args.selector);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully clicked element: ${args.selector}`
            }
          ]
        };
        
      case 'get_page_content':
        const content = await currentPage.textContent('body');
        return {
          content: [
            {
              type: 'text',
              text: content || 'No content found'
            }
          ]
        };

      case 'capture_screenshot':
        const screenshotResult = await captureScreenshot(currentPage, args.filename);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(screenshotResult, null, 2)
            }
          ]
        };

      case 'get_screenshot_url':
        const screenshotUrlResult = await captureScreenshot(currentPage, args.filename);
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
          ];
        }

      case 'extract_housesigma_chart':
        const chartResult = await extractHouseSigmaChartData(currentPage, args.url);
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
      tools: ['navigate_to_url', 'wait_for_content', 'fill_form', 'click_element', 'get_page_content', 'capture_screenshot', 'get_screenshot_url', 'extract_map_data', 'extract_housesigma_chart'],
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
        let request; // Declare request in the correct scope
        try {
          console.log('Received MCP Streamable request:', body);
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
              res.end(); // No response body for notifications
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
            console.log('Sent MCP Streamable response:', JSON.stringify(response));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON-RPC request' }));
          }
        } catch (error) {
          console.error('Error processing MCP Streamable request:', error);
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
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`Playwright MCP Server running on port ${PORT}`);
  console.log(`HTTP Streamable endpoint: https://playwright-mcp-server.onrender.com/mcp`);
  console.log(`Legacy SSE endpoint: https://playwright-mcp-server.onrender.com/mcp (GET)`);
  console.log(`Health check endpoint: https://playwright-mcp-server.onrender.com/health`);
  console.log('Available tools: navigate_to_url, wait_for_content, fill_form, click_element, get_page_content, capture_screenshot, get_screenshot_url, extract_map_data, extract_housesigma_chart');
});
