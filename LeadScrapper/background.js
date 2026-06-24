// Background Service Worker for Maps Lead Scraper
let mapsTabId = null;
let dashboardTabId = null;

// Keep track of the dashboard tab
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'REGISTER_DASHBOARD') {
    dashboardTabId = sender.tab ? sender.tab.id : null;
    sendResponse({ status: 'registered' });
  }
  
  else if (message.action === 'START_SCRAPING_TAB') {
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(message.query)}/`;
    
    // Check if we already have an open maps tab
    if (mapsTabId) {
      chrome.tabs.update(mapsTabId, { url: searchUrl, active: false }, (tab) => {
        if (chrome.runtime.lastError) {
          // Tab was closed, create a new one
          createNewMapsTab(searchUrl);
        }
      });
    } else {
      createNewMapsTab(searchUrl);
    }
    sendResponse({ status: 'opening' });
  }
  
  else if (message.action === 'CLOSE_MAPS_TAB') {
    if (mapsTabId) {
      chrome.tabs.remove(mapsTabId, () => {
        // Ignore error if tab already closed
        chrome.runtime.lastError;
      });
      mapsTabId = null;
    }
    sendResponse({ status: 'closed' });
  }
  
  // Forward messages from content script to dashboard
  else if (message.action === 'LOG_TO_DASHBOARD' || 
           message.action === 'LEAD_SCRAPED' || 
           message.action === 'SCRAPING_PROGRESS' || 
           message.action === 'SCRAPING_FINISHED') {
    
    if (dashboardTabId) {
      chrome.tabs.sendMessage(dashboardTabId, message, (response) => {
        // If sending fails (e.g. dashboard closed), ignore error
        if (chrome.runtime.lastError) {
          // Dashboard might have been closed or reloaded
        }
      });
    }
  }
  
  return true; // Keeps channel open for async response
});

// Helper to create a new Maps tab
function createNewMapsTab(url) {
  chrome.tabs.create({ url: url, active: false }, (tab) => {
    mapsTabId = tab.id;
  });
}

// Clean up references when tabs are closed
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (tabId === mapsTabId) {
    mapsTabId = null;
    // Notify dashboard that the maps tab was closed
    if (dashboardTabId) {
      chrome.tabs.sendMessage(dashboardTabId, { action: 'MAPS_TAB_CLOSED' }, () => {
        if (chrome.runtime.lastError) {}
      });
    }
  }
  if (tabId === dashboardTabId) {
    dashboardTabId = null;
  }
});
