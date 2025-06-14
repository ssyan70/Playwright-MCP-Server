import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

let browser = null;

// Initialize browser with Render-optimized settings
async function initBrowser() {
  if (!browser) {
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
      // Set the PLAYWRIGHT_BROWSERS_PATH if not already set
      if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/render/.cache/ms-playwright';
      }
      
      console.log('Attempting to launch browser...');
      console.log('PLAYWRIGHT_BROWSERS_PATH:', process.env.PLAYWRIGHT_BROWSERS_PATH);
      
      // Try regular chromium launch
      browser = await chromium.launch(launchOptions);
      console.log('Browser launched successfully!');
      
    } catch (error) {
      console.log('Browser launch failed:', error.message);
      
      // Fallback: Try specific known paths based on the logs
      const knownPaths = [
        // Headless shell paths
        '/opt/render/.cache/ms-playwright/chromium_headless_shell-1178/headless_shell',
        '/opt/render/.cache/ms-playwright/chromium_headless_shell-1178/chrome-headless-shell',
        '/opt/render/.cache/ms-playwright/chromium_headless_shell-1178/chrome-linux/headless_shell',
        
        // Regular chromium paths
        '/opt/render/.cache/ms-playwright/chromium-1178/chrome',
        '/opt/render/.cache/ms-playwright/chromium-1178/chromium',
        '/opt/render/.cache/ms-playwright/chromium-1178/chrome-linux/chrome',
        '/opt/render/.cache/ms-playwright/chromium-1178/chrome-linux/chromium'
      ];
      
      console.log('Trying known executable paths...');
      
      for (const executablePath of knownPaths) {
        try {
          console.log(`Testing path: ${executablePath}`);
          
          // Check if file exists using imported fs functions
          if (existsSync(executablePath)) {
            console.log(`Found executable at: ${executablePath}`);
            browser = await chromium.launch({ ...launchOptions, executablePath });
            console.log('Browser launched successfully with found executable!');
            break;
          } else {
            console.log(`File does not exist: ${executablePath}`);
          }
        } catch (execError) {
          console.log(`Failed with ${executablePath}: ${execError.message}`);
        }
      }
      
      if (!browser) {
        // Last resort: search the filesystem
        console.log('Searching filesystem for executables...');
        
        function findExecutables(dir, depth = 0) {
          if (depth > 3) return []; // Limit search depth
          
          try {
            const items = readdirSync(dir);
            let found = [];
            
            for (const item of items) {
              const fullPath = join(dir, item);
              try {
                const stat = statSync(fullPath);
                
                if (stat.isDirectory()) {
                  found = found.concat(findExecutables(fullPath, depth + 1));
                } else if (stat.isFile() && (item === 'chrome' || item === 'chromium' || item === 'headless_shell' || item === 'chrome-headless-shell')) {
                  found.push(fullPath);
                }
              } catch (statError) {
                // Skip files we can't stat
              }
            }
            return found;
          } catch (err) {
            console.log(`Cannot read directory ${dir}: ${err.message}`);
            return [];
          }
        }
        
        const foundExecutables = findExecutables('/opt/render/.cache/ms-playwright');
        console.log('Found executables:', foundExecutables);
        
        for (const execPath of foundExecutables) {
          try {
            console.log(`Trying found executable: ${execPath}`);
            browser = await chromium.launch({ ...launchOptions, executablePath: execPath });
            console.log('Browser launched successfully with searched executable!');
            break;
          } catch (execError) {
            console.log(`Failed with found executable ${execPath}: ${execError.message}`);
          }
        }
        
        if (!browser) {
          throw new Error('Failed to launch browser with any available executable. Found executables: ' + foundExecutables.join(', '));
        }
      }
    }
  }
  return browser;
}

// Form filling endpoint
app.post('/fill-form', async (req, res) => {
  const { url, formData, waitForSelector, submitButton } = req.body;
  
  try {
    await initBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Navigate to the page
    await page.goto(url);
    
    // Wait for the form to load
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector);
    }
    
    // Fill form fields
    for (const [selector, value] of Object.entries(formData)) {
      await page.fill(selector, value);
    }
    
    // Submit form if button specified
    if (submitButton) {
      await page.click(submitButton);
      await page.waitForLoadState('networkidle');
    }
    
    // Get the result page content
    const content = await page.content();
    const url_after = page.url();
    
    await context.close();
    
    res.json({
      success: true,
      content,
      url: url_after,
      message: 'Form filled successfully'
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Smart form filling with element detection
app.post('/smart-fill-form', async (req, res) => {
  const { url, formFields, submitText = 'Submit' } = req.body;
  
  try {
    await initBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    
    // Smart field detection and filling
    for (const field of formFields) {
      const { label, value, type = 'text' } = field;
      
      let selector = null;
      
      // Try different selectors based on label
      const possibleSelectors = [
        `input[placeholder*="${label}" i]`,
        `input[name*="${label.toLowerCase()}"]`,
        `input[id*="${label.toLowerCase()}"]`,
        `//label[contains(text(), "${label}")]/following-sibling::input`,
        `//label[contains(text(), "${label}")]/parent::*/input`
      ];
      
      for (const sel of possibleSelectors) {
        try {
          if (sel.startsWith('//')) {
            const element = await page.locator(`xpath=${sel}`).first();
            if (await element.isVisible()) {
              await element.fill(value);
              break;
            }
          } else {
            const element = page.locator(sel).first();
            if (await element.isVisible()) {
              await element.fill(value);
              break;
            }
          }
        } catch (e) {
          continue;
        }
      }
    }
    
    // Find and click submit button
    const submitSelectors = [
      `button:has-text("${submitText}")`,
      `input[type="submit"]`,
      `button[type="submit"]`,
      `//button[contains(text(), "${submitText}")]`
    ];
    
    for (const sel of submitSelectors) {
      try {
        if (sel.startsWith('//')) {
          await page.locator(`xpath=${sel}`).first().click();
        } else {
          await page.locator(sel).first().click();
        }
        break;
      } catch (e) {
        continue;
      }
    }
    
    await page.waitForLoadState('networkidle');
    
    const content = await page.content();
    const finalUrl = page.url();
    
    await context.close();
    
    res.json({
      success: true,
      content,
      url: finalUrl,
      message: 'Smart form filling completed'
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Extract data from page
app.post('/extract-data', async (req, res) => {
  const { url, selectors } = req.body;
  
  try {
    await initBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    
    const results = {};
    
    for (const [key, selector] of Object.entries(selectors)) {
      try {
        const element = page.locator(selector);
        results[key] = await element.textContent();
      } catch (e) {
        results[key] = null;
      }
    }
    
    await context.close();
    
    res.json({
      success: true,
      data: results
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'Playwright MCP Server' });
});

// Keep alive endpoint to prevent Render from sleeping
app.get('/keepalive', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Cleanup on exit
process.on('SIGINT', async () => {
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Playwright MCP Server running on port ${PORT}`);
});
