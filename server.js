import { chromium } from 'playwright';
import express from 'express';

const app = express();
app.use(express.json());

let browser = null;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Initialize browser with Render-optimized settings
async function initBrowser() {
  if (!browser) {
    // Set the browsers path to a persistent directory
    const browsersPath = '/opt/render/project/playwright';
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
    
    console.log('PLAYWRIGHT_BROWSERS_PATH set to:', browsersPath);
    
    // Check if browsers exist, if not install them
    const fs = await import('fs');
    if (!fs.existsSync(browsersPath)) {
      console.log('Browsers not found, installing Playwright browsers...');
      try {
        const { execSync } = await import('child_process');
        execSync('npx playwright install chromium', { stdio: 'inherit' });
        console.log('Playwright browsers installed successfully');
      } catch (installError) {
        console.log('Failed to install browsers:', installError.message);
        throw new Error('Failed to install Playwright browsers');
      }
    } else {
      console.log('Browsers found at:', browsersPath);
    }
    
    const launchOptions = { 
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ]
    };
    
    try {
      console.log('Attempting to launch browser...');
      
      // Try regular chromium launch (should work now with proper path)
      browser = await chromium.launch(launchOptions);
      console.log('Browser launched successfully!');
      
    } catch (error) {
      console.log('Browser launch failed:', error.message);
      throw new Error('Failed to launch browser: ' + error.message);
    }
  }
  return browser;
}

// MCP Protocol Implementation
app.post('/', async (req, res) => {
  const { jsonrpc, method, params, id } = req.body;
  
  console.log('MCP Request:', { method, params });
  
  try {
    let result;
    
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            resources: {}
          },
          serverInfo: {
            name: 'playwright-mcp-server',
            version: '1.0.0'
          }
        };
        break;
        
      case 'tools/list':
        result = {
          tools: [
            {
              name: 'navigate_to_url',
              description: 'Navigate to a specific URL and take a screenshot',
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
              name: 'fill_form',
              description: 'Fill out form fields on a webpage',
              inputSchema: {
                type: 'object',
                properties: {
                  url: {
                    type: 'string',
                    description: 'The URL of the page with the form'
                  },
                  fields: {
                    type: 'array',
                    description: 'Array of form fields to fill',
                    items: {
                      type: 'object',
                      properties: {
                        selector: {
                          type: 'string',
                          description: 'CSS selector for the form field'
                        },
                        value: {
                          type: 'string',
                          description: 'Value to enter in the field'
                        },
                        action: {
                          type: 'string',
                          description: 'Action to perform: fill, select, check, click',
                          enum: ['fill', 'select', 'check', 'click']
                        }
                      },
                      required: ['selector', 'value']
                    }
                  }
                },
                required: ['url', 'fields']
              }
            },
            {
              name: 'click_element',
              description: 'Click on an element on a webpage',
              inputSchema: {
                type: 'object',
                properties: {
                  url: {
                    type: 'string',
                    description: 'The URL of the page'
                  },
                  selector: {
                    type: 'string',
                    description: 'CSS selector for the element to click'
                  }
                },
                required: ['url', 'selector']
              }
            }
          ]
        };
        break;
        
      case 'tools/call':
        const { name, arguments: args } = params;
        result = await handleToolCall(name, args);
        break;
        
      case 'resources/list':
        result = {
          resources: []
        };
        break;
        
      case 'notifications/initialized':
        // This is a notification, no response needed
        res.status(200).end();
        return;
        
      default:
        throw new Error(`Unknown method: ${method}`);
    }
    
    res.json({
      jsonrpc: '2.0',
      id,
      result
    });
    
  } catch (error) {
    console.error('MCP Error:', error);
    res.json({
      jsonrpc: '2.0',
      id,
      error: {
        code: -1,
        message: error.message
      }
    });
  }
});

// Handle tool calls
async function handleToolCall(toolName, args) {
  let context = null;
  
  try {
    const browserInstance = await initBrowser();
    context = await browserInstance.newContext();
    const page = await context.newPage();
    
    switch (toolName) {
      case 'navigate_to_url':
        await page.goto(args.url, { waitUntil: 'networkidle' });
        const navScreenshot = await page.screenshot({ encoding: 'base64' });
        
        return {
          content: [
            {
              type: 'text',
              text: `Successfully navigated to ${args.url}`
            },
            {
              type: 'image',
              data: navScreenshot,
              mimeType: 'image/png'
            }
          ]
        };
        
      case 'fill_form':
        await page.goto(args.url, { waitUntil: 'networkidle' });
        
        const results = [];
        for (const field of args.fields) {
          try {
            const { selector, value, action = 'fill' } = field;
            
            await page.waitForSelector(selector, { timeout: 10000 });
            
            if (action === 'fill') {
              await page.fill(selector, value);
            } else if (action === 'select') {
              await page.selectOption(selector, value);
            } else if (action === 'check') {
              await page.check(selector);
            } else if (action === 'click') {
              await page.click(selector);
            }
            
            results.push({
              selector,
              value,
              action,
              status: 'success'
            });
          } catch (fieldError) {
            results.push({
              selector: field.selector,
              value: field.value,
              action: field.action || 'fill',
              status: 'error',
              error: fieldError.message
            });
          }
        }
        
        const formScreenshot = await page.screenshot({ 
          encoding: 'base64',
          fullPage: true 
        });
        
        return {
          content: [
            {
              type: 'text',
              text: `Form filling completed. Results: ${JSON.stringify(results, null, 2)}`
            },
            {
              type: 'image',
              data: formScreenshot,
              mimeType: 'image/png'
            }
          ]
        };
        
      case 'click_element':
        await page.goto(args.url, { waitUntil: 'networkidle' });
        await page.waitForSelector(args.selector, { timeout: 10000 });
        await page.click(args.selector);
        
        // Wait for any changes
        await page.waitForTimeout(2000);
        
        const clickScreenshot = await page.screenshot({ encoding: 'base64' });
        
        return {
          content: [
            {
              type: 'text',
              text: `Successfully clicked element: ${args.selector}`
            },
            {
              type: 'image',
              data: clickScreenshot,
              mimeType: 'image/png'
            }
          ]
        };
        
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
    
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (closeError) {
        console.log('Error closing context:', closeError.message);
      }
    }
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Playwright MCP Server running on port ${PORT}`);
});
