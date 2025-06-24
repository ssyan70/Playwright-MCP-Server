const mcp = require('@modelcontextprotocol/sdk/server');
const stdio = require('@modelcontextprotocol/sdk/server/stdio');
const puppeteer = require('puppeteer');

const { Server } = mcp;
const { StdioServerTransport } = stdio;

let browser;
let currentPage;

// Initialize browser
async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1280, height: 720 },
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    currentPage = await browser.newPage();
    await currentPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
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

// Tool execution handler
async function handleToolsCall(name, args) {
  await initBrowser();
  
  switch (name) {
    case 'navigate_to_url':
      try {
        await currentPage.goto(args.url, { waitUntil: 'networkidle0', timeout: 30000 });
        return {
          success: true,
          url: currentPage.url(),
          title: await currentPage.title(),
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          url: args.url,
          timestamp: new Date().toISOString()
        };
      }
      
    case 'wait_for_content':
      await currentPage.waitForTimeout((args.seconds || 2) * 1000);
      return {
        success: true,
        waited: `${args.seconds || 2} seconds`,
        timestamp: new Date().toISOString()
      };
      
    case 'fill_form':
      try {
        await currentPage.waitForSelector(args.selector, { timeout: 10000 });
        await currentPage.click(args.selector);
        await currentPage.evaluate((sel) => {
          const element = document.querySelector(sel);
          if (element) element.value = '';
        }, args.selector);
        await currentPage.type(args.selector, args.value);
        return {
          success: true,
          selector: args.selector,
          value: args.value,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          selector: args.selector,
          timestamp: new Date().toISOString()
        };
      }
      
    case 'click_element':
      try {
        await currentPage.waitForSelector(args.selector, { timeout: 10000 });
        await currentPage.click(args.selector);
        await currentPage.waitForTimeout(1000);
        return {
          success: true,
          selector: args.selector,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          selector: args.selector,
          timestamp: new Date().toISOString()
        };
      }
      
    case 'get_page_content':
      try {
        const content = await currentPage.evaluate(() => document.body.innerText);
        return {
          success: true,
          content: content,
          url: currentPage.url(),
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
      
    case 'capture_screenshot':
      return await captureScreenshot(currentPage, args.filename);

    case 'get_screenshot_url':
      const screenshotUrlResult = await captureScreenshot(currentPage, args.filename);
      if (screenshotUrlResult.success) {
        const dataUrl = `data:image/png;base64,${screenshotUrlResult.base64}`;
        return {
          ...screenshotUrlResult,
          dataUrl: dataUrl,
          viewInstructions: "Copy the dataUrl value and paste it into your browser address bar to view the image"
        };
      } else {
        return screenshotUrlResult;
      }
      
    case 'extract_map_data':
      try {
        const mapData = await currentPage.evaluate((searchAddress) => {
          const results = {
            address: searchAddress,
            timestamp: new Date().toISOString(),
            communities: [],
            municipalities: [],
            mapLabels: [],
            coordinates: null
          };

          const allTextElements = Array.from(document.querySelectorAll('*')).filter(el => {
            const text = el.textContent || '';
            const style = window.getComputedStyle(el);
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

          return results;
        }, args.address);

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
      
    case 'extract_housesigma_chart':
      return {
        success: false,
        error: 'HouseSigma chart extraction not implemented',
        timestamp: new Date().toISOString()
      };
      
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const mcpServer = new Server(
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

mcpServer.setRequestHandler('initialize', async () => {
  console.log('Server initialized');
  await initBrowser();
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: ['navigate_to_url', 'wait_for_content', 'fill_form', 'click_element', 'get_page_content', 'capture_screenshot', 'get_screenshot_url', 'extract_map_data', 'extract_housesigma_chart'],
    },
    serverInfo: {
      name: 'playwright-web-automation',
      version: '1.0.0'
    }
  };
});

mcpServer.setRequestHandler('tools/list', async () => {
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

mcpServer.setRequestHandler('tools/call', async (request) => {
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
  await mcpServer.connect(transport);
  console.log('Playwright MCP Server running on stdio');
  console.log('Available tools: navigate_to_url, wait_for_content, fill_form, click_element, get_page_content, capture_screenshot, get_screenshot_url, extract_map_data, extract_housesigma_chart');
}

if (require.main === module) {
  main().catch(console.error);
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
