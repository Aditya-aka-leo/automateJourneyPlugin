/**
 * Generate Word-compatible HTML report with embedded screenshots
 * @param {Array<string>} screenshots - Array of base64 screenshot data URLs
 * @param {Object} metadata - Report metadata
 * @returns {Promise<Blob>} - The generated HTML blob
 */
export async function generateDOCXReport(screenshots, metadata) {
  // Create HTML that Word can open and save as DOCX
  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head>
  <meta charset="UTF-8">
  <title>Replay Report - ${escapeHtml(metadata.recordingName || 'Unknown')}</title>
  <style>
    body {
      font-family: Calibri, Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.5;
      margin: 1in;
    }
    h1 {
      font-size: 20pt;
      color: #2E75B6;
      margin-bottom: 12pt;
      border-bottom: 2pt solid #2E75B6;
      padding-bottom: 6pt;
    }
    .metadata {
      margin-bottom: 20pt;
    }
    .metadata-item {
      margin: 4pt 0;
    }
    .metadata-label {
      font-weight: bold;
      display: inline-block;
      width: 150px;
    }
    .step-section {
      page-break-inside: avoid;
      margin-bottom: 24pt;
      border: 1pt solid #D0D0D0;
      padding: 12pt;
      background-color: #FAFAFA;
    }
    .step-title {
      font-size: 14pt;
      font-weight: bold;
      color: #2E75B6;
      margin-bottom: 12pt;
    }
    .screenshot-img {
      max-width: 100%;
      width: 700px;
      border: 1pt solid #CCCCCC;
      margin: 12pt 0;
      display: block;
    }
    .step-details {
      background-color: #F2F2F2;
      padding: 8pt;
      margin-top: 8pt;
      border-left: 3pt solid #2E75B6;
    }
    .step-details-item {
      margin: 4pt 0;
    }
    .status-passed {
      color: #70AD47;
      font-weight: bold;
    }
    .status-failed {
      color: #C00000;
      font-weight: bold;
    }
    .status-pending {
      color: #7F7F7F;
    }
    @media print {
      .step-section {
        page-break-after: always;
      }
    }
  </style>
</head>
<body>
  <h1>🎬 Replay Test Report</h1>
  
  <div class="metadata">
    <div class="metadata-item">
      <span class="metadata-label">Recording:</span>
      <span>${escapeHtml(metadata.recordingName || 'Unknown Recording')}</span>
    </div>
    <div class="metadata-item">
      <span class="metadata-label">Environment:</span>
      <span>${escapeHtml(metadata.envName || 'Unknown Environment')}</span>
    </div>
    <div class="metadata-item">
      <span class="metadata-label">Status:</span>
      <span class="status-${metadata.status}">${(metadata.status || 'unknown').toUpperCase()}</span>
    </div>
    <div class="metadata-item">
      <span class="metadata-label">Started:</span>
      <span>${new Date(metadata.startedAt).toLocaleString()}</span>
    </div>
    <div class="metadata-item">
      <span class="metadata-label">Completed:</span>
      <span>${metadata.endedAt ? new Date(metadata.endedAt).toLocaleString() : 'In progress'}</span>
    </div>
    <div class="metadata-item">
      <span class="metadata-label">Total Steps:</span>
      <span>${metadata.totalSteps}</span>
    </div>
    <div class="metadata-item">
      <span class="metadata-label">Screenshots:</span>
      <span>${screenshots.length}</span>
    </div>
    ${metadata.error ? `
    <div class="metadata-item">
      <span class="metadata-label">Error:</span>
      <span style="color: #C00000;">${escapeHtml(metadata.error)}</span>
    </div>
    ` : ''}
  </div>
  
  <h2 style="color: #2E75B6; font-size: 16pt; margin-top: 24pt; margin-bottom: 12pt;">📸 Screenshots</h2>
  
  ${screenshots.map((screenshot, index) => {
    const step = metadata.steps[index] || {};
    const stepName = step.customName || step.elementName || step.type || `Step ${index + 1}`;
    return `
    <div class="step-section">
      <div class="step-title">Step ${index + 1}: ${escapeHtml(stepName.toUpperCase())}</div>
      
      <img class="screenshot-img" src="${screenshot}" alt="Step ${index + 1} screenshot" />
      
      <div class="step-details">
        <div class="step-details-item">
          <strong>Type:</strong> ${escapeHtml(step.type || 'Unknown')}
        </div>
        <div class="step-details-item">
          <strong>Status:</strong> <span class="status-${step.status}">${(step.status || 'unknown').toUpperCase()}</span>
        </div>
        ${step.elementName ? `
        <div class="step-details-item">
          <strong>Element:</strong> ${escapeHtml(step.elementName)}
        </div>
        ` : ''}
        ${step.value ? `
        <div class="step-details-item">
          <strong>Value:</strong> ${escapeHtml(String(step.value).substring(0, 200))}
        </div>
        ` : ''}
        ${step.error ? `
        <div class="step-details-item">
          <strong>Error:</strong> <span style="color: #C00000;">${escapeHtml(step.error.message || '')}</span>
        </div>
        ` : ''}
      </div>
    </div>
    `;
  }).join('')}
  
  <div style="margin-top: 24pt; padding-top: 12pt; border-top: 1pt solid #CCCCCC; color: #666; font-size: 9pt;">
    <p>Generated by Autotest - QA Automation Extension</p>
    <p>Report generated: ${new Date().toLocaleString()}</p>
    <p><strong>To save as DOCX:</strong> Open this file in Microsoft Word and use "File → Save As → Word Document (.docx)"</p>
  </div>
  
</body>
</html>`;

  // Return as HTML blob
  return new Blob([html], { 
    type: 'text/html'
  });
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
