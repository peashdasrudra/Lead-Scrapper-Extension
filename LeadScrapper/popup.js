document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('quick-start-form');
  const keywordInput = document.getElementById('keyword');
  const cityInput = document.getElementById('city');
  const limitInput = document.getElementById('limit');

  // Pre-populate values from storage if they exist
  chrome.storage.local.get(['lastKeyword', 'lastCity', 'lastLimit'], (result) => {
    if (result.lastKeyword) keywordInput.value = result.lastKeyword;
    if (result.lastCity) cityInput.value = result.lastCity;
    if (result.lastLimit) limitInput.value = result.lastLimit;
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const keyword = keywordInput.value.trim();
    const city = cityInput.value.trim();
    const limit = parseInt(limitInput.value, 10) || 100;

    // Save inputs to storage for the dashboard to pick up
    chrome.storage.local.set({
      lastKeyword: keyword,
      lastCity: city,
      lastLimit: limit,
      startScrapeImmediately: true // Signal to the dashboard to start right away
    }, () => {
      // Open the dashboard tab
      chrome.tabs.create({
        url: chrome.runtime.getURL('dashboard.html')
      });
      // Close the popup
      window.close();
    });
  });
});
