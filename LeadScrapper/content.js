// Google Maps Scraper Content Script

let isScraping = false;
let targetLimit = 100;
let delayMs = 3000; // Default safe speed
let scrapedUrls = new Set();

// Helper: Log message to dashboard
function logToDashboard(message, type = 'system') {
  chrome.runtime.sendMessage({
    action: 'LOG_TO_DASHBOARD',
    message: message,
    type: type
  });
}

// Helper: Send lead data to dashboard
function sendLeadToDashboard(lead) {
  chrome.runtime.sendMessage({
    action: 'LEAD_SCRAPED',
    lead: lead
  });
}

// Helper: Send progress update
function sendProgress(current, target) {
  chrome.runtime.sendMessage({
    action: 'SCRAPING_PROGRESS',
    current: current,
    target: target
  });
}

// Helper: Send finished signal
function sendFinished() {
  chrome.runtime.sendMessage({
    action: 'SCRAPING_FINISHED'
  });
}

// Helper: Sleep utility
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Robust Feed Container Finder
function findFeedContainer() {
  // 1. Try standard role="feed"
  let feed = document.querySelector('div[role="feed"]');
  if (feed) return feed;
  
  // 2. Try common Google Maps feed classes
  feed = document.querySelector('div.m6QErb.DxyBCb');
  if (feed) return feed;

  // 3. Fallback: Search for any scrollable container that contains place links
  const divs = document.querySelectorAll('div');
  for (const div of divs) {
    const style = window.getComputedStyle(div);
    const hasScroll = style.overflowY === 'auto' || style.overflowY === 'scroll';
    if (hasScroll && div.scrollHeight > div.clientHeight) {
      if (div.querySelector('a[href*="/maps/place/"]')) {
        return div;
      }
    }
  }
  return null;
}

// Resilient selectors for details card
function getName() {
  const el = document.querySelector('h1');
  return el ? el.textContent.trim() : '';
}

function getCategory() {
  // 1. Direct category button
  let el = document.querySelector('button[jsaction="pane.rating.category"]');
  if (el) return el.textContent.trim();
  
  // 2. Class fallback
  el = document.querySelector('.DkEaCc');
  if (el) return el.textContent.trim();
  
  // 3. Structural fallback: text sibling to rating
  const ratingEl = document.querySelector('div.F7nice');
  if (ratingEl && ratingEl.nextElementSibling) {
    const txt = ratingEl.nextElementSibling.textContent.replace('·', '').trim();
    if (txt && txt.length < 30) return txt;
  }
  return '';
}

function getRating() {
  const el = document.querySelector('div.F7nice span[aria-hidden="true"]');
  if (el) {
    const val = parseFloat(el.textContent.trim().replace(',', '.'));
    if (!isNaN(val)) return val;
  }
  
  const parent = document.querySelector('div.F7nice');
  if (parent) {
    const aria = parent.getAttribute('aria-label');
    if (aria) {
      const match = aria.match(/(\d[.,]\d|\d)/);
      if (match) return parseFloat(match[1].replace(',', '.'));
    }
  }
  return 0.0;
}

function getReviewsCount() {
  const el = document.querySelector('button[jsaction="pane.rating.moreReviews"]');
  if (el) {
    const text = el.textContent.trim();
    const match = text.match(/(\d+[\d,.]*)/);
    if (match) return parseInt(match[1].replace(/[,.]/g, ''), 10) || 0;
  }
  
  const parent = document.querySelector('div.F7nice');
  if (parent) {
    const text = parent.textContent;
    const match = text.match(/\((\d+[\d,.]*)\)/);
    if (match) return parseInt(match[1].replace(/[,.]/g, ''), 10) || 0;
  }
  return 0;
}

function getAddress() {
  // 1. Data-item-id
  let el = document.querySelector('button[data-item-id="address"]');
  if (el) return el.textContent.trim();
  
  // 2. Aria label match
  el = document.querySelector('button[aria-label^="Address:"]');
  if (el) return el.getAttribute('aria-label').replace('Address:', '').trim();
  
  // 3. Iterate buttons looking for address keywords
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const aria = btn.getAttribute('aria-label');
    if (aria && aria.toLowerCase().includes('address:')) {
      return aria.replace(/address:/i, '').trim();
    }
  }
  return '';
}

function getPhone() {
  // 1. Data-item-id
  let el = document.querySelector('button[data-item-id^="phone:tel:"]');
  if (el) return el.textContent.trim();
  
  // 2. Anchor href
  el = document.querySelector('a[href^="tel:"]');
  if (el) return el.getAttribute('href').replace('tel:', '').trim();
  
  // 3. Aria label match
  el = document.querySelector('button[aria-label^="Phone:"]');
  if (el) return el.getAttribute('aria-label').replace('Phone:', '').trim();
  
  // 4. Iterate buttons looking for phone keywords
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const aria = btn.getAttribute('aria-label');
    if (aria && aria.toLowerCase().includes('phone:')) {
      return aria.replace(/phone:/i, '').trim();
    }
  }
  return '';
}

function getWebsite() {
  // 1. Data-item-id
  let el = document.querySelector('a[data-item-id="authority"]');
  if (el) return el.getAttribute('href') || el.textContent.trim();
  
  // 2. Aria label match
  el = document.querySelector('a[aria-label^="Website:"]');
  if (el) return el.getAttribute('href') || el.getAttribute('aria-label').replace('Website:', '').trim();
  
  // 3. Find any non-Google external link in details panel
  const links = document.querySelectorAll('a[href*="http"]');
  for (const link of links) {
    const href = link.href;
    if (!href.includes('google.com') && !href.includes('gstatic.com')) {
      return href;
    }
  }
  return '';
}

function getPlusCode() {
  let el = document.querySelector('button[data-item-id="oloc"]');
  if (el) return el.textContent.trim();
  
  el = document.querySelector('button[aria-label^="Plus code:"]');
  if (el) return el.getAttribute('aria-label').replace('Plus code:', '').trim();
  return '';
}

// Extraction logic for the current place
async function scrapeCurrentPlace() {
  const name = getName();
  const category = getCategory();
  const rating = getRating();
  const reviews = getReviewsCount();
  const address = getAddress();
  const phone = getPhone();
  const website = getWebsite();
  const plusCode = getPlusCode();
  
  // Get Lat/Lng from URL
  const url = window.location.href;
  const match = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  const lat = match ? match[1] : '';
  const lng = match ? match[2] : '';
  
  return {
    name,
    category,
    rating,
    reviews,
    address,
    phone,
    website,
    mapsUrl: url,
    lat,
    lng,
    plusCode
  };
}

// Main Scraping Loop
async function runScrapingLoop() {
  logToDashboard('Scraping loop started.', 'system');
  
  let consecutiveScrollFails = 0;
  
  while (isScraping) {
    // 1. Check if we've reached the target limit
    const storageData = await chrome.storage.local.get(['scrapedCount', 'targetLimit', 'isScrapingActive']);
    
    // Sync active state from storage
    if (storageData.isScrapingActive === false) {
      logToDashboard('Scraping paused by user.', 'warning');
      isScraping = false;
      break;
    }
    
    const currentCount = storageData.scrapedCount || 0;
    targetLimit = storageData.targetLimit || 100;
    
    if (currentCount >= targetLimit) {
      logToDashboard(`Target of ${targetLimit} leads reached! Finishing...`, 'success');
      sendFinished();
      isScraping = false;
      break;
    }
    
    // Find the feed
    const feed = findFeedContainer();
    if (!feed) {
      logToDashboard('Results feed container not found. Retrying in 2s...', 'warning');
      await sleep(2000);
      continue;
    }
    
    // Get place links
    const allLinks = Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'));
    
    // Filter unique links
    const uniqueLinks = [];
    const seenHrefs = new Set();
    for (const link of allLinks) {
      const href = link.href.split('?')[0]; // Clean query params
      if (!seenHrefs.has(href)) {
        seenHrefs.add(href);
        uniqueLinks.push({ el: link, href: href });
      }
    }
    
    // Find first unscraped link
    let nextLinkObj = null;
    for (const item of uniqueLinks) {
      if (!scrapedUrls.has(item.href)) {
        nextLinkObj = item;
        break;
      }
    }
    
    // 2. If no unscraped link is visible, scroll down to load more
    if (!nextLinkObj) {
      logToDashboard('No new results visible. Scrolling feed container down...', 'system');
      
      const previousScrollHeight = feed.scrollHeight;
      feed.scrollTop = feed.scrollHeight;
      
      await sleep(2500); // Wait for new results to render
      
      // Check if scroll height changed
      if (feed.scrollHeight === previousScrollHeight) {
        consecutiveScrollFails++;
        if (consecutiveScrollFails >= 3) {
          logToDashboard('Reached the bottom of Google Maps search results.', 'success');
          sendFinished();
          isScraping = false;
          break;
        }
      } else {
        consecutiveScrollFails = 0;
      }
      continue;
    }
    
    // 3. Click the next link and scrape details
    const linkEl = nextLinkObj.el;
    const placeUrl = nextLinkObj.href;
    
    // Scroll link into center of the feed
    linkEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(600);
    
    // Extract name from the card if possible for log reference
    let cardName = 'Unknown Place';
    const cardTitleEl = linkEl.closest('div.UaZB8f') || linkEl.closest('div.Nv2y3c') || linkEl;
    if (cardTitleEl) {
      const nameEl = cardTitleEl.querySelector('.qBF1Pd') || cardTitleEl.querySelector('.fontHeadlineSmall');
      if (nameEl) cardName = nameEl.textContent.trim();
    }
    
    logToDashboard(`Opening detail panel for: "${cardName}"...`, 'system');
    
    // Click the card to open details panel
    linkEl.click();
    
    // Wait for details card to load
    // We poll and wait for the URL to change to the clicked place AND the title to load
    let loaded = false;
    const startTime = Date.now();
    
    while (Date.now() - startTime < 6000) { // Timeout after 6 seconds
      const currentUrl = window.location.href;
      const h1Text = getName();
      
      // If URL matches and H1 is populated
      if (currentUrl.includes('/maps/place/') && h1Text) {
        loaded = true;
        break;
      }
      await sleep(200);
    }
    
    if (!loaded) {
      logToDashboard(`Warning: Detail panel did not load for "${cardName}" within 6s. Skipping...`, 'warning');
      scrapedUrls.add(placeUrl); // Mark as scraped to avoid loop lock
      continue;
    }
    
    // Add an extra buffer delay selected by the user
    const finalDelay = Math.max(800, delayMs - 1000); // subtract loading time if needed, min 800ms
    await sleep(finalDelay);
    
    // Scrape details!
    try {
      const leadData = await scrapeCurrentPlace();
      
      // Safety check: ensure we got a name
      if (!leadData.name) {
        leadData.name = cardName;
      }
      
      // Add to scraped sets
      scrapedUrls.add(placeUrl);
      
      // Update local storage scraped count
      const updatedCount = currentCount + 1;
      await chrome.storage.local.set({ scrapedCount: updatedCount });
      
      // Send lead to dashboard
      sendLeadToDashboard(leadData);
      sendProgress(updatedCount, targetLimit);
      
      logToDashboard(`Successfully extracted: "${leadData.name}"`, 'success');
      
    } catch (err) {
      logToDashboard(`Error scraping details for "${cardName}": ${err.message}`, 'error');
      scrapedUrls.add(placeUrl); // Mark to prevent loop lock
    }
    
    // Intercept check for pause
    const loopCheck = await chrome.storage.local.get(['isScrapingActive']);
    if (loopCheck.isScrapingActive === false) {
      logToDashboard('Scraping paused.', 'warning');
      isScraping = false;
      break;
    }
    
    // Short breather between actions
    await sleep(1000);
  }
}

// Listen for messages from background/dashboard
chrome.runtime.onMessageListener = null; // Clear if any
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'START_SCRAPING') {
    if (!isScraping) {
      isScraping = true;
      delayMs = request.delayMs || 3000;
      targetLimit = request.targetLimit || 100;
      
      // Reset local cache of scraped urls if it's a new run
      if (request.isNewRun) {
        scrapedUrls.clear();
      }
      
      runScrapingLoop().catch(err => {
        logToDashboard(`Scraping loop crashed: ${err.message}`, 'error');
        isScraping = false;
      });
      sendResponse({ status: 'started' });
    } else {
      sendResponse({ status: 'already_running' });
    }
  }
  
  else if (request.action === 'PAUSE_SCRAPING') {
    isScraping = false;
    logToDashboard('Pause request received. Stopping at next item...', 'warning');
    sendResponse({ status: 'pausing' });
  }
  
  else if (request.action === 'PING_CONTENT') {
    sendResponse({ status: 'alive', isScraping: isScraping });
  }
  
  return true;
});

// Check if we should autostart on load (e.g. redirected or reloaded during active scrape)
chrome.storage.local.get(['isScrapingActive', 'delayMs', 'targetLimit'], (result) => {
  if (result.isScrapingActive) {
    isScraping = true;
    delayMs = result.delayMs || 3000;
    targetLimit = result.targetLimit || 100;
    
    // Give Google Maps a moment to render the initial page layout before starting
    setTimeout(() => {
      runScrapingLoop().catch(err => {
        logToDashboard(`Autostart loop crashed: ${err.message}`, 'error');
        isScraping = false;
      });
    }, 3000);
  }
});
