// Now look for community boundaries and labels after 8 zoom-outs
    const communityInfo = await page.evaluate(() => {
      // Look for text that might be community names
      const allTextElements = Array.from(document.querySelectorAll('*')).filter(el => {
        const text = el.textContent?.trim();
        if (!text || text.length < 3 || text.length > 50) return false;
        
        // Skip common UI elements
        const skipTexts = [
          'search', 'find', 'map', 'zoom', 'layer', 'area', 'municipalities', 
          'communities', 'mapquest', 'google', 'copyright', '©', 'terms',
          'privacy', 'about', 'help', 'contact', 'home', 'back', 'forward',
          'end', 'page', 'up', 'down', 'terrain', 'satellite', 'labels'
        ];
        
        const lowerText = text.toLowerCase();
        if (skipTexts.some(skip => lowerText.includes(skip))) return false;
        
        // Look for proper nouns (community names typically start with capital letters)
        if (!/^[A-Z]/.test(text)) return false;
        
        // Skip elements with children (we want text-only elements)
        if (el.children.length > 0) return false;
        
        return true;
      });
      
      const potentialCommunities = allTextElements.map(el => ({
        text: el.textContent.trim(),
        tagName: el.tagName,
        className: el.className || '',
        id: el.id || '',
        parentTag: el.parentElement?.tagName || '',
        parentClass: el.parentElement?.className || ''
      }));
      
      // Look for dashed lines or boundaries (SVG paths, canvas, etc.)
      const svgPaths = Array.from(document.querySelectorAll('path')).filter(path => {
        const strokeDasharray = path.getAttribute('stroke-dasharray') || 
                               window.getComputedStyle(path).strokeDasharray;
        return strokeDasharray && strokeDasharray !== 'none';
      });
      
      // Look for any elements with dashed styling
      const dashedElements = Array.from(document.querySelectorAll('*')).filter(el => {
        const style = window.getComputedStyle(el);
        return (style.borderStyle && style.borderStyle.includes('dashed')) ||
               (style.strokeDasharray && style.strokeDasharray !== 'none');
      });
      
      return {
        possibleCommunityNames: potentialCommunities.slice(0, 30), // Increased limit
        dashedPaths: svgPaths.length,
        dashedElements: dashedElements.length,
        hasMap: !!document.querySelector('canvas, svg, .leaflet-container, .mapboxgl-map, [id*="map"]'),
        totalTextElements: allTextElements.length
      };
    });
    
    console.log('Community detection after 8 zoom-outs:', {
      possibleCommunities: communityInfo.possibleCommunityNames.length,
      dashedPaths: communityInfo.dashedPaths,
      dashedElements: communityInfo.dashedElements,
      hasMap: communityInfo.hasMap
    });
    
    // Enhanced community name detection
    if (communityInfo.possibleCommunityNames.length > 0) {
      // Filter for likely community names
      const likelyCommunities = communityInfo.possibleCommunityNames.filter(item => {
        const text = item.text;
        
        // Filter for likely community names
        const communityPatterns = [
          /^[A-Z][a-z]+$/, // Single word like "Cornell"
          /^[A-Z][a-z]+\s[A-Z][a-z]+$/, // Two words like "Don Mills"
          /^[A-Z][a-z]+\s[A-Z][a-z]+\s[A-Z][a-z]+$/, // Three words
          /^[A-Z][a-z]+[-'][A-Z][a-z]+$/ // Hyphenated or apostrophe
        ];
        
        // Exclude common UI/map elements
        const excludeWords = [
          'end', 'page', 'up', 'down', 'terrain', 'satellite', 'labels', 'map', 'zoom',
          'street', 'road', 'avenue', 'north', 'south', 'east', 'west', 'ctrl', 'alt',
          'shift', 'enter', 'escape', 'tab', 'home', 'delete', 'insert', 'print',
          'google', 'maps', 'data', 'imagery', 'terms', 'report', 'error', 'help'
        ];
        
        return /^[A-Z][a-zA-Z\s\-']+$/.test(text) && 
               text.length >= 3 && 
               text.length <= 30 &&
               !excludeWords.includes(text.toLowerCase()) &&
               communityPatterns.some(pattern => pattern.test(text));
      });
      
      if (likelyCommunities.length > 0) {
        console.log('Found likely community names:', likelyCommunities.map(c => c.text));
        
        // Return the most likely community name (first one that matches our criteria)
        const communityName = likelyCommunities[0].text;
        
        return {
          success: true,
          address: address,
          community: communityName,
          allPossibleCommunities: likelyCommunities,
          zoomLevel: 8, // Fixed at 8 zoom-outs
          boundaryElements: communityInfo.dashedPaths + communityInfo.dashedElements,
          searchPerformed: true,
          markersFound: mapMarkers.length,
          checkboxStatus: finalCheckedStatus,
          searchSuccessInfo: searchSuccess,
          url: page.url(),
          timestamp: new Date().toISOString()
        };
      }
    }import http from 'http';
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

// Toronto MLS Community Detection Function
async function extractMLSCommunity(page, address) {
  try {
    console.log(`Starting MLS community detection for address: ${address}`);
    
    // Navigate to the Toronto MLS Communities map with shorter timeout
    await page.goto('https://www.torontomls.net/Communities/map.html', { 
      waitUntil: 'domcontentloaded', // Faster than 'networkidle'
      timeout: 15000 // Reduced from 30000
    });
    
    // Shorter initial wait
    await page.waitForTimeout(3000);
    
    console.log('Page loaded, checking for required elements...');
    
    // Check the three specific checkboxes based on the DOM inspection
    const checkboxes = [
      { id: 'arealayer', name: 'area', label: 'Area' },
      { id: 'munilayer', name: 'muni', label: 'Municipalities' },
      { id: 'commlayer', name: 'comm', label: 'Communities' }
    ];
    
    console.log('Checking required checkboxes...');
    
    for (const checkbox of checkboxes) {
      try {
        // Try by ID first (most reliable)
        await page.check(`#${checkbox.id}`);
        console.log(`✓ Checked ${checkbox.label} checkbox (${checkbox.id})`);
      } catch (e) {
        try {
          // Fallback: try by name attribute
          await page.check(`input[name="${checkbox.name}"]`);
          console.log(`✓ Checked ${checkbox.label} checkbox by name (${checkbox.name})`);
        } catch (e2) {
          try {
            // Force click the checkbox if check() fails
            await page.click(`#${checkbox.id}`);
            console.log(`✓ Force-clicked ${checkbox.label} checkbox (${checkbox.id})`);
          } catch (e3) {
            console.log(`⚠️ Could not check ${checkbox.label} checkbox: ${e.message}`);
          }
        }
      }
    }
    
    // Extra wait for checkbox states to update (reduced)
    await page.waitForTimeout(1500);
    
    // Verify checkboxes are checked and retry if needed
    const checkedStatus = await page.evaluate(() => {
      return {
        area: document.getElementById('arealayer')?.checked || false,
        municipalities: document.getElementById('munilayer')?.checked || false,
        communities: document.getElementById('commlayer')?.checked || false
      };
    });
    
    console.log('Initial checkbox status:', checkedStatus);
    
    // Force-check any unchecked boxes
    if (!checkedStatus.communities) {
      try {
        await page.evaluate(() => {
          const commCheckbox = document.getElementById('commlayer');
          if (commCheckbox && !commCheckbox.checked) {
            commCheckbox.checked = true;
            commCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
            // Try to trigger the onclick function if it exists
            if (commCheckbox.onclick) {
              commCheckbox.onclick();
            }
          }
        });
        console.log('✓ Force-enabled Communities checkbox via JavaScript');
      } catch (e) {
        console.log('⚠️ Could not force-enable Communities checkbox');
      }
    }
    
    // Final verification
    const finalCheckedStatus = await page.evaluate(() => {
      return {
        area: document.getElementById('arealayer')?.checked || false,
        municipalities: document.getElementById('munilayer')?.checked || false,
        communities: document.getElementById('commlayer')?.checked || false
      };
    });
    
    console.log('Final checkbox status:', finalCheckedStatus);
    
    // Wait a moment for any dynamic updates (reduced)
    await page.waitForTimeout(1000);
    
    // Find the search input field using the exact ID from DOM inspection
    const searchInputId = 'geosearch';
    
    try {
      await page.fill(`#${searchInputId}`, address);
      console.log(`✓ Entered address "${address}" in search field`);
    } catch (e) {
      return {
        success: false,
        error: `Could not find or fill search input field #${searchInputId}: ${e.message}`,
        url: page.url()
      };
    }
    
    // Click the search button using the onclick attribute from DOM inspection
    try {
      // The button has onclick="LayerControl.search()">Search
      await page.click('button:has-text("Search")');
      console.log('✓ Clicked Search button');
    } catch (e) {
      try {
        // Fallback: trigger the search function directly
        await page.evaluate(() => {
          if (typeof LayerControl !== 'undefined' && LayerControl.search) {
            LayerControl.search();
          }
        });
        console.log('✓ Triggered search via LayerControl.search()');
      } catch (e2) {
        // Final fallback: press Enter
        await page.press(`#${searchInputId}`, 'Enter');
        console.log('✓ Pressed Enter on search field');
      }
    }
    
    // Wait for search results and verify the search worked (reduced timeout)
    await page.waitForTimeout(5000);
    
    // Check if search was successful by looking for map changes
    const searchSuccess = await page.evaluate(() => {
      // Look for any markers, pins, or location indicators
      const markers = document.querySelectorAll(
        '.marker, .pin, .map-marker, [class*="marker"], [class*="pin"], ' +
        'img[src*="marker"], img[src*="pin"], svg circle, svg path, ' +
        '.leaflet-marker-icon, .gm-marker, [title*="marker"], [title*="pin"]'
      );
      
      // Also check for any elements that might indicate a search result
      const searchResults = document.querySelectorAll(
        '[class*="result"], [class*="location"], [class*="address"], ' +
        '[id*="result"], [id*="location"], [id*="address"]'
      );
      
      return {
        markersFound: markers.length,
        searchResultsFound: searchResults.length,
        hasLocationChange: true // Assume location changed for now
      };
    });
    
    console.log('Search success check:', searchSuccess);
    
    if (searchSuccess.markersFound === 0 && searchSuccess.searchResultsFound === 0) {
      // Try alternative search methods
      console.log('No markers found, trying alternative search approach...');
      
      // Clear and re-enter the address
      await page.fill(`#${searchInputId}`, '');
      await page.waitForTimeout(1000);
      await page.fill(`#${searchInputId}`, address);
      await page.waitForTimeout(1000);
      
      // Try pressing Enter multiple times
      await page.press(`#${searchInputId}`, 'Enter');
      await page.waitForTimeout(2000);
      await page.press(`#${searchInputId}`, 'Enter');
      await page.waitForTimeout(3000);
    }
    
    // Look for map markers or pins
    const mapMarkers = await page.evaluate(() => {
      // Common selectors for map markers
      const markerSelectors = [
        '.marker',
        '.pin', 
        '.map-marker',
        '[class*="marker"]',
        '[class*="pin"]',
        'img[src*="marker"]',
        'img[src*="pin"]',
        'svg circle',
        'svg path',
        '.leaflet-marker-icon'
      ];
      
      let foundMarkers = [];
      markerSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        foundMarkers.push(...Array.from(elements).map(el => ({
          selector,
          className: el.className,
          src: el.src || '',
          style: el.style.cssText || '',
          tagName: el.tagName
        })));
      });
      
      return foundMarkers;
    });
    
    console.log('Found map markers:', mapMarkers);
    
    // Zoom out exactly 8 times to see community boundaries clearly
    console.log('Zooming out 8 times to reveal community boundaries...');
    
    for (let i = 0; i < 8; i++) {
      try {
        // Try keyboard minus key first (most reliable for maps)
        await page.keyboard.press('Minus');
        console.log(`✓ Zoom out attempt ${i + 1}/8`);
      } catch (e) {
        try {
          // Fallback: Mouse wheel scroll out
          await page.mouse.wheel(0, 300);
          console.log(`✓ Zoom out attempt ${i + 1}/8 (wheel)`);
        } catch (e2) {
          console.log(`⚠️ Zoom out attempt ${i + 1}/8 failed`);
        }
      }
      
      // Short wait between zoom operations
      await page.waitForTimeout(1000);
    }
    
    // Wait a bit longer after all zoom operations for boundaries to render
    console.log('Waiting for community boundaries to render...');
    await page.waitForTimeout(3000);
    
    // If we couldn't find community names through zooming, return detailed debug info
    return {
      success: false,
      error: 'Could not identify community name after zooming out',
      address: address,
      searchPerformed: true,
      markersFound: mapMarkers.length,
      zoomAttempts: zoomAttempts,
      checkboxStatus: checkedStatus,
      url: page.url(),
      timestamp: new Date().toISOString(),
      debugInfo: {
        checkboxStatus,
        mapMarkers,
        lastCommunityInfo: communityInfo
      }
    };
    
  } catch (error) {
    console.error('Error in MLS community extraction:', error);
    return {
      success: false,
      error: error.message,
      address: address,
      url: page?.url() || 'Unknown',
      timestamp: new Date().toISOString()
    };
  }
}

// HouseSigma Chart Data Extraction Function (existing)
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

// Define tools list response (updated with MLS tool)
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
      name: 'extract_mls_community',
      description: 'Extract MLS community name for a given address using Toronto Real Estate Board community map',
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

      case 'extract_mls_community':
        const mlsResult = await extractMLSCommunity(currentPage, args.address);
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

      case 'extract_mls_community':
        const mlsResult = await extractMLSCommunity(currentPage, args.address);
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
      tools: ['navigate_to_url', 'wait_for_content', 'fill_form', 'click_element', 'get_page_content', 'extract_housesigma_chart', 'extract_mls_community'],
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
  console.log('Available tools: navigate_to_url, wait_for_content, fill_form, click_element, get_page_content, extract_housesigma_chart, extract_mls_community');
});
