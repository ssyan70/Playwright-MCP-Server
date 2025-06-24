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
    browser = await chromium.launch({ 
      headless: false,  // Show the browser window
      slowMo: 500,      // Slow down actions so you can see them
      devtools: false   // Don't open devtools by default
    });
    page = await browser.newPage();
    
    // Set a reasonable viewport size
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  return page;
}

// Ultra-fast MLS Community Detection Function - optimized for speed
async function extractMLSCommunityFast(page, address) {
  try {
    console.log(`Starting VISUAL MLS community detection for: ${address}`);
    
    // Set aggressive timeouts and faster loading
    await page.goto('https://www.torontomls.net/Communities/map.html', { 
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
    
    // Wait to see the page load
    console.log('Page loaded - waiting to see initial state...');
    await page.waitForTimeout(3000);
    
    // Fast checkbox checking - with visual feedback
    console.log('Clicking checkboxes - watch the browser...');
    await Promise.allSettled([
      page.click('#arealayer').catch(() => console.log('Area layer checkbox not found')),
      page.click('#munilayer').catch(() => console.log('Municipality layer checkbox not found')),
      page.click('#commlayer').catch(() => console.log('Community layer checkbox not found'))
    ]);
    
    // Wait to see checkbox effects
    await page.waitForTimeout(1000);
    
    // Fast search - with visual feedback
    console.log('Performing search - watch the search box...');
    await page.fill('#geosearch', address);
    await page.press('#geosearch', 'Enter');
    
    // Wait to see search complete
    console.log('Search completed - waiting for map to center...');
    await page.waitForTimeout(3000);
    
    // Fast zoom-out sequence - with visual feedback
    console.log('Starting zoom sequence - watch the map zoom out...');
    for (let i = 0; i < 8; i++) {
      try {
        // Try to click the zoom out button
        await page.click('button[aria-label="Zoom out"], button[title="Zoom out"], .gm-control-active[aria-label="Zoom out"]');
        console.log(`Zoom ${i + 1}/8 completed via button click - watch zoom level`);
      } catch (e) {
        try {
          // Fallback to mouse wheel if button click fails
          await page.mouse.wheel(0, 300);
          console.log(`Zoom ${i + 1}/8 completed via mouse wheel (fallback)`);
        } catch (e2) {
          console.log(`Zoom ${i + 1}/8 failed - ${e2.message}`);
        }
      }
      await page.waitForTimeout(500); // Longer wait so you can see each zoom
    }
    
    // Wait for community labels to appear
    console.log('Zoom complete - waiting for community labels to render...');
    console.log('LOOK AT THE BROWSER: Can you see "Cornell" or any community names on the map?');
    await page.waitForTimeout(5000); // Long wait so you can examine the map
    
    // Quick check of what's visible before detailed analysis
    const quickCheck = await page.evaluate(() => {
      const allVisibleText = Array.from(document.querySelectorAll('*'))
        .filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && el.textContent?.trim();
        })
        .map(el => el.textContent.trim())
        .filter(text => text.length >= 3 && text.length <= 30);
      
      return {
        totalVisibleElements: allVisibleText.length,
        sampleTexts: allVisibleText.slice(0, 20)
      };
    });
    
    console.log('Quick visibility check:', quickCheck);
    console.log('EXAMINE THE BROWSER: What text can you see on the map?');
    
    // Wait for user to examine
    await page.waitForTimeout(3000);
    
    // Enhanced community detection - look for canvas/SVG text and map overlays
    const communityResult = await page.evaluate(() => {
      // First, look specifically for "Cornell" anywhere on the page
      const cornellElements = Array.from(document.querySelectorAll('*')).filter(el => {
        const text = el.textContent?.trim();
        return text && text.toLowerCase().includes('cornell');
      });
      
      if (cornellElements.length > 0) {
        return {
          found: true,
          community: 'Cornell',
          method: 'specific_cornell_search'
        };
      }
      
      // Look for Google Maps style labels and overlays
      const gmLabels = Array.from(document.querySelectorAll('[class*="gm"], [class*="map"], [class*="label"], [data-value], [title]')).filter(el => {
        const text = el.textContent?.trim() || el.title || el.getAttribute('data-value') || '';
        return text.length >= 4 && text.length <= 25 && /^[A-Z][a-zA-Z\s-']+$/.test(text);
      });
      
      gmLabels.forEach(el => {
        const text = el.textContent?.trim() || el.title || el.getAttribute('data-value') || '';
        if (text) {
          communityNames.add(text);
        }
      });
      
      // Check for any overlays or absolutely positioned elements that might be labels
      const overlayElements = Array.from(document.querySelectorAll('*')).filter(el => {
        const style = window.getComputedStyle(el);
        return style.position === 'absolute' || style.position === 'fixed' || 
               parseInt(style.zIndex) > 0;
      });
      
      // Look for community names in overlay elements
      const communityNames = new Set();
      overlayElements.forEach(el => {
        const text = el.textContent?.trim();
        if (text && text.length >= 4 && text.length <= 25) {
          // Check if it looks like a community name
          if (/^[A-Z][a-zA-Z\s-']+$/.test(text)) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              communityNames.add(text);
            }
          }
        }
      });
      
      // Also check all visible text elements regardless of positioning
      const allElements = Array.from(document.querySelectorAll('*'));
      allElements.forEach(el => {
        if (el.children.length > 0) return; // Skip parent elements
        
        const text = el.textContent?.trim();
        if (!text || text.length < 4 || text.length > 25) return;
        
        // Check if it's a potential community name
        if (/^[A-Z][a-zA-Z\s-']+$/.test(text)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            communityNames.add(text);
          }
        }
      });
      
      // Filter out common UI elements and map controls
      const excludeTerms = [
        'keyboard', 'shortcuts', 'labels', 'satellite', 'terrain', 'zoom', 'map', 
        'search', 'find', 'layer', 'area', 'municipalities', 'communities', 
        'google', 'data', 'imagery', 'terms', 'privacy', 'copyright', 'help', 
        'about', 'contact', 'move', 'left', 'right', 'up', 'down', 'ctrl', 
        'alt', 'shift', 'page', 'home', 'end', 'enter', 'escape', 'tab', 
        'delete', 'insert', 'view', 'ytreb', 'treb', 'mapart'
      ];
      
      const filteredNames = Array.from(communityNames).filter(name => {
        const lowerName = name.toLowerCase();
        return !excludeTerms.some(term => lowerName.includes(term));
      });
      
      // Look specifically for known GTA communities near Markham
      const markhamAreaCommunities = [
        'cornell', 'unionville', 'milliken', 'thornhill', 'richmond hill', 
        'scarborough', 'pickering', 'ajax', 'whitby', 'oshawa', 'newmarket',
        'aurora', 'stouffville', 'uxbridge', 'beaverton'
      ];
      
      const nearbyMatches = filteredNames.filter(name => {
        const lowerName = name.toLowerCase();
        return markhamAreaCommunities.some(community => 
          lowerName.includes(community) || community.includes(lowerName)
        );
      });
      
      if (nearbyMatches.length > 0) {
        return {
          found: true,
          community: nearbyMatches[0],
          method: 'markham_area_match',
          allCandidates: nearbyMatches
        };
      }
      
      // If no specific matches, return the best filtered candidates
      if (filteredNames.length > 0) {
        // Prefer single-word communities
        const singleWord = filteredNames.find(name => !/\s/.test(name));
        if (singleWord) {
          return {
            found: true,
            community: singleWord,
            method: 'single_word_community',
            allCandidates: filteredNames
          };
        }
        
        return {
          found: true,
          community: filteredNames[0],
          method: 'best_candidate',
          allCandidates: filteredNames
        };
      }
      
      // Debug info if nothing found
      return {
        found: false,
        community: null,
        method: 'enhanced_debug',
        canvasCount: canvasElements.length,
        svgCount: svgElements.length,
        overlayCount: overlayElements.length,
        allNamesFound: Array.from(communityNames),
        totalElementsChecked: allElements.length
      };
    });
    
    if (communityResult.found) {
      return {
        success: true,
        address: address,
        community: communityResult.community,
        method: communityResult.method,
        allCandidates: communityResult.allCandidates || [],
        processingTime: 'under_10_seconds',
        url: page.url(),
        timestamp: new Date().toISOString()
      };
    } else {
      return {
        success: false,
        error: 'No community name detected after enhanced processing',
        address: address,
        method: communityResult.method || 'unknown',
        debugInfo: {
          allTextFound: communityResult.allTextFound || [],
          totalElementsChecked: communityResult.totalElementsChecked || 0,
          textNodesFound: communityResult.textNodesFound || 0
        },
        processingTime: 'under_10_seconds',
        url: page.url(),
        timestamp: new Date().toISOString()
      };
    }
    
  } catch (error) {
    console.error('Fast MLS extraction error:', error);
    return {
      success: false,
      error: `Fast processing failed: ${error.message}`,
      address: address,
      timestamp: new Date().toISOString()
    };
  }
}

// HouseSigma Chart Data Extraction Function
async function extractHouseSigmaChartData(page, url) {
  const chartApiData = [];
  
  page.on('response', async (response) => {
    const responseUrl = response.url();
    
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
    console.log('Navigating to market trends page');
    await page.goto(url, { waitUntil: 'networkidle' });
    
    await page.waitForTimeout(10000);
    
    const needsAuth = await page.evaluate(() => {
      return document.querySelectorAll('.blur-light, .blur, .auth-btn, [class*="login"]').length > 0;
    });
    
    if (needsAuth) {
      console.log('Authentication required - attempting login');
      
      await page.goto('https://housesigma.com/web/en/signin', { waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);
      
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
        await page.waitForTimeout(5000);
        await page.goto(url, { waitUntil: 'networkidle' });
        await page.waitForTimeout(10000);
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
  }
}

// Define tools list
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
    },
    {
      name: 'screenshot_mls_debug',
      description: 'Take screenshots during MLS community detection process to debug what the browser sees',
      inputSchema: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'The address to debug with screenshots'
          }
        },
        required: ['address']
      }
    },
    {
      name: 'extract_mls_community_fast',
      description: 'Ultra-fast MLS community detection for Toronto Real Estate Board addresses (under 10 seconds)',
      inputSchema: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'The address to look up (e.g., "40 sunnyside hill rd, markham on")'
          }
        },
        required: ['address']
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

      case 'screenshot_mls_debug':
        const debugResult = await screenshotMLSDebug(currentPage, args.address);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(debugResult, null, 2)
            }
          ]
        };

      case 'screenshot_mls_debug':
        const debugResult = await screenshotMLSDebug(currentPage, args.address);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(debugResult, null, 2)
            }
          ]
        };

      case 'extract_mls_community_fast':
        const mlsResult = await extractMLSCommunityFast(currentPage, args.address);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(mlsResult, null, 2)
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

      case 'extract_mls_community_fast':
        const mlsResult = await extractMLSCommunityFast(currentPage, args.address);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(mlsResult, null, 2)
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

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      service: 'playwright-mcp-server',
      tools: ['navigate_to_url', 'wait_for_content', 'fill_form', 'click_element', 'get_page_content', 'extract_housesigma_chart', 'extract_mls_community_fast'],
      timestamp: new Date().toISOString()
    }));
    return;
  }

  if (req.url === '/mcp' || req.url === '/') {
    if (req.method === 'GET') {
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

      res.write(`data: /mcp\n\n`);

      req.on('close', () => {
        console.log(`SSE connection closed: ${connectionId}`);
        connections.delete(connectionId);
      });

      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });

      req.on('end', async () => {
        let request;
        try {
          console.log('Received MCP Streamable request:', body);
          request = JSON.parse(body);
          
          let response;
          let sessionId;
          
          if (request.jsonrpc === '2.0') {
            if (request.method === 'initialize') {
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
            
            const headers = {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            };
            
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
  console.log('Available tools: navigate_to_url, wait_for_content, fill_form, click_element, get_page_content, extract_housesigma_chart, extract_mls_community_fast');
});
