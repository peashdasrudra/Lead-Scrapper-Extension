// Background Service Worker for Maps Lead Scraper
let mapsWindowId = null;
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
    
    // Open Google Maps in a separate, unfocused window to prevent background tab throttling.
    // This allows the scraper to run at 100% speed while the user stays on the dashboard.
    if (mapsWindowId) {
      chrome.windows.remove(mapsWindowId, () => {
        // Ignore error if window already closed
        chrome.runtime.lastError;
        createNewMapsWindow(searchUrl);
      });
    } else {
      createNewMapsWindow(searchUrl);
    }
    sendResponse({ status: 'opening' });
  }
  
  else if (message.action === 'CLOSE_MAPS_TAB') {
    if (mapsWindowId) {
      chrome.windows.remove(mapsWindowId, () => {
        chrome.runtime.lastError;
      });
      mapsWindowId = null;
      mapsTabId = null;
    }
    sendResponse({ status: 'closed' });
  }
  
  // Forward messages from content script to dashboard
  else if (message.action === 'LOG_TO_DASHBOARD' || 
           message.action === 'LEAD_SCRAPED' || 
           message.action === 'SCRAPING_PROGRESS' || 
           message.action === 'SCRAPING_FINISHED' ||
           message.action === 'MAPS_TAB_LOADED') {
    
    if (dashboardTabId) {
      chrome.tabs.sendMessage(dashboardTabId, message, (response) => {
        if (chrome.runtime.lastError) {
          // Dashboard might have been closed or reloaded
        }
      });
    }
  }
  
  return true; // Keeps channel open for async response
});

// Helper to create a new Maps window (unfocused, so it sits behind the dashboard)
function createNewMapsWindow(url) {
  chrome.windows.create({
    url: url,
    type: 'normal',
    focused: false, // Do NOT steal focus from the dashboard
    width: 950,
    height: 700,
    left: 80,
    top: 80
  }, (window) => {
    mapsWindowId = window.id;
    if (window.tabs && window.tabs.length > 0) {
      mapsTabId = window.tabs[0].id;
    }
  });
}

// Clean up references when windows are closed
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === mapsWindowId) {
    mapsWindowId = null;
    mapsTabId = null;
    // Notify dashboard that the maps window was closed
    if (dashboardTabId) {
      chrome.tabs.sendMessage(dashboardTabId, { action: 'MAPS_TAB_CLOSED' }, () => {
        if (chrome.runtime.lastError) {}
      });
    }
  }
});

// Also monitor if the tab itself is closed inside the window
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (tabId === mapsTabId) {
    mapsTabId = null;
    mapsWindowId = null;
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
