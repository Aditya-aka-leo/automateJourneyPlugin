/**
 * NL Mapping Cache
 * 
 * Caches successful NL description → selector mappings for performance.
 * Reduces AI API calls by reusing known mappings.
 */

/**
 * Get cache key for a mapping
 * @param {string} url - Page URL
 * @param {string} nlDescription - NL description
 * @returns {string} Cache key
 */
function getCacheKey(url, nlDescription) {
  // Normalize URL (remove query params and hash)
  const urlObj = new URL(url);
  const normalizedUrl = `${urlObj.origin}${urlObj.pathname}`;
  
  // Normalize NL description (lowercase, trim, normalize whitespace)
  const normalizedDesc = nlDescription.toLowerCase().trim().replace(/\s+/g, ' ');
  
  return `${normalizedUrl}::${normalizedDesc}`;
}

/**
 * Get all cached mappings
 * @returns {Promise<object>} All mappings
 */
export async function getAllMappings() {
  const result = await chrome.storage.local.get(['nlMappings']);
  return result.nlMappings || {};
}

/**
 * Get cached mapping for NL description on a page
 * @param {string} url - Page URL
 * @param {string} nlDescription - NL description
 * @returns {Promise<object|null>} Cached mapping or null
 */
export async function getCachedMapping(url, nlDescription) {
  const key = getCacheKey(url, nlDescription);
  const mappings = await getAllMappings();
  
  const mapping = mappings[key];
  
  if (!mapping) {
    console.log("[nlp-cache] No cached mapping found for:", key);
    return null;
  }
  
  // Check if mapping is stale (older than 7 days)
  const age = Date.now() - (mapping.lastUsed || mapping.created || 0);
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  
  if (age > maxAge) {
    console.log("[nlp-cache] Mapping is stale (age:", Math.round(age / 1000 / 60 / 60), "hours)");
    return null;
  }
  
  console.log("[nlp-cache] Found cached mapping:", {
    selector: mapping.selector,
    confidence: mapping.confidence,
    successRate: mapping.successCount / (mapping.successCount + mapping.failCount)
  });
  
  return mapping;
}

/**
 * Save successful mapping to cache
 * @param {string} url - Page URL
 * @param {string} nlDescription - NL description
 * @param {string} selector - CSS selector
 * @param {object} metadata - Additional metadata
 * @returns {Promise<void>}
 */
export async function saveCachedMapping(url, nlDescription, selector, metadata = {}) {
  const key = getCacheKey(url, nlDescription);
  const mappings = await getAllMappings();
  
  const existing = mappings[key];
  
  if (existing) {
    // Update existing mapping
    mappings[key] = {
      ...existing,
      selector, // Update selector in case it changed
      lastUsed: Date.now(),
      successCount: (existing.successCount || 0) + 1,
      confidence: Math.min(1.0, existing.confidence + 0.05), // Increase confidence with each success
      ...metadata
    };
  } else {
    // Create new mapping
    mappings[key] = {
      url,
      nlDescription,
      selector,
      confidence: metadata.confidence || 0.8,
      created: Date.now(),
      lastUsed: Date.now(),
      successCount: 1,
      failCount: 0,
      ...metadata
    };
  }
  
  await chrome.storage.local.set({ nlMappings: mappings });
  
  console.log("[nlp-cache] Saved mapping:", key, "→", selector);
}

/**
 * Record failed mapping attempt
 * @param {string} url - Page URL
 * @param {string} nlDescription - NL description
 * @param {string} selector - CSS selector that failed
 * @returns {Promise<void>}
 */
export async function recordFailedMapping(url, nlDescription, selector) {
  const key = getCacheKey(url, nlDescription);
  const mappings = await getAllMappings();
  
  const existing = mappings[key];
  
  if (existing && existing.selector === selector) {
    // Increment fail count and decrease confidence
    mappings[key] = {
      ...existing,
      lastUsed: Date.now(),
      failCount: (existing.failCount || 0) + 1,
      confidence: Math.max(0.1, existing.confidence - 0.1) // Decrease confidence
    };
    
    // Remove mapping if it's failed too many times
    const successRate = existing.successCount / (existing.successCount + existing.failCount + 1);
    if (successRate < 0.3 && existing.failCount >= 3) {
      console.log("[nlp-cache] Removing unreliable mapping:", key);
      delete mappings[key];
    } else {
      await chrome.storage.local.set({ nlMappings: mappings });
    }
    
    console.log("[nlp-cache] Recorded failure for:", key);
  }
}

/**
 * Remove a cached mapping
 * @param {string} url - Page URL
 * @param {string} nlDescription - NL description
 * @returns {Promise<void>}
 */
export async function removeCachedMapping(url, nlDescription) {
  const key = getCacheKey(url, nlDescription);
  const mappings = await getAllMappings();
  
  if (mappings[key]) {
    delete mappings[key];
    await chrome.storage.local.set({ nlMappings: mappings });
    console.log("[nlp-cache] Removed mapping:", key);
  }
}

/**
 * Clear all cached mappings
 * @returns {Promise<void>}
 */
export async function clearAllMappings() {
  await chrome.storage.local.set({ nlMappings: {} });
  console.log("[nlp-cache] Cleared all mappings");
}

/**
 * Get cache statistics
 * @returns {Promise<object>} Statistics
 */
export async function getCacheStats() {
  const mappings = await getAllMappings();
  const keys = Object.keys(mappings);
  
  if (keys.length === 0) {
    return {
      totalMappings: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      averageConfidence: 0,
      averageSuccessRate: 0,
      oldestMapping: null,
      newestMapping: null
    };
  }
  
  let totalSuccesses = 0;
  let totalFailures = 0;
  let totalConfidence = 0;
  let oldest = Date.now();
  let newest = 0;
  
  for (const key of keys) {
    const mapping = mappings[key];
    totalSuccesses += mapping.successCount || 0;
    totalFailures += mapping.failCount || 0;
    totalConfidence += mapping.confidence || 0;
    
    const created = mapping.created || 0;
    if (created < oldest) oldest = created;
    if (created > newest) newest = created;
  }
  
  return {
    totalMappings: keys.length,
    totalSuccesses,
    totalFailures,
    averageConfidence: totalConfidence / keys.length,
    averageSuccessRate: totalSuccesses / (totalSuccesses + totalFailures),
    oldestMapping: oldest < Date.now() ? new Date(oldest) : null,
    newestMapping: newest > 0 ? new Date(newest) : null
  };
}

/**
 * Get mappings for a specific URL
 * @param {string} url - Page URL
 * @returns {Promise<object[]>} Array of mappings
 */
export async function getMappingsForURL(url) {
  const urlObj = new URL(url);
  const normalizedUrl = `${urlObj.origin}${urlObj.pathname}`;
  
  const allMappings = await getAllMappings();
  const urlMappings = [];
  
  for (const [key, mapping] of Object.entries(allMappings)) {
    if (key.startsWith(normalizedUrl + '::')) {
      urlMappings.push({
        key,
        ...mapping
      });
    }
  }
  
  return urlMappings;
}

/**
 * Cleanup old and unreliable mappings
 * @param {number} maxAge - Maximum age in days (default: 30)
 * @param {number} minSuccessRate - Minimum success rate (default: 0.5)
 * @returns {Promise<number>} Number of mappings removed
 */
export async function cleanupMappings(maxAge = 30, minSuccessRate = 0.5) {
  const mappings = await getAllMappings();
  const maxAgeMs = maxAge * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let removed = 0;
  
  for (const [key, mapping] of Object.entries(mappings)) {
    let shouldRemove = false;
    
    // Check age
    const age = now - (mapping.created || 0);
    if (age > maxAgeMs) {
      shouldRemove = true;
      console.log("[nlp-cache] Removing old mapping:", key, "age:", Math.round(age / 1000 / 60 / 60 / 24), "days");
    }
    
    // Check success rate
    const total = (mapping.successCount || 0) + (mapping.failCount || 0);
    if (total >= 5) { // Only check if we have enough data
      const successRate = (mapping.successCount || 0) / total;
      if (successRate < minSuccessRate) {
        shouldRemove = true;
        console.log("[nlp-cache] Removing unreliable mapping:", key, "success rate:", successRate.toFixed(2));
      }
    }
    
    if (shouldRemove) {
      delete mappings[key];
      removed++;
    }
  }
  
  if (removed > 0) {
    await chrome.storage.local.set({ nlMappings: mappings });
    console.log("[nlp-cache] Cleanup complete, removed", removed, "mappings");
  }
  
  return removed;
}

/**
 * Export mappings to JSON
 * @returns {Promise<string>} JSON string
 */
export async function exportMappings() {
  const mappings = await getAllMappings();
  return JSON.stringify(mappings, null, 2);
}

/**
 * Import mappings from JSON
 * @param {string} json - JSON string
 * @param {boolean} merge - Whether to merge with existing (default: false)
 * @returns {Promise<number>} Number of mappings imported
 */
export async function importMappings(json, merge = false) {
  try {
    const imported = JSON.parse(json);
    
    if (typeof imported !== 'object') {
      throw new Error('Invalid mappings format');
    }
    
    let mappings = merge ? await getAllMappings() : {};
    let count = 0;
    
    for (const [key, mapping] of Object.entries(imported)) {
      // Validate mapping structure
      if (mapping && typeof mapping === 'object' && mapping.selector && mapping.nlDescription) {
        mappings[key] = mapping;
        count++;
      }
    }
    
    await chrome.storage.local.set({ nlMappings: mappings });
    console.log("[nlp-cache] Imported", count, "mappings");
    
    return count;
  } catch (err) {
    console.error("[nlp-cache] Import failed:", err);
    throw err;
  }
}

/**
 * Find similar mappings based on NL description
 * @param {string} nlDescription - NL description
 * @param {number} maxResults - Maximum number of results (default: 5)
 * @returns {Promise<object[]>} Similar mappings
 */
export async function findSimilarMappings(nlDescription, maxResults = 5) {
  const allMappings = await getAllMappings();
  const normalizedInput = nlDescription.toLowerCase().trim().replace(/\s+/g, ' ');
  
  const scored = [];
  
  for (const [key, mapping] of Object.entries(allMappings)) {
    const normalizedMapping = mapping.nlDescription.toLowerCase().trim().replace(/\s+/g, ' ');
    
    // Calculate simple similarity score (Jaccard similarity)
    const inputWords = new Set(normalizedInput.split(' '));
    const mappingWords = new Set(normalizedMapping.split(' '));
    
    const intersection = new Set([...inputWords].filter(x => mappingWords.has(x)));
    const union = new Set([...inputWords, ...mappingWords]);
    
    const similarity = intersection.size / union.size;
    
    if (similarity > 0.3) { // Only include if similarity > 30%
      scored.push({
        mapping,
        similarity,
        key
      });
    }
  }
  
  // Sort by similarity (descending) and take top results
  scored.sort((a, b) => b.similarity - a.similarity);
  
  return scored.slice(0, maxResults);
}
