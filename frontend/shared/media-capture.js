/**
 * Media capture utilities for screenshots and video recording during replay.
 */

/**
 * Capture a screenshot of the current tab
 * @param {number} tabId - The tab ID to capture
 * @returns {Promise<string|null>} - Base64 encoded screenshot data URL or null
 */
export async function captureScreenshot(tabId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: 'png',
      quality: 90
    });
    return dataUrl;
  } catch (err) {
    console.error('[media-capture] Failed to capture screenshot:', err);
    return null;
  }
}

/**
 * Generate HTML report from screenshots
 * @param {Array<string>} screenshots - Array of base64 screenshot data URLs
 * @param {Object} metadata - Report metadata
 * @returns {Promise<Blob>} - The generated HTML report blob
 */
export async function generateHTMLReport(screenshots, metadata) {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Replay Report - ${escapeHtml(metadata.recordingName || 'Unknown')}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
    }
    .header {
      background: white;
      padding: 20px;
      margin-bottom: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      margin: 0 0 10px 0;
      color: #333;
    }
    .metadata {
      color: #666;
      font-size: 14px;
    }
    .metadata > div {
      margin: 4px 0;
    }
    .screenshot {
      background: white;
      padding: 15px;
      margin-bottom: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      page-break-inside: avoid;
    }
    .screenshot h3 {
      margin: 0 0 10px 0;
      color: #444;
      font-size: 16px;
    }
    .screenshot img {
      width: 100%;
      border: 1px solid #ddd;
      border-radius: 4px;
      cursor: pointer;
    }
    .screenshot img:hover {
      opacity: 0.9;
    }
    .step-info {
      margin-top: 10px;
      padding: 10px;
      background: #f9f9f9;
      border-radius: 4px;
      font-size: 13px;
    }
    .step-info > div {
      margin: 3px 0;
    }
    .status-passed { color: #4CAF50; font-weight: 600; }
    .status-failed { color: #f44336; font-weight: 600; }
    .status-pending { color: #999; }
    @media print {
      body { background: white; }
      .screenshot { page-break-after: always; }
    }
    /* Modal for full-screen image */
    .modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0,0,0,0.9);
    }
    .modal.active {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal img {
      max-width: 95%;
      max-height: 95%;
      object-fit: contain;
    }
    .modal-close {
      position: absolute;
      top: 20px;
      right: 35px;
      color: #f1f1f1;
      font-size: 40px;
      font-weight: bold;
      cursor: pointer;
    }
    .modal-close:hover {
      color: #bbb;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🎬 Replay Report</h1>
    <div class="metadata">
      <div><strong>Recording:</strong> ${escapeHtml(metadata.recordingName || 'Unknown')}</div>
      <div><strong>Environment:</strong> ${escapeHtml(metadata.envName || 'Unknown')}</div>
      <div><strong>Status:</strong> <span class="status-${metadata.status}">${(metadata.status || 'unknown').toUpperCase()}</span></div>
      <div><strong>Started:</strong> ${new Date(metadata.startedAt).toLocaleString()}</div>
      <div><strong>Completed:</strong> ${metadata.endedAt ? new Date(metadata.endedAt).toLocaleString() : 'In progress'}</div>
      <div><strong>Total Steps:</strong> ${metadata.totalSteps}</div>
      ${metadata.error ? `<div><strong>Error:</strong> <span style="color: #f44336;">${escapeHtml(metadata.error)}</span></div>` : ''}
    </div>
  </div>
  ${screenshots.map((screenshot, index) => {
    const step = metadata.steps[index] || {};
    return `
    <div class="screenshot">
      <h3>Step ${index + 1}: ${escapeHtml((step.customName || step.elementName || step.type || 'Unknown').toUpperCase())}</h3>
      <img src="${screenshot}" alt="Step ${index + 1} screenshot" onclick="openModal(this.src)" />
      <div class="step-info">
        <div><strong>Type:</strong> ${escapeHtml(step.type || 'Unknown')}</div>
        <div><strong>Status:</strong> <span class="status-${step.status}">${(step.status || 'unknown').toUpperCase()}</span></div>
        ${step.elementName ? `<div><strong>Element:</strong> ${escapeHtml(step.elementName)}</div>` : ''}
        ${step.value ? `<div><strong>Value:</strong> ${escapeHtml(String(step.value).substring(0, 100))}</div>` : ''}
        ${step.error ? `<div><strong>Error:</strong> <span style="color: #f44336;">${escapeHtml(step.error.message || '')}</span></div>` : ''}
      </div>
    </div>
  `}).join('')}
  
  <div id="imageModal" class="modal" onclick="closeModal()">
    <span class="modal-close">&times;</span>
    <img id="modalImg" src="" alt="Full screen screenshot">
  </div>
  
  <script>
    function openModal(src) {
      const modal = document.getElementById('imageModal');
      const modalImg = document.getElementById('modalImg');
      modal.classList.add('active');
      modalImg.src = src;
    }
    
    function closeModal() {
      const modal = document.getElementById('imageModal');
      modal.classList.remove('active');
    }
    
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });
  </script>
</body>
</html>
  `;
  
  return new Blob([html], { type: 'text/html' });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Download a blob as a file
 * @param {Blob} blob - The blob to download
 * @param {string} filename - The filename for the download
 */
export async function downloadBlob(blob, filename) {
  // Convert blob to base64 data URL (works in service workers)
  const reader = new FileReader();
  
  return new Promise((resolve, reject) => {
    reader.onloadend = async () => {
      try {
        const dataUrl = reader.result;
        
        await chrome.downloads.download({
          url: dataUrl,
          filename: filename,
          saveAs: true
        });
        
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    
    reader.onerror = () => {
      reject(new Error('Failed to read blob'));
    };
    
    reader.readAsDataURL(blob);
  });
}
