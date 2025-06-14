import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright';

class PlaywrightMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'playwright-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupErrorHandling();
    this.setupTools();
  }

  setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  setupTools() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
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
                  description: 'The URL to navigate to',
                },
              },
              required: ['url'],
            },
          },
          {
            name: 'fill_form',
            description: 'Fill out a form on a webpage with multiple fields',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL of the page containing the form',
                },
                fields: {
                  type: 'array',
                  description: 'Array of field objects to fill',
                  items: {
                    type: 'object',
                    properties: {
                      selector: {
                        type: 'string',
                        description: 'CSS selector for the form field',
                      },
                      value: {
                        type: 'string',
                        description: 'Value to enter in the field',
                      },
                      action: {
                        type: 'string',
                        description: 'Action to perform (fill, select, check)',
                        enum: ['fill', 'select', 'check'],
                      },
                    },
                    required: ['selector', 'value', 'action'],
                  },
                },
              },
              required: ['url', 'fields'],
            },
          },
          {
            name: 'click_element',
            description: 'Click on an element on a webpage',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL of the page containing the element',
                },
                selector: {
                  type: 'string',
                  description: 'CSS selector for the element to click',
                },
              },
              required: ['url', 'selector'],
            },
          },
          {
            name: 'get_page_content',
            description: 'Get the HTML content and form structure of a webpage',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL of the page to inspect',
                },
                selector: {
                  type: 'string',
                  description: 'Optional CSS selector to get content from specific element only',
                },
                includeFormStructure: {
                  type: 'boolean',
                  description: 'Whether to include detailed form field information',
                  default: true,
                },
              },
              required: ['url'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result;
        switch (name) {
          case 'navigate_to_url':
            result = await this.handleNavigateToUrl(args);
            break;
          case 'fill_form':
            result = await this.handleFillForm(args);
            break;
          case 'click_element':
            result = await this.handleClickElement(args);
            break;
          case 'get_page_content':
            result = await this.handleGetPageContent(args);
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: result,
            },
          ],
        };
      } catch (error) {
        console.error(`Tool call error for ${name}:`, error.message);
        throw error;
      }
    });
  }

  async createBrowserInstance() {
    console.log('Creating fresh browser instance...');
    
    // Set browsers path for Render deployment
    if (process.env.RENDER) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/render/project/playwright';
      console.log('PLAYWRIGHT_BROWSERS_PATH set to:', process.env.PLAYWRIGHT_BROWSERS_PATH);
    }

    // Check if browsers exist
    try {
      const fs = await import('fs');
      const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || '';
      
      if (browsersPath && fs.existsSync(browsersPath)) {
        console.log('Browsers found at:', browsersPath);
      } else if (process.env.RENDER) {
        console.log('Browsers not found, installing Playwright browsers...');
        const { execSync } = await import('child_process');
        
        try {
          execSync('npx playwright install chromium', { stdio: 'inherit' });
          console.log('Playwright browsers installed successfully');
        } catch (installError) {
          console.error('Failed to install browsers:', installError.message);
          throw installError;
        }
      }
    } catch (error) {
      console.log('Browser check failed:', error.message);
    }

    console.log('Attempting to launch browser...');
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    });
    
    console.log('Browser launched successfully!');
    return browser;
  }

  async handleNavigateToUrl(args) {
    const { url } = args;
    const browser = await this.createBrowserInstance();
    
    try {
      const context = await browser.newContext();
      console.log('Browser context created for navigate_to_url');
      
      const page = await context.newPage();
      console.log(`Navigating to: ${url}`);
      
      await page.goto(url, { waitUntil: 'networkidle' });
      
      console.log('Closing context...');
      await context.close();
      console.log('Context closed successfully');
      
      return `Successfully navigated to ${url}`;
    } catch (error) {
      console.log('Closing context...');
      throw error;
    } finally {
      console.log('Closing browser...');
      await browser.close();
      console.log('Browser closed successfully');
    }
  }

  async handleFillForm(args) {
    const { url, fields } = args;
    const browser = await this.createBrowserInstance();
    
    try {
      const context = await browser.newContext();
      console.log('Browser context created for fill_form');
      
      const page = await context.newPage();
      console.log(`Filling form at: ${url}`);
      
      await page.goto(url, { waitUntil: 'networkidle' });
      
      const results = [];
      
      for (const field of fields) {
        const { selector, value, action } = field;
        console.log(`Processing field: ${selector} = ${value} (${action})`);
        
        try {
          await page.waitForSelector(selector, { timeout: 5000 });
          
          switch (action) {
            case 'fill':
              await page.fill(selector, value);
              break;
            case 'select':
              await page.selectOption(selector, value);
              break;
            case 'check':
              if (value.toLowerCase() === 'true' || value === '1') {
                await page.check(selector);
              } else {
                await page.uncheck(selector);
              }
              break;
            default:
              throw new Error(`Unknown action: ${action}`);
          }
          
          console.log(`Successfully processed: ${selector}`);
          results.push({ selector, value, action, status: 'success' });
        } catch (fieldError) {
          console.log(`Failed to process field ${selector}:`, fieldError.message);
          results.push({ selector, value, action, status: 'failed', error: fieldError.message });
        }
      }
      
      console.log('Closing context...');
      await context.close();
      console.log('Context closed successfully');
      
      return `Form filling completed. Results: ${JSON.stringify(results)}`;
    } catch (error) {
      console.log('Closing context...');
      throw error;
    } finally {
      console.log('Closing browser...');
      await browser.close();
      console.log('Browser closed successfully');
    }
  }

  async handleClickElement(args) {
    const { url, selector } = args;
    const browser = await this.createBrowserInstance();
    
    try {
      const context = await browser.newContext();
      console.log('Browser context created for click_element');
      
      const page = await context.newPage();
      console.log(`Clicking element at: ${url}`);
      
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.click(selector);
      
      console.log('Closing context...');
      await context.close();
      console.log('Context closed successfully');
      
      return `Successfully clicked element: ${selector}`;
    } catch (error) {
      console.log('Closing context...');
      throw error;
    } finally {
      console.log('Closing browser...');
      await browser.close();
      console.log('Browser closed successfully');
    }
  }

  async handleGetPageContent(args) {
    const { url, selector, includeFormStructure = true } = args;
    const browser = await this.createBrowserInstance();
    
    try {
      const context = await browser.newContext();
      console.log('Browser context created for get_page_content');
      
      const page = await context.newPage();
      console.log(`Getting content from: ${url}`);
      
      await page.goto(url, { waitUntil: 'networkidle' });
      
      let content = '';
      let formInfo = {};
      
      // Get HTML content
      if (selector) {
        console.log(`Getting content for selector: ${selector}`);
        await page.waitForSelector(selector, { timeout: 5000 });
        content = await page.innerHTML(selector);
      } else {
        console.log('Getting full page content');
        content = await page.content();
      }
      
      // Get form structure if requested
      if (includeFormStructure) {
        console.log('Analyzing form structure...');
        formInfo = await page.evaluate(() => {
          const forms = Array.from(document.querySelectorAll('form'));
          return forms.map((form, formIndex) => {
            const inputs = Array.from(form.querySelectorAll('input, select, textarea, button'));
            return {
              formIndex,
              action: form.action || 'No action specified',
              method: form.method || 'GET',
              fields: inputs.map(input => ({
                type: input.type || input.tagName.toLowerCase(),
                name: input.name || '',
                id: input.id || '',
                placeholder: input.placeholder || '',
                value: input.value || '',
                required: input.required || false,
                selector: input.name ? `input[name='${input.name}']` : 
                         input.id ? `#${input.id}` : 
                         `${input.tagName.toLowerCase()}[type='${input.type}']`,
                tagName: input.tagName.toLowerCase(),
                className: input.className || ''
              }))
            };
          });
        });
      }
      
      console.log('Closing context...');
      await context.close();
      console.log('Context closed successfully');
      
      const result = {
        url,
        title: await page.title(),
        contentLength: content.length,
        formsFound: formInfo.length || 0,
        forms: formInfo,
        htmlContent: content.length > 5000 ? content.substring(0, 5000) + '...[truncated]' : content
      };
      
      return `Page content analysis for ${url}:\n\nTitle: ${result.title}\nForms found: ${result.formsFound}\n\nForm Structure:\n${JSON.stringify(result.forms, null, 2)}\n\nHTML Content (first 5000 chars):\n${result.htmlContent}`;
      
    } catch (error) {
      console.log('Closing context...');
      throw error;
    } finally {
      console.log('Closing browser...');
      await browser.close();
      console.log('Browser closed successfully');
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log('Playwright MCP Server running on port 10000');
  }
}

const server = new PlaywrightMCPServer();
server.run().catch(console.error);
