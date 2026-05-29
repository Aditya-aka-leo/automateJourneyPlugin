// Emergency Fix Script - Run in POPUP Console
// This will force-update your AI config with correct timeout

(async () => {
  console.log('🔧 Fixing AI Configuration...\n');
  
  // Get current config
  const result = await chrome.storage.local.get(['aiConfig']);
  const config = result.aiConfig || {};
  
  console.log('Current config:', config);
  
  // Ensure options object exists
  if (!config.options) {
    config.options = {};
  }
  
  // Force timeout to 120 seconds
  config.options.timeout = 120000;
  config.options.maxTokens = config.options.maxTokens || 2000;
  config.options.temperature = config.options.temperature || 0.2;
  
  // Save back
  await chrome.storage.local.set({ aiConfig: config });
  
  console.log('✅ Config updated!');
  console.log('New config:', config);
  console.log('\n🔄 Now reload the extension:');
  console.log('   chrome://extensions → Find "Autotest" → Click Reload\n');
})();
