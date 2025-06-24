const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const puppeteer = require('puppeteer');

let browser;
let currentPage;

// Initialize browser
async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: { width: 1280, height: 720 },
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    currentPage = await browser.newPage();
    await currentPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  }
}

// Navigation function
async function navigateToUrl(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    return {
      success: true,
      url: page.url(),
      title: await page.title(),
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      url: url,
      timestamp: new Date().toISOString()
    };
  }
}

// Wait function
async function waitForContent(page, seconds = 2) {
  await page.waitForTimeout(seconds * 1000);
  return {
    success: true,
    waited: `${seconds} seconds`,
    timestamp: new Date().toISOString()
  };
}

// Form filling function
async function fillForm(page, selector, value) {
  try {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector);
    await page.evaluate((sel) => {
      const element = document.querySelector(sel);
      if (element) element.value = '';
    }, selector);
    await page.type(selector, value);
    return {
      success: true,
      selector: selector,
      value: value,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      selector: selector,
      timestamp: new Date().toISOString()
    };
  }
}

// Click element function
async function clickElement(page, selector) {
  try {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector);
    await page.waitForTimeout(1000);
    return {
      success: true,
      selector: selector,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      selector: selector,
      timestamp: new Date().toISOString()
    };
  }
}

// Get page content function
async function getPageContent(page) {
  try {
    const content = await page.evaluate(() => document.body.innerText);
    return {
      success: true,
      content: content,
      url: page.url(),
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

// Screenshot function
async function captureScreenshot(page, filename = null) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const defaultFilename = `screenshot-${timestamp}.png`;
    const finalFilename = filename || defaultFilename;
    
    const screenshot = await page.screenshot({ 
      fullPage: true,
      type: 'png'
    });
    
    const base64 = screenshot.toString('base64');
    
    return {
      success: true,
      filename: finalFilename,
      base64: base64,
      url: page.url(),
      timestamp: new Date().toISOString(),
      size: screenshot.length
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      filename: filename,
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

// HouseSigma Chart Data Extraction Function
async function extractHouseSigmaChart(page) {
  try {
    const chartData = await page.evaluate(() => {
      const results = {
        charts: [],
        statistics: {},
        priceData: [],
        timeData: [],
        rawData: {}
      };

      // Look for Chart.js canvas elements
      const canvases = document.querySelectorAll('canvas');
      canvases.forEach((canvas, index) => {
        if (canvas.getContext) {
          results.charts.push({
            id: canvas.id || `canvas-${index}`,
            width: canvas.width,
            height: canvas.height,
            classes: canvas.className
          });
        }
      });

      // Look for Highcharts data
      if (window.Highcharts && window.Highcharts.charts) {
        window.Highcharts.charts.forEach((chart, index) => {
          if (chart && chart.series) {
            const chartInfo = {
              type: chart.options.chart.type,
              title: chart.options.title ? chart.options.title.text : '',
              series: []
            };
            
            chart.series.forEach(series => {
              if (series.data) {
                chartInfo.series.push({
                  name: series.name,
                  data: series.data.map(point => ({
                    x: point.x,
                    y: point.y,
                    category: point.category
                  }))
                });
              }
            });
            
            results.charts.push(chartInfo);
          }
        });
      }

      // Look for price information in text
      const priceRegex = /\$[\d,]+/g;
      const pageText = document.body.innerText;
      const prices = pageText.match(priceRegex) || [];
      results.priceData = prices;

      // Look for statistical data
      const statElements = document.querySelectorAll('[class*="stat"], [class*="price"], [class*="value"], [id*="stat"], [id*="price"]');
      statElements.forEach(el => {
        const text = el.textContent.trim();
        if (text && (text.includes('$') || text.includes('%') || /\d+/.test(text))) {
          results.statistics[el.className || el.id || 'unknown'] = text;
        }
      });

      return results;
    });

    return {
      success: true,
      data: chartData,
      url: page.url(),
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

// Tool execution handler
async function handleToolsCall(name, args) {
  await initBrowser();
  
  switch (name) {
    case 'navigate_to_url':
      return await navigateToUrl(currentPage, args.url);
      
    case 'wait_for_content':
      return await waitForContent(currentPage, args.seconds);
      
    case 'fill_form':
      return await fillForm(currentPage, args.selector, args.value);
      
    case 'click_element':
      return await clickElement(currentPage, args.selector);
      
    case 'get_page_content':
      return await getPageContent(currentPage);
      
    case 'capture_screenshot':
      return await captureScreenshot(currentPage, args.filename);
      
    case 'extract_map_data':
      return await extractMapData(currentPage, args.address);
      
    case 'extract_housesigma_chart':
      return await extractHouseSigmaChart(currentPage);
      
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  {
    name: 'playwright-web-automation',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler('initialize', async () => {
  console.log('Server initialized');
  await initBrowser();
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: ['navigate_to_url', 'wait_for_content', 'fill_form', 'click_element', 'get_page_content', 'capture_screenshot', 'extract_map_data', 'extract_housesigma_chart'],
    },
    serverInfo: {
      name: 'playwright-web-automation',
      version: '1.0.0'
    }
  };
});

server.setRequestHandler('tools/list', async () => {
  return {
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
        description: 'Wait for a specified number of seconds',
        inputSchema: {
          type: 'object',
          properties: {
            seconds: {
              type: 'number',
              description: 'Number of seconds to wait',
              default: 2
            }
          },
          required: []
        }
      },
      {
        name: 'fill_form',
        description: 'Fill a form field with specified value',
        inputSchema: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector for the form field'
            },
            value: {
              type: 'string',
              description: 'Value to enter in the field'
            }
          },
          required: ['selector', 'value']
        }
      },
      {
        name: 'click_element',
        description: 'Click on an element specified by CSS selector',
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
        description: 'Extract chart data and statistics from HouseSigma pages',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    ]
  };
});

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    const result = await handleToolsCall(name, args || {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
            tool: name,
            timestamp: new Date().toISOString()
          }, null, 2)
        }
      ],
      isError: true
    };
  }
});

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log('Playwright MCP Server running on stdio');
  console.log('Available tools: navigate_to_url, wait_for_content, fill_form, click_element, get_page_content, capture_screenshot, extract_map_data, extract_housesigma_chart');
}

if (require.main === module) {
  main().catch(console.error);
}
