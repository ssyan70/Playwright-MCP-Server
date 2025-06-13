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
    browser = await chromium.launch({ 
      headless: true,
      executablePath: '/opt/render/.cache/ms-playwright/chromium-1178/chrome-linux/chrome',
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    });
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
