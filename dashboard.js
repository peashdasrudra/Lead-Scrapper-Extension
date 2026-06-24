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
const statNoWebsite = document.getElementById('stat-no-website');
const statInsecureWebsite = document.getElementById('stat-insecure-website');
const statUnclaimedProfiles = document.getElementById('stat-unclaimed-profiles');
const statHighValue = document.getElementById('stat-high-value');

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
  
  // Table row click delegation
  tableBody.addEventListener('click', (e) => {
    const row = e.target.closest('.lead-row');
    if (row) {
      const idx = parseInt(row.getAttribute('data-idx'), 10);
      if (!isNaN(idx)) selectLead(idx);
    }
  });
  btnExport.addEventListener('click', exportCSV);
  btnClear.addEventListener('click', clearData);
  tableSearch.addEventListener('input', handleSearch);
});

let lastLogText = '';
let lastLogTime = 0;

// Write to Log Console
function writeLog(message, type = 'system') {
  const now = Date.now();
  // De-duplicate identical logs arriving within 500ms
  if (message === lastLogText && (now - lastLogTime < 500)) {
    return;
  }
  lastLogText = message;
  lastLogTime = now;

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

  // Sales Intelligence Stats Aggregates
  const noWebCount = leads.filter(l => !l.website).length;
  statNoWebsite.textContent = noWebCount;

  const insecureWebCount = leads.filter(l => l.website && (l.isWebsiteSecure === 'Insecure (HTTP)' || l.isWebsiteSecure === 'Insecure (HTTP ⚠️)')).length;
  statInsecureWebsite.textContent = insecureWebCount;

  const unclaimedCount = leads.filter(l => l.claimedStatus === 'Unclaimed').length;
  statUnclaimedProfiles.textContent = unclaimedCount;

  const highValueCount = leads.filter(l => calculateOpportunityScore(l) >= 75).length;
  statHighValue.textContent = highValueCount;
}

// Calculate Sales Opportunity Score (0-100) for a lead (tailored for selling website/GMB services)
function calculateOpportunityScore(lead) {
  let score = 0;
  
  // 1. Website Opportunity (Max 40 pts)
  if (!lead.website) {
    score += 40; // No website (ultimate website sale opportunity!)
  } else if (lead.isWebsiteSecure === 'Insecure (HTTP)' || lead.isWebsiteSecure === 'Insecure (HTTP ⚠️)') {
    score += 20; // Insecure SSL needs security upgrade or redesign
  }
  
  // 2. Profile Claimed Status (Max 25 pts)
  if (lead.claimedStatus === 'Unclaimed') {
    score += 25; // Unclaimed Google Business Profile is a major local SEO opportunity
  }
  
  // 3. Online Reviews / Reputation (Max 20 pts)
  if (lead.rating > 0 && lead.rating < 4.0) {
    score += 15; // Low rating needs review generation
  }
  if (lead.reviews > 0 && lead.reviews < 10) {
    score += 10; // Low reviews count needs reputation management
  }
  
  // 4. Social Media presence (Max 15 pts)
  let missingSocials = 0;
  if (!lead.facebook) missingSocials++;
  if (!lead.instagram) missingSocials++;
  if (!lead.linkedin) missingSocials++;
  score += missingSocials * 5; // +5 pts for each missing major social profile
  
  return Math.min(100, score);
}

// Render the Leads Data Table
function renderTable() {
  // Filter leads based on search term
  const filtered = leads.filter(lead => {
    const q = currentSearch.toLowerCase();
    const score = calculateOpportunityScore(lead);
    const scoreText = score >= 75 ? 'hot' : (score >= 40 ? 'warm' : 'cold');
    return (
      (lead.name && lead.name.toLowerCase().includes(q)) ||
      (lead.category && lead.category.toLowerCase().includes(q)) ||
      (lead.phone && lead.phone.toLowerCase().includes(q)) ||
      (lead.address && lead.address.toLowerCase().includes(q)) ||
      (lead.website && lead.website.toLowerCase().includes(q)) ||
      (lead.claimedStatus && lead.claimedStatus.toLowerCase().includes(q)) ||
      (lead.isWebsiteSecure && lead.isWebsiteSecure.toLowerCase().includes(q)) ||
      scoreText.includes(q) ||
      score.toString().includes(q)
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
    // Website Security and Link Cell
    let websiteCell = '';
    if (lead.website) {
      if (lead.isWebsiteSecure === 'Secure (HTTPS)') {
        websiteCell = `<a href="${lead.website}" target="_blank" style="color: var(--color-success); text-decoration: none; font-weight: 500;" title="Secure Website">Link ↗ <span style="font-size: 9px; opacity: 0.85;">(Secure)</span></a>`;
      } else {
        websiteCell = `<a href="${lead.website}" target="_blank" style="color: var(--color-warning); text-decoration: none; font-weight: 500;" title="Insecure Website - Good Pitch Target!">Link ↗ <span style="font-size: 9px; opacity: 0.9;">(HTTP ⚠️)</span></a>`;
      }
    } else {
      websiteCell = '<span style="color: var(--color-danger); font-weight: 600; font-size: 10.5px;">No Website ❌</span>';
    }
      
    const phoneCell = lead.phone 
      ? `<span style="font-weight: 500;">${lead.phone}</span>` 
      : '<span style="color: var(--text-secondary);">--</span>';
      
    // Claimed Status Badge next to name
    let claimedBadge = '';
    if (lead.claimedStatus === 'Unclaimed') {
      claimedBadge = `<span style="font-size: 8.5px; padding: 1.5px 5px; background: rgba(239, 68, 68, 0.15); color: var(--color-danger); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 4px; margin-left: 6px; font-weight: 700; letter-spacing: 0.25px;" title="Unclaimed Profile - High Value Lead!">UNCLAIMED</span>`;
    }
      
    // Calculate Opportunity Score & Badge
    const score = calculateOpportunityScore(lead);
    let scoreBadge = '';
    if (score >= 75) {
      scoreBadge = `<span style="padding: 4px 10px; background: rgba(239, 68, 68, 0.12); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 20px; font-weight: 700; font-size: 11px;" title="Hot Prospect - High opportunity to sell websites!">🔥 ${score} (Hot)</span>`;
    } else if (score >= 40) {
      scoreBadge = `<span style="padding: 4px 10px; background: rgba(245, 158, 11, 0.1); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 20px; font-weight: 700; font-size: 11px;" title="Warm Prospect - Good target for outreach.">⚡ ${score} (Warm)</span>`;
    } else {
      scoreBadge = `<span style="padding: 4px 10px; background: rgba(0, 210, 255, 0.08); color: var(--accent-blue); border: 1px solid rgba(0, 210, 255, 0.18); border-radius: 20px; font-weight: 700; font-size: 11px;" title="Cold Prospect - Already has secure website & claimed profile.">❄️ ${score} (Cold)</span>`;
    }

    // Combine Rating and Reviews Count
    const ratingReviewsStr = lead.rating > 0 
      ? `<span style="color: var(--color-warning); font-weight: 600;">★ ${lead.rating.toFixed(1)}</span> <span style="color: var(--text-secondary); font-size: 11.5px;">(${lead.reviews || 0})</span>`
      : '<span style="color: var(--text-secondary);">No ratings</span>';

    return `
      <tr class="lead-row" data-idx="${idx}" style="cursor: pointer; transition: background-color 0.2s;">
        <td style="color: var(--accent-blue); font-weight: 600;">${idx + 1}</td>
        <td style="font-weight: 600;" title="${lead.name || ''}">
          <div style="display: flex; align-items: center; gap: 4px; max-width: 100%; overflow: hidden;">
            <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${lead.name || 'Unknown'}</span>
            ${claimedBadge}
          </div>
        </td>
        <td><span class="badge" style="background: rgba(255,255,255,0.04); color: var(--text-primary); border: 1px solid var(--border-color);">${lead.category || '--'}</span></td>
        <td>${phoneCell}</td>
        <td>${websiteCell}</td>
        <td>${ratingReviewsStr}</td>
        <td>${scoreBadge}</td>
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
    writeLog('Google Maps tab requested. Waiting for page to load...', 'system');
    
    // Check if the tab is already open and loaded
    setTimeout(() => {
      chrome.tabs.query({ url: 'https://www.google.com/maps/*' }, (tabs) => {
        if (tabs.length > 0) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'PING_CONTENT' }, (pingRes) => {
            if (chrome.runtime.lastError) {
              // Not loaded yet, will be triggered by MAPS_TAB_LOADED
            } else if (pingRes && pingRes.status === 'alive') {
              writeLog('Content script already active. Initiating scraper...', 'success');
              chrome.tabs.sendMessage(tabs[0].id, {
                action: 'START_SCRAPING',
                isNewRun: isNewRun,
                targetLimit: limit,
                delayMs: getDelayMs(speed)
              });
            }
          });
        }
      });
    }, 500); // Small delay to let tab update if redirecting
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
      'Is Website Secure',
      'Claimed Status',
      'Opportunity Score',
      'Prospect Tier',
      'Facebook',
      'Instagram',
      'LinkedIn',
      'Twitter',
      'YouTube',
      'Latitude', 
      'Longitude', 
      'Google Maps URL', 
      'Plus Code',
      'Business Hours',
      'Price Level',
      'Open Status',
      'Service Options'
    ];
    
    const csvRows = [headers.join(',')];
    
    for (const lead of leads) {
      const score = calculateOpportunityScore(lead);
      const tier = score >= 75 ? 'Hot' : (score >= 40 ? 'Warm' : 'Cold');
      
      const row = [
        lead.name || '',
        lead.category || '',
        lead.rating || '0',
        lead.reviews || '0',
        lead.address || '',
        lead.phone || '',
        lead.website || '',
        lead.isWebsiteSecure || '',
        lead.claimedStatus || '',
        score.toString(),
        tier,
        lead.facebook || '',
        lead.instagram || '',
        lead.linkedin || '',
        lead.twitter || '',
        lead.youtube || '',
        lead.lat || '',
        lead.lng || '',
        lead.mapsUrl || '',
        lead.plusCode || '',
        lead.businessHours || '',
        lead.priceLevel || '',
        lead.openStatus || '',
        lead.serviceOptions || ''
      ];
      
      // Escape columns with double quotes and handle existing double quotes
      const escapedRow = row.map(val => {
        const str = String(val).replace(/"/g, '""'); // Double up internal quotes
        return `"${str}"`;
      }).join(',');
      
      csvRows.push(escapedRow);
    }
    
    // Crucial: Prepend the UTF-8 BOM (\uFEFF) to make Excel load UTF-8 encoding properly!
    const csvContent = '\uFEFF' + csvRows.join('\n');
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
    
    // Prevent duplicate entries in table using a robust name+phone or clean URL comparison
    const exists = leads.some(l => 
      (l.mapsUrl && l.mapsUrl.split('?')[0] === newLead.mapsUrl.split('?')[0]) || 
      (l.name.toLowerCase().trim() === newLead.name.toLowerCase().trim() && l.phone && l.phone === newLead.phone)
    );
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
  
  else if (request.action === 'MAPS_TAB_LOADED') {
    if (isScrapingActive) {
      // Cooldown check (1.5 seconds) to prevent parallel scraper loops from launching
      const now = Date.now();
      if (window.lastConnectTime && (now - window.lastConnectTime < 1500)) {
        return;
      }
      window.lastConnectTime = now;

      writeLog('Google Maps tab loaded. Connecting scraper...', 'success');
      
      const keyword = elKeyword.value.trim();
      const city = elCity.value.trim();
      const limit = parseInt(elLimit.value, 10) || 100;
      const speed = elSpeed.value;
      
      chrome.tabs.query({ url: 'https://www.google.com/maps/*' }, (tabs) => {
        if (tabs.length > 0) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'START_SCRAPING',
            isNewRun: leads.length === 0, // New run if we have no leads, otherwise resume
            targetLimit: limit,
            delayMs: getDelayMs(speed)
          });
        }
      });
    }
  }
  
  sendResponse({ status: 'received' });
  return true;
});

let selectedLeadIndex = null;

// Select a lead from the table and generate a custom website sales pitch
window.selectLead = function(idx) {
  selectedLeadIndex = idx;
  const lead = leads[idx];
  if (!lead) return;
  
  // Highlight selected row in table
  const rows = tableBody.querySelectorAll('tr');
  rows.forEach((row, rIdx) => {
    if (rIdx === idx) {
      row.style.backgroundColor = 'rgba(0, 210, 255, 0.08)';
      row.style.borderLeft = '3px solid var(--accent-blue)';
    } else {
      row.style.backgroundColor = 'transparent';
      row.style.borderLeft = 'none';
    }
  });

  // Show pitch panel details
  pitchDefaultMsg.style.display = 'none';
  pitchDetails.style.display = 'flex';
  
  // Set lead name
  pitchLeadName.textContent = lead.name;
  
  // Set badges
  // Website badge
  if (lead.website) {
    badgePitchWeb.textContent = lead.isWebsiteSecure === 'Secure (HTTPS)' ? 'Secure (HTTPS)' : 'Insecure (HTTP)';
    badgePitchWeb.style.background = lead.isWebsiteSecure === 'Secure (HTTPS)' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)';
    badgePitchWeb.style.color = lead.isWebsiteSecure === 'Secure (HTTPS)' ? 'var(--color-success)' : 'var(--color-warning)';
    badgePitchWeb.style.borderColor = lead.isWebsiteSecure === 'Secure (HTTPS)' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)';
  } else {
    badgePitchWeb.textContent = 'No Website';
    badgePitchWeb.style.background = 'rgba(239, 68, 68, 0.15)';
    badgePitchWeb.style.color = 'var(--color-danger)';
    badgePitchWeb.style.borderColor = 'rgba(239, 68, 68, 0.3)';
  }
  
  // Claimed badge
  if (lead.claimedStatus === 'Unclaimed') {
    badgePitchClaimed.textContent = 'Unclaimed';
    badgePitchClaimed.style.background = 'rgba(239, 68, 68, 0.15)';
    badgePitchClaimed.style.color = 'var(--color-danger)';
    badgePitchClaimed.style.borderColor = 'rgba(239, 68, 68, 0.3)';
  } else {
    badgePitchClaimed.textContent = 'Claimed';
    badgePitchClaimed.style.background = 'rgba(16, 185, 129, 0.15)';
    badgePitchClaimed.style.color = 'var(--color-success)';
    badgePitchClaimed.style.borderColor = 'rgba(16, 185, 129, 0.3)';
  }
  
  // Score badge
  const score = calculateOpportunityScore(lead);
  badgePitchScore.textContent = `Score: ${score}`;
  badgePitchScore.style.background = score >= 75 ? 'rgba(239, 68, 68, 0.15)' : (score >= 40 ? 'rgba(245, 158, 11, 0.15)' : 'rgba(0, 210, 255, 0.15)');
  badgePitchScore.style.color = score >= 75 ? 'var(--color-danger)' : (score >= 40 ? 'var(--color-warning)' : 'var(--accent-blue)');
  badgePitchScore.style.borderColor = score >= 75 ? 'rgba(239, 68, 68, 0.3)' : (score >= 40 ? 'rgba(245, 158, 11, 0.3)' : 'rgba(0, 210, 255, 0.3)');

  // Select the best template automatically
  if (!lead.website) {
    pitchTemplateSelect.value = 'no-website';
  } else if (lead.isWebsiteSecure === 'Insecure (HTTP)' || lead.isWebsiteSecure === 'Insecure (HTTP ⚠️)') {
    pitchTemplateSelect.value = 'insecure-ssl';
  } else if (lead.claimedStatus === 'Unclaimed') {
    pitchTemplateSelect.value = 'unclaimed-profile';
  } else {
    pitchTemplateSelect.value = 'no-website'; // Default
  }
  
  // Generate the pitch
  generatePitchText(lead);
  
  // Switch tab to Pitch
  tabPitch.click();
};

// Generate Sales Email text based on template selection
function generatePitchText(lead) {
  const template = pitchTemplateSelect.value;
  const name = lead.name || 'Business Owner';
  const website = lead.website || '';
  const city = elCity.value || 'your area';
  let subject = '';
  let body = '';
  
  if (template === 'no-website') {
    subject = `Website Proposal for ${name}`;
    body = `Hi ${name} Team,

I hope you're doing well.

I was searching for local services in ${city} on Google Maps and came across your business, "${name}". I noticed that you have a highly-rated business with great potential, but you do not have a website listed on your Google profile.

Over 85% of consumers look up a business online before visiting. Without a website, you are likely losing valuable local customers to competitors in ${city} who have an online presence.

We specialize in building fast, mobile-friendly, and high-converting websites for local businesses. I've already created a quick layout concept tailored to your brand that will help you capture leads directly.

Would you be open to a brief, 5-minute call this week to see the design?

Best regards,

[Your Name]
[Your Agency Name]
[Your Phone Number]`;
  }
  
  else if (template === 'insecure-ssl') {
    subject = `Important security warning for ${website || name}`;
    body = `Hi ${name} Team,

I hope this message finds you well.

I recently found your business on Google Maps and visited your website: ${website}. 

I noticed that your website is currently marked as "Not Secure" by Google Chrome and other major web browsers because it is running on insecure HTTP and lacks an SSL security certificate.

Having an insecure site can severely impact your business:
1. It displays a "Not Secure" warning to visitors, which scares away up to 82% of customers.
2. Google actively penalizes insecure websites, lowering your local search rankings.
3. Customer data entered on your site is vulnerable to interception.

We help local businesses secure and modernize their websites. We can quickly install an SSL certificate for you and ensure your website is fully secure, mobile-friendly, and optimized to boost your rankings and customer trust.

Are you available for a quick chat to discuss securing your website?

Best regards,

[Your Name]
[Your Agency Name]
[Your Phone Number]`;
  }
  
  else if (template === 'unclaimed-profile') {
    subject = `Google Business Profile warning for ${name}`;
    body = `Hi ${name} Team,

I hope you're doing well.

I was searching on Google Maps and found your listing for "${name}". 

I noticed that your Google Business Profile is currently unclaimed. This means that anyone on the internet can suggest incorrect edits, change your business hours, or even claim ownership of your business listing.

Claiming and optimizing your Google listing is the single most effective way to rank higher in local search results and attract more customers in ${city}.

We help local businesses claim, verify, and optimize their Google Business Profiles. We can help you secure your listing, add optimized keywords, and set up a review generation system to dominate local search rankings.

Would you be open to a quick 5-minute chat to discuss securing and optimizing your Google profile?

Best regards,

[Your Name]
[Your Agency Name]
[Your Phone Number]`;
  }
  
  pitchSubjectInput.value = subject;
  pitchBodyInput.value = body;
}
