// Maps Lead Scraper - Dashboard Logic

let leads = [];
let isScrapingActive = false;
let currentSearch = '';

// DOM Elements
const elKeyword = document.getElementById('dash-keyword');
const elCity = document.getElementById('dash-city');
const elLimit = document.getElementById('dash-limit');
const elSpeed = document.getElementById('dash-speed');

const btnStart = document.getElementById('btn-start');
const btnPause = document.getElementById('btn-pause');
const btnStop = document.getElementById('btn-stop');
const btnExport = document.getElementById('btn-export-csv');
const btnClear = document.getElementById('btn-clear-data');

const statLeads = document.getElementById('stat-leads');
const statPhones = document.getElementById('stat-phones');
const statWebsites = document.getElementById('stat-websites');
const statRating = document.getElementById('stat-rating');

const progressPercentageLabel = document.getElementById('progress-percentage-label');
const progressCountLabel = document.getElementById('progress-count-label');
const progressBar = document.getElementById('progress-bar');

const tableBody = document.getElementById('leads-table-body');
const tableSearch = document.getElementById('table-search');
const logConsole = document.getElementById('log-console');
const statusTitle = document.getElementById('scraping-status-title');
const targetTxt = document.getElementById('scraping-target-txt');

// Page Init
document.addEventListener('DOMContentLoaded', () => {
  // Register dashboard tab with background worker
  chrome.runtime.sendMessage({ action: 'REGISTER_DASHBOARD' }, (res) => {
    writeLog('Dashboard registered with service worker.', 'system');
  });

  // Check for saved config and autostart trigger
  chrome.storage.local.get([
    'lastKeyword', 
    'lastCity', 
    'lastLimit', 
    'startScrapeImmediately',
    'scrapedLeadsData'
  ], (result) => {
    if (result.lastKeyword) elKeyword.value = result.lastKeyword;
    if (result.lastCity) elCity.value = result.lastCity;
    if (result.lastLimit) elLimit.value = result.lastLimit;
    
    // Load previously scraped leads if any
    if (result.scrapedLeadsData && result.scrapedLeadsData.length > 0) {
      leads = result.scrapedLeadsData;
      updateStats();
      renderTable();
      btnExport.disabled = false;
      writeLog(`Loaded ${leads.length} leads from previous session.`, 'system');
    }
    
    // Autostart if launched from popup
    if (result.startScrapeImmediately) {
      // Clear flag so it doesn't trigger on manual reload
      chrome.storage.local.remove('startScrapeImmediately');
      writeLog('Autostart signal received from popup.', 'system');
      setTimeout(() => {
        startScraping(true); // new run
      }, 500);
    }
  });

  // Event Listeners
  btnStart.addEventListener('click', () => startScraping(true));
  btnPause.addEventListener('click', togglePause);
  btnStop.addEventListener('click', stopScraping);
  btnExport.addEventListener('click', exportCSV);
  btnClear.addEventListener('click', clearData);
  tableSearch.addEventListener('input', handleSearch);
});

// Write to Log Console
function writeLog(message, type = 'system') {
  const date = new Date();
  const timestamp = date.toTimeString().split(' ')[0];
  
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span style="color: #64748b; font-size: 10px;">[${timestamp}]</span> ${message}`;
  
  logConsole.appendChild(entry);
  logConsole.scrollTop = logConsole.scrollHeight;
}

// Update Stats Cards
function updateStats() {
  statLeads.textContent = leads.length;
  
  const phonesCount = leads.filter(l => l.phone).length;
  statPhones.textContent = phonesCount;
  
  const websCount = leads.filter(l => l.website).length;
  statWebsites.textContent = websCount;
  
  const ratedLeads = leads.filter(l => l.rating > 0);
  if (ratedLeads.length > 0) {
    const avg = ratedLeads.reduce((acc, curr) => acc + curr.rating, 0) / ratedLeads.length;
    statRating.textContent = avg.toFixed(1);
  } else {
    statRating.textContent = '0.0';
  }
}

// Render the Leads Data Table
function renderTable() {
  // Filter leads based on search term
  const filtered = leads.filter(lead => {
    const q = currentSearch.toLowerCase();
    return (
      (lead.name && lead.name.toLowerCase().includes(q)) ||
      (lead.category && lead.category.toLowerCase().includes(q)) ||
      (lead.phone && lead.phone.toLowerCase().includes(q)) ||
      (lead.address && lead.address.toLowerCase().includes(q)) ||
      (lead.website && lead.website.toLowerCase().includes(q))
    );
  });

  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="8">${leads.length === 0 ? 'No leads scraped yet. Click "Start Extracting" to begin.' : 'No matching records found.'}</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = filtered.map((lead, idx) => {
    const websiteCell = lead.website 
      ? `<a href="${lead.website}" target="_blank" style="color: var(--accent-blue); text-decoration: none;">Link ↗</a>` 
      : '<span style="color: var(--text-secondary);">--</span>';
      
    const phoneCell = lead.phone 
      ? `<span style="font-weight: 500;">${lead.phone}</span>` 
      : '<span style="color: var(--text-secondary);">--</span>';
      
    return `
      <tr>
        <td style="color: var(--accent-blue); font-weight: 600;">${idx + 1}</td>
        <td style="font-weight: 600;" title="${lead.name || ''}">${lead.name || 'Unknown'}</td>
        <td><span class="badge" style="background: rgba(255,255,255,0.05); color: var(--text-primary); border: 1px solid var(--border-color);">${lead.category || '--'}</span></td>
        <td>${phoneCell}</td>
        <td>${websiteCell}</td>
        <td style="color: var(--color-warning); font-weight: 600;">★ ${lead.rating ? lead.rating.toFixed(1) : '0.0'}</td>
        <td style="color: var(--text-secondary);">${lead.reviews || 0}</td>
        <td title="${lead.address || ''}">${lead.address || '--'}</td>
      </tr>
    `;
  }).join('');
}

// Search filter
function handleSearch(e) {
  currentSearch = e.target.value;
  renderTable();
}

// Map Speeds to Miliseconds
function getDelayMs(speed) {
  switch (speed) {
    case 'fast': return 800;
    case 'medium': return 1500;
    case 'safe':
    default: return 3000;
  }
}

// Start Scrape Process
async function startScraping(isNewRun = true) {
  const keyword = elKeyword.value.trim();
  const city = elCity.value.trim();
  const limit = parseInt(elLimit.value, 10) || 100;
  const speed = elSpeed.value;
  
  if (!keyword || !city) {
    writeLog('Error: Keyword and City are required to start.', 'error');
    alert('Please fill in both Keyword and City fields.');
    return;
  }

  isScrapingActive = true;
  
  // Save search parameters to storage
  await chrome.storage.local.set({
    lastKeyword: keyword,
    lastCity: city,
    lastLimit: limit,
    isScrapingActive: true,
    scrapedCount: isNewRun ? 0 : leads.length,
    targetLimit: limit,
    delayMs: getDelayMs(speed)
  });

  if (isNewRun) {
    leads = [];
    await chrome.storage.local.remove('scrapedLeadsData');
    updateStats();
    renderTable();
    updateProgress(0, limit);
    writeLog(`Starting new scrape: "${keyword}" in "${city}" (Target: ${limit} leads)`, 'system');
  } else {
    writeLog(`Resuming scrape: "${keyword}" in "${city}"`, 'system');
  }

  // Update UI Elements
  statusTitle.textContent = 'Status: Scraping...';
  statusTitle.style.color = 'var(--accent-blue)';
  targetTxt.textContent = `Scraping: "${keyword}" in "${city}"`;
  
  btnStart.disabled = true;
  btnPause.disabled = false;
  btnPause.querySelector('span').textContent = 'Pause';
  btnStop.disabled = false;
  btnExport.disabled = true;
  
  // Lock inputs
  elKeyword.disabled = true;
  elCity.disabled = true;
  elLimit.disabled = true;
  elSpeed.disabled = true;

  // 1. Tell background service worker to open Maps tab with search query
  const query = `${keyword} in ${city}`;
  chrome.runtime.sendMessage({
    action: 'START_SCRAPING_TAB',
    query: query
  }, (response) => {
    writeLog('Google Maps tab requested. Waiting for content script to link...', 'system');
    
    // We send a start signal to the content script in case it was already open and loaded
    setTimeout(() => {
      triggerContentScript(isNewRun, limit, getDelayMs(speed));
    }, 2500);
  });
}

// Trigger content script inside Maps tab
function triggerContentScript(isNewRun, limit, delay) {
  // Query for the Maps tab
  chrome.tabs.query({ url: 'https://www.google.com/maps/*' }, (tabs) => {
    if (tabs.length > 0) {
      const mapsTab = tabs[0];
      chrome.tabs.sendMessage(mapsTab.id, {
        action: 'START_SCRAPING',
        isNewRun: isNewRun,
        targetLimit: limit,
        delayMs: delay
      }, (response) => {
        if (chrome.runtime.lastError) {
          // If content script is not loaded yet, background autostart will handle it when it loads.
          writeLog('Maps tab found. Scraper will initiate automatically upon page load.', 'system');
        } else if (response && response.status === 'started') {
          writeLog('Scraper connected and active in Maps tab.', 'success');
        }
      });
    } else {
      writeLog('Waiting for Google Maps tab to open...', 'system');
    }
  });
}

// Pause/Resume Scrape Process
async function togglePause() {
  if (!isScrapingActive) return;
  
  const isPaused = btnPause.querySelector('span').textContent === 'Resume';
  
  if (!isPaused) {
    // We want to pause
    writeLog('Pausing scraper... Waiting for current item to finish...', 'warning');
    
    await chrome.storage.local.set({ isScrapingActive: false });
    
    // Message content script to stop
    chrome.tabs.query({ url: 'https://www.google.com/maps/*' }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'PAUSE_SCRAPING' });
      }
    });
    
    statusTitle.textContent = 'Status: Paused';
    statusTitle.style.color = 'var(--color-warning)';
    btnPause.querySelector('span').textContent = 'Resume';
    btnStart.disabled = true;
  } else {
    // We want to resume
    btnPause.querySelector('span').textContent = 'Pause';
    startScraping(false); // Resume (isNewRun = false)
  }
}

// Stop Scrape Process
async function stopScraping() {
  writeLog('Stopping scraper and closing Google Maps...', 'warning');
  isScrapingActive = false;
  
  await chrome.storage.local.set({ isScrapingActive: false });
  
  // Close Maps tab via Background
  chrome.runtime.sendMessage({ action: 'CLOSE_MAPS_TAB' });
  
  // Reset UI
  statusTitle.textContent = 'Status: Stopped';
  statusTitle.style.color = 'var(--color-danger)';
  
  btnStart.disabled = false;
  btnPause.disabled = true;
  btnPause.querySelector('span').textContent = 'Pause';
  btnStop.disabled = true;
  if (leads.length > 0) btnExport.disabled = false;
  
  // Unlock inputs
  elKeyword.disabled = false;
  elCity.disabled = false;
  elLimit.disabled = false;
  elSpeed.disabled = false;
}

// Update Progress bar
function updateProgress(current, target) {
  const percent = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
  progressBar.style.width = `${percent}%`;
  progressPercentageLabel.textContent = `Scrape Progress: ${percent}%`;
  progressCountLabel.textContent = `${current} / ${target} Leads`;
}

// Clear Data
async function clearData() {
  if (isScrapingActive) {
    alert('Please stop the scraper before clearing data.');
    return;
  }
  
  if (confirm('Are you sure you want to clear all scraped leads?')) {
    leads = [];
    await chrome.storage.local.remove('scrapedLeadsData');
    updateStats();
    renderTable();
    updateProgress(0, 0);
    btnExport.disabled = true;
    statusTitle.textContent = 'Status: Ready';
    statusTitle.style.color = 'var(--text-primary)';
    targetTxt.textContent = 'No active search';
    writeLog('Database cleared. Ready for next run.', 'system');
  }
}

// Export to CSV
function exportCSV() {
  if (leads.length === 0) {
    writeLog('No leads available to export.', 'error');
    return;
  }
  
  writeLog(`Generating CSV for ${leads.length} leads...`, 'system');
  
  try {
    const headers = [
      'Name', 
      'Category', 
      'Rating', 
      'Reviews', 
      'Address', 
      'Phone', 
      'Website', 
      'Google Maps URL', 
      'Latitude', 
      'Longitude', 
      'Plus Code'
    ];
    
    const csvRows = [headers.join(',')];
    
    for (const lead of leads) {
      const row = [
        lead.name || '',
        lead.category || '',
        lead.rating || '0',
        lead.reviews || '0',
        lead.address || '',
        lead.phone || '',
        lead.website || '',
        lead.mapsUrl || '',
        lead.lat || '',
        lead.lng || '',
        lead.plusCode || ''
      ];
      
      // Escape columns with double quotes and handle existing double quotes
      const escapedRow = row.map(val => {
        const str = String(val).replace(/"/g, '""'); // Double up internal quotes
        return `"${str}"`;
      }).join(',');
      
      csvRows.push(escapedRow);
    }
    
    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    // Generate filename based on keyword and city
    const keyword = elKeyword.value.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'leads';
    const city = elCity.value.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'map';
    const filename = `gmaps_leads_${keyword}_${city}.csv`;
    
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    writeLog(`CSV exported successfully: "${filename}"`, 'success');
  } catch (err) {
    writeLog(`Export failed: ${err.message}`, 'error');
  }
}

// Message Listener for Incoming Messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'LOG_TO_DASHBOARD') {
    writeLog(request.message, request.type);
  }
  
  else if (request.action === 'LEAD_SCRAPED') {
    const newLead = request.lead;
    
    // Prevent duplicate entries in table
    const exists = leads.some(l => l.mapsUrl === newLead.mapsUrl);
    if (!exists) {
      leads.push(newLead);
      
      // Save to local storage cache so it persists refreshes
      chrome.storage.local.set({ scrapedLeadsData: leads });
      
      updateStats();
      renderTable();
    }
  }
  
  else if (request.action === 'SCRAPING_PROGRESS') {
    updateProgress(request.current, request.target);
  }
  
  else if (request.action === 'SCRAPING_FINISHED') {
    writeLog('Scraping session completed successfully!', 'success');
    isScrapingActive = false;
    
    statusTitle.textContent = 'Status: Completed';
    statusTitle.style.color = 'var(--color-success)';
    
    btnStart.disabled = false;
    btnPause.disabled = true;
    btnStop.disabled = true;
    if (leads.length > 0) btnExport.disabled = false;
    
    // Unlock inputs
    elKeyword.disabled = false;
    elCity.disabled = false;
    elLimit.disabled = false;
    elSpeed.disabled = false;
    
    // Close Google Maps tab automatically on complete
    chrome.runtime.sendMessage({ action: 'CLOSE_MAPS_TAB' });
  }
  
  else if (request.action === 'MAPS_TAB_CLOSED') {
    if (isScrapingActive) {
      writeLog('Warning: Google Maps tab was closed. Scraping stopped.', 'error');
      stopScraping();
    }
  }
  
  sendResponse({ status: 'received' });
  return true;
});
