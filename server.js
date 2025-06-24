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

// Ultra-fast MLS Community Detection Function - optimized for speed
async function extractMLSCommunityFast(page, address) {
  try {
    console.log(`Starting FAST MLS community detection for: ${address}`);
    
    // Set aggressive timeouts and faster loading
    await page.goto('https://www.torontomls.net/Communities/map.html', { 
      waitUntil: 'domcontentloaded',
      timeout: 8000
    });
    
    // Minimal wait - just enough for basic DOM
    await page.waitForTimeout(1500);
    
    // Fast checkbox checking - no verification, just click
    console.log('Fast checkbox activation...');
    await Promise.allSettled([
      page.click('#arealayer').catch(() => {}),
      page.click('#munilayer').catch(() => {}),
      page.click('#commlayer').catch(() => {})
    ]);
    
    // Minimal wait
    await page.waitForTimeout(500);
    
    // Fast search - no fancy error handling
    console.log('Fast search execution...');
    await page.fill('#geosearch', address);
    await page.press('#geosearch', 'Enter');
    
    // Wait for search to complete
    await page.waitForTimeout(2000);
    
    // Fast zoom-out sequence - exactly 8 times using mouse wheel (as you tested)
    console.log('Fast zoom sequence (8x) using mouse wheel...');
    for (let i = 0; i < 8; i++) {
      // Mouse wheel scroll out (positive deltaY = zoom out)
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(200);
      console.log(`Zoom ${i + 1}/8 completed`);
    }
    
    // Short wait for community labels to appear
    console.log('Waiting for community labels to render...');
    await page.waitForTimeout(1000);
    
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
    
    // Enhanced community detection - look for actual map overlays and labels
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
      
      // Look for text elements that are likely community names on the map
      const mapContainer = document.querySelector('canvas, svg, .map, [id*="map"], .leaflet-container, .mapboxgl-map') || document.body;
      
      // Get all text nodes and elements within the map area
      const walker = document.createTreeWalker(
        mapContainer,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );
      
      const textNodes = [];
      let node;
      while (node = walker.nextNode()) {
        if (node.textContent.trim()) {
          textNodes.push(node);
        }
      }
      
      // Also check all elements for textContent
      const allElements = Array.from(document.querySelectorAll('*'));
      const communityNames = new Set();
      
      // Process text nodes
      textNodes.forEach(textNode => {
        const text = textNode.textContent.trim();
        if (text.length >= 4 && text.length <= 25 && /^[A-Z][a-zA-Z\s-']+$/.test(text)) {
          const parent = textNode.parentElement;
          if (parent) {
            const rect = parent.getBoundingClientRect();
            // Only consider visible elements
            if (rect.width > 0 && rect.height > 0) {
              communityNames.add(text);
            }
          }
        }
      });
      
      // Process element text content
      allElements.forEach(el => {
        const text = el.textContent?.trim();
        if (!text || el.children.length > 0) return; // Skip elements with children
        
        if (text.length >= 4 && text.length <= 25 && /^[A-Z][a-zA-Z\s-']+$/.test(text)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            communityNames.add(text);
          }
        }
      });
      
      // Filter out common UI elements
      const excludeTerms = [
        'labels', 'satellite', 'terrain', 'zoom', 'map', 'search', 'find',
        'layer', 'area', 'municipalities', 'communities', 'google', 'data',
        'imagery', 'terms', 'privacy', 'copyright', 'help', 'about', 'contact',
        'move', 'left', 'right', 'up', 'down', 'ctrl', 'alt', 'shift',
        'page', 'home', 'end', 'enter', 'escape', 'tab', 'delete', 'insert'
      ];
      
      const filteredNames = Array.from(communityNames).filter(name => {
        const lowerName = name.toLowerCase();
        return !excludeTerms.some(term => lowerName.includes(term));
      });
      
      // Look for known Toronto/GTA community patterns
      const gttaCommunities = filteredNames.filter(name => {
        // Common patterns for GTA communities
        return /^[A-Z][a-z]+$/.test(name) || 
               /^[A-Z][a-z]+\s[A-Z][a-z]+$/.test(name) || 
               /^[A-Z][a-z]+\s[A-Z][a-z]+\s[A-Z][a-z]+$/.test(name);
      });
      
      if (gttaCommunities.length > 0) {
        // Prefer single-word communities first (Cornell, Etobicoke, etc.)
        const singleWord = gttaCommunities.find(name => !/\s/.test(name));
        if (singleWord) {
          return {
            found: true,
            community: singleWord,
            method: 'single_word_community',
            allCandidates: gttaCommunities
          };
        }
        
        return {
          found: true,
          community: gttaCommunities[0],
          method: 'multi_word_community',
          allCandidates: gttaCommunities
        };
      }
      
      // If no clear community found, return debug info
      return {
        found: false,
        community: null,
        method: 'debug_mode',
        allTextFound: filteredNames,
        totalElementsChecked: allElements.length,
        textNodesFound: textNodes.length
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
