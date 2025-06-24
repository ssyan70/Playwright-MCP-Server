// Add this debug function to your server.js for troubleshooting

async function debugMLSCommunity(page, address) {
  try {
    console.log(`DEBUG: Starting MLS community detection for: ${address}`);
    
    await page.goto('https://www.torontomls.net/Communities/map.html', { 
      waitUntil: 'domcontentloaded',
      timeout: 8000
    });
    
    await page.waitForTimeout(2000);
    console.log('DEBUG: Page loaded');
    
    // Check checkboxes
    await Promise.allSettled([
      page.click('#arealayer').catch(() => {}),
      page.click('#munilayer').catch(() => {}),
      page.click('#commlayer').catch(() => {})
    ]);
    console.log('DEBUG: Checkboxes clicked');
    
    await page.waitForTimeout(500);
    
    // Search
    await page.fill('#geosearch', address);
    await page.press('#geosearch', 'Enter');
    console.log('DEBUG: Search performed');
    
    await page.waitForTimeout(2000);
    
    // 8 zoom-outs
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Minus');
      await page.waitForTimeout(200);
    }
    console.log('DEBUG: 8 zoom-outs completed');
    
    await page.waitForTimeout(1000);
    
    // Capture all text on the page
    const allPageText = await page.evaluate(() => {
      const allElements = Array.from(document.querySelectorAll('*'));
      const textData = [];
      
      allElements.forEach(el => {
        const text = el.textContent?.trim();
        if (text && text.length >= 3 && text.length <= 50) {
          const rect = el.getBoundingClientRect();
          textData.push({
            text: text,
            visible: rect.width > 0 && rect.height > 0,
            tag: el.tagName,
            className: el.className || '',
            id: el.id || '',
            hasChildren: el.children.length > 0
          });
        }
      });
      
      return {
        allTexts: textData,
        pageTitle: document.title,
        url: window.location.href
      };
    });
    
    // Look for Cornell specifically
    const cornellMatches = allPageText.allTexts.filter(item => 
      item.text.toLowerCase().includes('cornell')
    );
    
    // Look for any community-like names
    const communityLike = allPageText.allTexts.filter(item => 
      item.visible && 
      !item.hasChildren &&
      /^[A-Z][a-zA-Z\s-']+$/.test(item.text) &&
      !/(search|zoom|map|layer|google|data|terms|privacy|help|about)/i.test(item.text)
    );
    
    return {
      success: true,
      debug: true,
      address: address,
      cornellMatches: cornellMatches,
      communityLikeTexts: communityLike.slice(0, 20),
      totalTextElements: allPageText.allTexts.length,
      visibleElements: allPageText.allTexts.filter(t => t.visible).length,
      url: allPageText.url,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    return {
      success: false,
      debug: true,
      error: error.message,
      address: address,
      timestamp: new Date().toISOString()
    };
  }
}

// Add this tool to your toolsList:
{
  name: 'debug_mls_community',
  description: 'Debug version of MLS community detection with detailed text analysis',
  inputSchema: {
    type: 'object',
    properties: {
      address: {
        type: 'string',
        description: 'The address to debug'
      }
    },
    required: ['address']
  }
}

// Add this case to your switch statement:
case 'debug_mls_community':
  const debugResult = await debugMLSCommunity(currentPage, args.address);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(debugResult, null, 2)
      }
    ]
  };
