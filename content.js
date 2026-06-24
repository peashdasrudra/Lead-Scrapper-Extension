// Google Maps Lead Scraper - Content Script (Robust Edition v2)
// Fully rewritten for reliable multi-lead extraction with back-navigation

let isScraping = false;
let targetLimit = 100;
let delayMs = 3000;
let scrapedUrls = new Set();
let searchUrl = '';

// ==================== MESSAGING HELPERS ====================

function logToDashboard(message, type = 'system') {
  chrome.runtime.sendMessage({ action: 'LOG_TO_DASHBOARD', message, type });
}

function sendLeadToDashboard(lead) {
  chrome.runtime.sendMessage({ action: 'LEAD_SCRAPED', lead });
}

function sendProgress(current, target) {
  chrome.runtime.sendMessage({ action: 'SCRAPING_PROGRESS', current, target });
}

function sendFinished() {
  chrome.runtime.sendMessage({ action: 'SCRAPING_FINISHED' });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==================== PLACE IDENTIFIER ====================

function getPlaceIdentifier(url) {
  try {
    const decoded = decodeURIComponent(url);
    const parts = decoded.split('/maps/place/');
    if (parts.length > 1) {
      return parts[1].split('/')[0].split('@')[0].trim();
    }
  } catch (e) {}
  return url.split('?')[0];
}

// ==================== DOM FINDERS ====================

// Find the search results feed container.
// INDEPENDENT of getDetailsPanel() to avoid circular dependency bugs.
function findFeedContainer() {
  // 1. Primary: role="feed" — Google's semantic attribute for the search results list
  const feeds = document.querySelectorAll('div[role="feed"]');
  for (const feed of feeds) {
    if (feed.querySelector('a[href*="/maps/place/"]')) return feed;
  }

  // 2. Class-based: ecceSd is specific to the search results scroll container
  const eccesFeeds = document.querySelectorAll('div.m6QErb.DxyBCb.ecceSd');
  for (const feed of eccesFeeds) {
    if (feed.querySelector('a[href*="/maps/place/"]')) return feed;
  }

  // 3. Broader class fallback with feed/ecceSd verification
  const mFeeds = document.querySelectorAll('div.m6QErb.DxyBCb');
  for (const feed of mFeeds) {
    if ((feed.getAttribute('role') === 'feed' || feed.classList.contains('ecceSd')) &&
        feed.querySelector('a[href*="/maps/place/"]')) {
      return feed;
    }
  }

  // 4. Last resort: any scrollable container with feed markers and place links
  for (const div of document.querySelectorAll('div[role="feed"], div.ecceSd')) {
    const style = window.getComputedStyle(div);
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        div.scrollHeight > div.clientHeight &&
        div.querySelector('a[href*="/maps/place/"]')) {
      return div;
    }
  }

  return null;
}

// Find the active place details panel (NOT the search results feed)
function getDetailsPanel() {
  // 1. Class-based detection — must NOT be the search feed
  const panels = document.querySelectorAll('.bJHLSc, .XpcRkf');
  for (const panel of panels) {
    if (panel.getAttribute('role') === 'feed' || panel.classList.contains('ecceSd')) continue;
    // Verify it's a real details panel by checking for detail-specific elements
    if (panel.querySelector('h1.DUwDvf') ||
        panel.querySelector('button[data-item-id="directions"]') ||
        panel.querySelector('button[data-item-id="address"]') ||
        panel.querySelector('div.F7nice')) {
      return panel;
    }
  }

  // 2. Button-based with feed exclusion
  const btns = document.querySelectorAll(
    'button[data-item-id="directions"], button[data-item-id="address"]'
  );
  for (const btn of btns) {
    if (btn.closest('div[role="feed"]') || btn.closest('.ecceSd')) continue;

    let parent = btn.parentElement;
    while (parent && parent !== document.body) {
      if (parent.classList.contains('bJHLSc') || parent.classList.contains('XpcRkf')) return parent;
      if (parent.getAttribute('role') === 'main' && !parent.querySelector('div[role="feed"]')) {
        return parent;
      }
      parent = parent.parentElement;
    }
    return btn.closest('.bJHLSc') || btn.closest('.XpcRkf') || btn.parentElement;
  }

  return null;
}

// ==================== BACK NAVIGATION ====================

// Navigate back from place details to the search results list
async function navigateBackToResults() {
  // If feed is already visible, nothing to do
  if (findFeedContainer()) return true;

  // Method 1: Click Google Maps back button (try multiple language-independent selectors)
  const backSelectors = [
    'button[aria-label="Back"]',
    'button[aria-label="Go back"]',
    'button.hYkMKe',
    'span.hYkMKe',
    'button[jsaction*="pane.header.back"]',
    'button[jsaction*=".back;"]',
    'button[jsaction*="back"]'
  ];

  for (const sel of backSelectors) {
    const btns = document.querySelectorAll(sel);
    for (const btn of btns) {
      if (btn.offsetParent !== null || btn.offsetWidth > 0) {
        btn.click();
        await sleep(2500);
        if (findFeedContainer()) return true;
      }
    }
  }

  // Method 2: First button in the details panel header (universally the back button)
  const panel = getDetailsPanel();
  if (panel) {
    const panelBtns = panel.querySelectorAll('button');
    for (let i = 0; i < Math.min(4, panelBtns.length); i++) {
      const btn = panelBtns[i];
      const dataId = btn.getAttribute('data-item-id') || '';
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      // Skip functional buttons
      if (dataId === 'directions' || dataId === 'address' || dataId.startsWith('phone') ||
          ariaLabel.includes('directions') || ariaLabel.includes('save') || ariaLabel.includes('share')) {
        continue;
      }
      btn.click();
      await sleep(2500);
      if (findFeedContainer()) return true;
    }
  }

  // Method 3: Browser history back
  window.history.back();
  await sleep(3000);
  if (findFeedContainer()) return true;

  // Method 4: Direct URL navigation (last resort — resets scroll position)
  if (searchUrl) {
    logToDashboard('Recovering via direct search URL...', 'warning');
    window.location.href = searchUrl;
    await sleep(5000);
    if (findFeedContainer()) return true;
  }

  return false;
}

// Wait for feed container to appear with a timeout
async function waitForFeed(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const feed = findFeedContainer();
    if (feed && feed.querySelector('a[href*="/maps/place/"]')) return feed;
    await sleep(500);
  }
  return null;
}

// ==================== DATA EXTRACTION HELPERS ====================

function getCleanText(selector, root = document) {
  const el = root.querySelector(selector);
  if (!el) return '';
  const textEl = el.querySelector('.Io6YTe') || el.querySelector('.RogA2c') ||
                 el.querySelector('.fontBodyMedium') || el;
  return textEl.textContent.trim();
}

function getName(panel, cardName = '') {
  const root = panel || document;

  const classTitle = root.querySelector('h1.DUwDvf');
  if (classTitle && classTitle.textContent.trim()) {
    const txt = classTitle.textContent.trim();
    if (txt !== 'Results' && !txt.toLowerCase().includes('results for')) return txt;
  }

  if (panel) {
    const h1 = panel.querySelector('h1');
    if (h1 && h1.textContent.trim()) {
      const txt = h1.textContent.trim();
      if (txt !== 'Results' && !txt.toLowerCase().includes('results for')) return txt;
    }
  }

  const h1s = Array.from(document.querySelectorAll('h1'));
  for (const h1 of h1s) {
    const text = h1.textContent.trim();
    if (text && !text.toLowerCase().startsWith('results for') &&
        !text.toLowerCase().includes('search results') &&
        text !== 'Results' && text !== 'Search') {
      return text;
    }
  }

  return cardName || '';
}

function getCategory(panel) {
  const root = panel || document;

  let el = root.querySelector('button[jsaction="pane.rating.category"]') ||
           root.querySelector('button[jsaction*="category"]');
  if (el) return el.textContent.trim();

  el = root.querySelector('.DkEaCc');
  if (el) return el.textContent.trim();

  const ratingEl = root.querySelector('div.F7nice');
  if (ratingEl) {
    const parent = ratingEl.parentElement;
    if (parent) {
      const buttons = Array.from(parent.querySelectorAll('button'));
      const catBtn = buttons.find(b =>
        !b.querySelector('span') && b.textContent.trim().length > 2 &&
        !b.textContent.includes('review') && !b.textContent.includes('★'));
      if (catBtn) return catBtn.textContent.trim();

      const spans = Array.from(parent.querySelectorAll('span'));
      const catSpan = spans.find(s =>
        s.textContent.trim().length > 2 && !s.textContent.includes('review') &&
        !s.textContent.includes('★') && !s.textContent.includes('·'));
      if (catSpan) return catSpan.textContent.trim();
    }
  }
  return '';
}

function getRating(panel) {
  const root = panel || document;
  const el = root.querySelector('div.F7nice span[aria-hidden="true"]');
  if (el) {
    const val = parseFloat(el.textContent.trim().replace(',', '.'));
    if (!isNaN(val)) return val;
  }
  const parent = root.querySelector('div.F7nice');
  if (parent) {
    const aria = parent.getAttribute('aria-label');
    if (aria) {
      const match = aria.match(/(\d[.,]\d|\d)/);
      if (match) return parseFloat(match[1].replace(',', '.'));
    }
  }
  return 0.0;
}

function getReviewsCount(panel) {
  const root = panel || document;
  const el = root.querySelector('button[jsaction="pane.rating.moreReviews"]');
  if (el) {
    const match = el.textContent.trim().match(/(\d+[\d,.]*)/);
    if (match) return parseInt(match[1].replace(/[,.]/g, ''), 10) || 0;
  }
  const parent = root.querySelector('div.F7nice');
  if (parent) {
    const match = parent.textContent.match(/\((\d+[\d,.]*)\)/);
    if (match) return parseInt(match[1].replace(/[,.]/g, ''), 10) || 0;
  }
  return 0;
}

function getAddress(panel) {
  const root = panel || document;
  let text = getCleanText('button[data-item-id="address"]', root);
  if (text) return text;
  let el = root.querySelector('button[aria-label^="Address:"]');
  if (el) return el.getAttribute('aria-label').replace('Address:', '').trim();
  for (const btn of root.querySelectorAll('button')) {
    const aria = btn.getAttribute('aria-label');
    if (aria && aria.toLowerCase().includes('address:')) return aria.replace(/address:/i, '').trim();
  }
  return '';
}

function getPhone(panel) {
  const root = panel || document;
  let text = getCleanText('button[data-item-id^="phone:tel:"]', root);
  if (text) return text;
  let el = root.querySelector('a[href^="tel:"]');
  if (el) return el.getAttribute('href').replace('tel:', '').trim();
  el = root.querySelector('button[aria-label^="Phone:"]');
  if (el) return el.getAttribute('aria-label').replace('Phone:', '').trim();
  for (const btn of root.querySelectorAll('button')) {
    const aria = btn.getAttribute('aria-label');
    if (aria && aria.toLowerCase().includes('phone:')) return aria.replace(/phone:/i, '').trim();
  }
  return '';
}

function getWebsite(panel) {
  const root = panel || document;
  let el = root.querySelector('a[data-item-id="authority"]');
  if (el) return el.getAttribute('href') || el.textContent.trim();
  el = root.querySelector('a[aria-label^="Website:"]');
  if (el) return el.getAttribute('href') || el.getAttribute('aria-label').replace('Website:', '').trim();
  const links = root.querySelectorAll('a[href*="http"]');
  for (const link of links) {
    const href = link.href;
    if (!href.includes('google.com') && !href.includes('gstatic.com') &&
        !href.includes('facebook.com') && !href.includes('instagram.com') &&
        !href.includes('twitter.com') && !href.includes('linkedin.com')) {
      return href;
    }
  }
  return '';
}

function getPlusCode(panel) {
  const root = panel || document;
  let text = getCleanText('button[data-item-id="oloc"]', root);
  if (text) return text;
  let el = root.querySelector('button[aria-label^="Plus code:"]');
  if (el) return el.getAttribute('aria-label').replace('Plus code:', '').trim();
  return '';
}

function getClaimedStatus(panel) {
  const root = panel || document;
  const text = root.textContent || '';
  if (text.includes('Claim this business') || text.includes('Own this business?')) return 'Unclaimed';
  return 'Claimed';
}

function getSocialLinks(panel) {
  const root = panel || document;
  const social = { facebook: '', instagram: '', twitter: '', linkedin: '', youtube: '' };
  for (const link of root.querySelectorAll('a[href*="http"]')) {
    const href = link.href.toLowerCase();
    if (href.includes('sharer') || href.includes('share') || href.includes('intent/tweet')) continue;
    if (href.includes('facebook.com')) social.facebook = link.href;
    else if (href.includes('instagram.com')) social.instagram = link.href;
    else if (href.includes('twitter.com') || href.includes('x.com')) social.twitter = link.href;
    else if (href.includes('linkedin.com')) social.linkedin = link.href;
    else if (href.includes('youtube.com')) social.youtube = link.href;
  }
  return social;
}

// Extract business hours
function getBusinessHours(panel) {
  const root = panel || document;

  // Try the hours button aria-label
  const hoursBtn = root.querySelector('button[data-item-id="oh"]') ||
                   root.querySelector('button[aria-label*="hour"]') ||
                   root.querySelector('button[aria-label*="Hours"]');
  if (hoursBtn) {
    const aria = hoursBtn.getAttribute('aria-label');
    if (aria) return aria.trim();
    const text = hoursBtn.textContent.trim();
    if (text) return text;
  }

  // Expanded hours table
  const hoursTable = root.querySelector('table.eK4R0e, table.WgFkxc, table.y0skZc');
  if (hoursTable) {
    const rows = hoursTable.querySelectorAll('tr');
    const hours = [];
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) hours.push(`${cells[0].textContent.trim()}: ${cells[1].textContent.trim()}`);
    }
    if (hours.length > 0) return hours.join(' | ');
  }

  // Open/closed text fallback
  const openEl = root.querySelector('.ZDu9vd');
  if (openEl) return openEl.textContent.trim();

  return '';
}

// Extract price level ($, $$, $$$, $$$$)
function getPriceLevel(panel) {
  const root = panel || document;
  const priceEl = root.querySelector('.mgr77e') || root.querySelector('[aria-label*="Price"]');
  if (priceEl) return priceEl.textContent.trim();

  for (const span of root.querySelectorAll('span')) {
    const text = span.textContent.trim();
    if (/^\${1,4}$/.test(text)) return text;
  }
  return '';
}

// Extract current open/closed status
function getOpenStatus(panel) {
  const root = panel || document;

  const statusEl = root.querySelector('.ZDu9vd span') || root.querySelector('.ZDu9vd');
  if (statusEl) {
    const text = statusEl.textContent.trim().toLowerCase();
    if (text.includes('open')) return 'Open';
    if (text.includes('closed')) return 'Closed';
    return statusEl.textContent.trim();
  }

  const hoursBtn = root.querySelector('button[data-item-id="oh"]');
  if (hoursBtn) {
    const text = hoursBtn.textContent.trim().toLowerCase();
    if (text.includes('open')) return 'Open';
    if (text.includes('closed')) return 'Closed';
  }
  return '';
}

// Extract service options (Dine-in, Takeout, Delivery etc.)
function getServiceOptions(panel) {
  const root = panel || document;
  const options = [];

  const serviceEls = root.querySelectorAll('.E0DTEd .wmQCje, .LTs0Rc, .qty3Ue');
  for (const el of serviceEls) {
    const text = el.textContent.trim();
    if (text && text.length < 60) options.push(text);
  }
  if (options.length > 0) return options.join(', ');

  for (const el of root.querySelectorAll('[aria-label]')) {
    const label = el.getAttribute('aria-label') || '';
    if (label.includes('Dine-in') || label.includes('Takeout') || label.includes('Delivery') ||
        label.includes('Curbside') || label.includes('No-contact')) {
      return label.trim();
    }
  }
  return '';
}

// ==================== FULL DATA EXTRACTION ====================

async function scrapeCurrentPlace(cardName = '') {
  const panel = getDetailsPanel();

  const name = getName(panel, cardName);
  const category = getCategory(panel);
  const rating = getRating(panel);
  const reviews = getReviewsCount(panel);
  const address = getAddress(panel);
  const phone = getPhone(panel);
  const website = getWebsite(panel);
  const plusCode = getPlusCode(panel);
  const claimedStatus = getClaimedStatus(panel);
  const social = getSocialLinks(panel);
  const businessHours = getBusinessHours(panel);
  const priceLevel = getPriceLevel(panel);
  const openStatus = getOpenStatus(panel);
  const serviceOptions = getServiceOptions(panel);

  let isWebsiteSecure = 'No Website';
  if (website) {
    isWebsiteSecure = website.toLowerCase().startsWith('https://') ? 'Secure (HTTPS)' : 'Insecure (HTTP)';
  }

  const url = window.location.href;
  const match = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  const lat = match ? match[1] : '';
  const lng = match ? match[2] : '';

  return {
    name, category, rating, reviews, address, phone, website,
    isWebsiteSecure, claimedStatus,
    facebook: social.facebook, instagram: social.instagram,
    linkedin: social.linkedin, twitter: social.twitter, youtube: social.youtube,
    mapsUrl: url, lat, lng, plusCode,
    businessHours, priceLevel, openStatus, serviceOptions
  };
}

// ==================== MAIN SCRAPING LOOP ====================

async function runScrapingLoop() {
  logToDashboard('Scraping loop started.', 'system');

  // Save the search URL so we can navigate back if needed
  searchUrl = window.location.href;

  let consecutiveScrollFails = 0;
  let isFirstIteration = true;
  let consecutiveFeedErrors = 0;
  let totalScrapedThisSession = 0;

  while (isScraping) {
    // ---- 1. Check limits and pause state ----
    const storageData = await chrome.storage.local.get(['scrapedCount', 'targetLimit', 'isScrapingActive']);

    if (storageData.isScrapingActive === false) {
      logToDashboard('Scraping paused by user.', 'warning');
      isScraping = false;
      break;
    }

    const currentCount = storageData.scrapedCount || 0;
    targetLimit = storageData.targetLimit || 100;

    if (currentCount >= targetLimit) {
      logToDashboard(`🎉 Target of ${targetLimit} leads reached!`, 'success');
      sendFinished();
      isScraping = false;
      break;
    }

    // ---- 2. Handle direct single-place redirect (FIRST ITERATION ONLY) ----
    // When Google redirects directly to a single business instead of showing a list
    if (isFirstIteration) {
      isFirstIteration = false;
      const currentUrl = window.location.href;

      if (currentUrl.includes('/maps/place/') && !findFeedContainer()) {
        await sleep(2000);
        const panel = getDetailsPanel();
        if (panel && !findFeedContainer()) {
          logToDashboard('Google redirected to a single business. Scraping it...', 'system');
          try {
            const leadData = await scrapeCurrentPlace();
            if (leadData.name) {
              sendLeadToDashboard(leadData);
              sendProgress(1, targetLimit);
              logToDashboard(`✅ Extracted single result: "${leadData.name}"`, 'success');
            }
          } catch (err) {
            logToDashboard(`Error: ${err.message}`, 'error');
          }
          sendFinished();
          isScraping = false;
          break;
        }
      }
    }

    // ---- 3. Find the search results feed ----
    let feed = findFeedContainer();

    if (!feed) {
      // Feed not visible — we're likely on a place details page, need to go back
      logToDashboard('Feed not visible. Navigating back to results list...', 'system');
      const navigated = await navigateBackToResults();

      if (navigated) {
        feed = await waitForFeed(10000);
      }

      if (!feed) {
        consecutiveFeedErrors++;
        logToDashboard(`Feed not found (attempt ${consecutiveFeedErrors}/10). Retrying...`, 'warning');

        if (consecutiveFeedErrors >= 10) {
          logToDashboard('Could not recover search results feed after 10 attempts. Stopping.', 'error');
          sendFinished();
          isScraping = false;
          break;
        }
        await sleep(3000);
        continue;
      }
      consecutiveFeedErrors = 0;
    }

    // ---- 4. Collect all visible place links ----
    const allLinks = Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'));
    const uniqueLinks = [];
    const seenIdentifiers = new Set();

    for (const link of allLinks) {
      const placeId = getPlaceIdentifier(link.href);
      if (!seenIdentifiers.has(placeId)) {
        seenIdentifiers.add(placeId);
        uniqueLinks.push({ el: link, href: link.href, placeId });
      }
    }

    // ---- 5. Find the next unscraped business ----
    let nextLink = null;
    for (const item of uniqueLinks) {
      if (!scrapedUrls.has(item.placeId)) {
        nextLink = item;
        break;
      }
    }

    // ---- 6. If all visible items are scraped, scroll for more ----
    if (!nextLink) {
      logToDashboard(`All ${uniqueLinks.length} visible results scraped. Scrolling for more...`, 'system');

      const prevHeight = feed.scrollHeight;
      const prevCount = uniqueLinks.length;

      // Gradual scroll with wiggle to trigger lazy loading
      if (uniqueLinks.length > 0) {
        uniqueLinks[uniqueLinks.length - 1].el.scrollIntoView({ block: 'end', behavior: 'smooth' });
        await sleep(800);
      }

      // Aggressive scroll
      feed.scrollTop = feed.scrollHeight;
      await sleep(500);
      feed.scrollTop -= 200;
      await sleep(300);
      feed.scrollTop += 300;
      await sleep(300);
      feed.scrollTop = feed.scrollHeight;

      await sleep(3000); // Wait for new results to render

      // Check for "end of results" indicators
      const endOfList = feed.querySelector('.HlvSq') ||
                        feed.querySelector('span.HlvSq') ||
                        feed.textContent.includes("You've reached the end");

      const newHeight = feed.scrollHeight;
      const newLinks = feed.querySelectorAll('a[href*="/maps/place/"]').length;

      if (newHeight === prevHeight && newLinks <= prevCount) {
        consecutiveScrollFails++;
        logToDashboard(`Scroll attempt ${consecutiveScrollFails}/5 — no new results.`, 'system');

        if (consecutiveScrollFails >= 5 || endOfList) {
          logToDashboard(`✅ Reached end of results. Total: ${totalScrapedThisSession} leads extracted.`, 'success');
          sendFinished();
          isScraping = false;
          break;
        }
      } else {
        consecutiveScrollFails = 0;
        logToDashboard(`New results loaded (${newLinks} total visible).`, 'system');
      }
      continue;
    }

    // Reset scroll fail counter since we found a new link
    consecutiveScrollFails = 0;

    // ---- 7. Click the business card ----
    const linkEl = nextLink.el;
    const placeId = nextLink.placeId;

    // Scroll the card into view within the feed
    linkEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(700);

    // Extract card name from the list (always accurate)
    let cardName = '';
    const cardEl = linkEl.closest('div.Nv2PK') || linkEl.closest('div[jsaction]') || linkEl;
    const nameEl = cardEl.querySelector('.qBF1Pd') || cardEl.querySelector('.fontHeadlineSmall') ||
                   cardEl.querySelector('.NrDZNb');
    if (nameEl) cardName = nameEl.textContent.trim();

    logToDashboard(`📍 Opening: "${cardName || 'Business'}" [${currentCount + 1}/${targetLimit}]...`, 'system');

    // Click the card
    try { linkEl.click(); } catch (e) { try { linkEl.parentElement.click(); } catch (e2) {} }

    // ---- 8. Wait for details panel to fully load ----
    let loaded = false;
    const clickTime = Date.now();

    while (Date.now() - clickTime < 8000) {
      const panel = getDetailsPanel();
      if (panel) {
        const title = getName(panel, '');
        if (title && title !== 'Results' && !title.toLowerCase().includes('results for')) {
          loaded = true;
          break;
        }
      }
      await sleep(300);
    }

    if (!loaded) {
      logToDashboard(`⚠️ Details panel didn't load for "${cardName}". Skipping.`, 'warning');
      scrapedUrls.add(placeId); // Mark as done to prevent re-clicking
      // Navigate back before continuing
      await navigateBackToResults();
      await waitForFeed(8000);
      continue;
    }

    // Extra stabilization delay based on user speed setting
    await sleep(Math.max(800, delayMs - 1000));

    // ---- 9. Extract ALL business details ----
    try {
      const leadData = await scrapeCurrentPlace(cardName);
      scrapedUrls.add(placeId);

      const updatedCount = currentCount + 1;
      await chrome.storage.local.set({ scrapedCount: updatedCount });

      sendLeadToDashboard(leadData);
      sendProgress(updatedCount, targetLimit);
      totalScrapedThisSession++;

      logToDashboard(`✅ Extracted: "${leadData.name}" [${updatedCount}/${targetLimit}]`, 'success');
    } catch (err) {
      logToDashboard(`❌ Error scraping "${cardName}": ${err.message}`, 'error');
      scrapedUrls.add(placeId); // Mark to prevent infinite retry
    }

    // ---- 10. CRITICAL: Navigate BACK to search results ----
    logToDashboard('↩️ Returning to results list...', 'system');
    const backSuccess = await navigateBackToResults();

    if (!backSuccess) {
      logToDashboard('Back navigation failed. Attempting full recovery...', 'warning');
      const recoveredFeed = await waitForFeed(12000);
      if (!recoveredFeed && searchUrl) {
        logToDashboard('Recovering via direct search URL...', 'warning');
        window.location.href = searchUrl;
        await sleep(6000);
      }
    } else {
      // Wait for feed to stabilize after navigation
      await sleep(1500);
    }

    // ---- 11. Check for pause ----
    const pauseCheck = await chrome.storage.local.get(['isScrapingActive']);
    if (pauseCheck.isScrapingActive === false) {
      logToDashboard('Scraping paused.', 'warning');
      isScraping = false;
      break;
    }

    // Short breather between items
    await sleep(800);
  }

  logToDashboard(`📊 Session complete. ${totalScrapedThisSession} leads extracted this run.`, 'success');
}

// ==================== MESSAGE LISTENER ====================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'START_SCRAPING') {
    if (!isScraping) {
      isScraping = true;
      delayMs = request.delayMs || 3000;
      targetLimit = request.targetLimit || 100;

      if (request.isNewRun) scrapedUrls.clear();

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
    logToDashboard('Pause request received.', 'warning');
    sendResponse({ status: 'pausing' });
  }
  else if (request.action === 'PING_CONTENT') {
    sendResponse({ status: 'alive', isScraping });
  }
  return true;
});

// Notify the dashboard that the content script has loaded
chrome.runtime.sendMessage({ action: 'MAPS_TAB_LOADED' });
