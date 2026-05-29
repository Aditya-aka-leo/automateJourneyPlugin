/**
 * Self-Healing Logic
 *
 * Automatically attempts to fix broken selectors by re-analyzing the page.
 * Uses similarity matching and context analysis to find elements.
 */

import { extractPageContext } from '../shared/page-context.js';
import { saveCachedMapping, removeCachedMapping } from '../shared/cache.js';

/**
 * Attempt to heal a failed selector
 * @param {object} step - The step that failed
 * @param {string} failedSelector - The selector that failed
 * @param {object} options - Healing options
 * @returns {Promise<object>} Healing result
 */
export async function healSelector(step, failedSelector, options = {}) {
  const {
    useSimilarity = true,
    maxAttempts = 3
  } = options;

  console.log("[self-healing] Attempting to heal selector:", failedSelector);
  console.log("[self-healing] Step details:", { type: step.type, elementName: step.elementName });

  // Remove failed mapping from cache
  if (step.nlDescription) {
    await removeCachedMapping(window.location.href, step.nlDescription);
  }

  const healingStrategies = [];

  // Strategy 1: Find similar elements
  if (useSimilarity) {
    healingStrategies.push(() => healBySimilarity(step, failedSelector));
  }

  // Strategy 2: Analyze nearby context
  healingStrategies.push(() => healByContext(step));
  
  // Try each strategy
  for (let i = 0; i < healingStrategies.length && i < maxAttempts; i++) {
    try {
      console.log(`[self-healing] Trying strategy ${i + 1}/${healingStrategies.length}`);
      const result = await healingStrategies[i]();
      
      if (result.ok && result.element) {
        console.log("[self-healing] ✓ Healing successful! New selector:", result.selector);
        
        // Save healed selector to cache
        if (step.nlDescription && result.selector) {
          await saveCachedMapping(window.location.href, step.nlDescription, result.selector, {
            healed: true,
            healedFrom: failedSelector,
            confidence: result.confidence || 0.7
          });
        }
        
        return {
          ok: true,
          element: result.element,
          selector: result.selector,
          strategy: result.strategy,
          confidence: result.confidence || 0.7,
          healed: true
        };
      }
    } catch (err) {
      console.error(`[self-healing] Strategy ${i + 1} failed:`, err);
    }
  }
  
  console.log("[self-healing] ✗ All healing strategies failed");
  
  return {
    ok: false,
    error: 'All healing strategies failed',
    healed: false
  };
}

/**
 * Heal by finding similar elements
 */
async function healBySimilarity(step, failedSelector) {
  console.log("[self-healing] Strategy: Similarity matching");
  
  // Extract attributes from failed selector
  const targetAttributes = extractSelectorAttributes(failedSelector);
  
  if (!targetAttributes || Object.keys(targetAttributes).length === 0) {
    return { ok: false };
  }
  
  // Find elements with similar attributes
  const candidates = findSimilarElements(targetAttributes, step.type);
  
  if (candidates.length === 0) {
    return { ok: false };
  }
  
  // Return the best candidate
  const best = candidates[0];
  
  return {
    ok: true,
    element: best.element,
    selector: best.selector,
    strategy: 'similarity',
    confidence: best.similarity
  };
}

/**
 * Heal by analyzing nearby context
 */
async function healByContext(step) {
  console.log("[self-healing] Strategy: Context analysis");
  
  // Extract page context
  const context = extractPageContext({
    maxElements: 30,
    maxTextLength: 50
  });
  
  // Look for elements matching step type
  const candidates = [];
  
  for (const elInfo of context.elements) {
    // Match by step type
    if (step.type === 'click' && ['button', 'a'].includes(elInfo.tag)) {
      candidates.push(elInfo);
    } else if (step.type === 'input' && ['input', 'textarea'].includes(elInfo.tag)) {
      candidates.push(elInfo);
    }
  }
  
  // Score candidates by text similarity
  if (step.elementName && candidates.length > 0) {
    const scored = candidates.map(c => ({
      ...c,
      score: calculateTextSimilarity(step.elementName, c.text || c.attributes['aria-label'] || '')
    }));
    
    scored.sort((a, b) => b.score - a.score);
    
    if (scored[0].score > 0.3 && scored[0].selectors.length > 0) {
      const selector = scored[0].selectors[0];
      const element = document.querySelector(selector);
      
      if (element) {
        return {
          ok: true,
          element,
          selector,
          strategy: 'context',
          confidence: scored[0].score
        };
      }
    }
  }
  
  return { ok: false };
}

/**
 * Extract attributes from a CSS selector
 */
function extractSelectorAttributes(selector) {
  const attrs = {};
  
  // Extract ID
  const idMatch = selector.match(/#([a-zA-Z0-9_-]+)/);
  if (idMatch) attrs.id = idMatch[1];
  
  // Extract classes
  const classMatches = selector.match(/\.([a-zA-Z0-9_-]+)/g);
  if (classMatches) {
    attrs.classes = classMatches.map(c => c.substring(1));
  }
  
  // Extract attribute selectors
  const attrMatches = selector.matchAll(/\[([a-zA-Z-]+)(?:=["']([^"']+)["'])?\]/g);
  for (const match of attrMatches) {
    attrs[match[1]] = match[2] || true;
  }
  
  // Extract tag name
  const tagMatch = selector.match(/^([a-z]+)/);
  if (tagMatch) attrs.tag = tagMatch[1];
  
  return attrs;
}

/**
 * Find elements with similar attributes
 */
function findSimilarElements(targetAttributes, stepType) {
  const candidates = [];
  
  // Build a selector that matches the step type
  let baseSelector = '';
  if (stepType === 'click') {
    baseSelector = 'button, a, [role="button"], [onclick]';
  } else if (stepType === 'input') {
    baseSelector = 'input, textarea';
  } else {
    baseSelector = '*';
  }
  
  const elements = document.querySelectorAll(baseSelector);
  
  for (const el of elements) {
    if (!isVisible(el)) continue;
    
    const similarity = calculateAttributeSimilarity(targetAttributes, el);
    
    if (similarity > 0.3) { // At least 30% similar
      const selector = generateSelectorForElement(el);
      if (selector) {
        candidates.push({
          element: el,
          selector,
          similarity
        });
      }
    }
  }
  
  // Sort by similarity
  candidates.sort((a, b) => b.similarity - a.similarity);
  
  return candidates;
}

/**
 * Calculate attribute similarity between target and element
 */
function calculateAttributeSimilarity(targetAttributes, element) {
  let matches = 0;
  let total = 0;
  
  // Check ID
  if (targetAttributes.id) {
    total++;
    if (element.id === targetAttributes.id) matches++;
  }
  
  // Check classes
  if (targetAttributes.classes) {
    const elClasses = Array.from(element.classList);
    for (const targetClass of targetAttributes.classes) {
      total++;
      if (elClasses.includes(targetClass)) matches++;
    }
  }
  
  // Check other attributes
  for (const [attr, value] of Object.entries(targetAttributes)) {
    if (attr === 'id' || attr === 'classes' || attr === 'tag') continue;
    
    total++;
    const elValue = element.getAttribute(attr);
    if (elValue === value || (value === true && elValue !== null)) {
      matches++;
    }
  }
  
  // Check tag
  if (targetAttributes.tag) {
    total++;
    if (element.tagName.toLowerCase() === targetAttributes.tag) matches++;
  }
  
  return total > 0 ? matches / total : 0;
}

/**
 * Calculate text similarity (simple Jaccard)
 */
function calculateTextSimilarity(text1, text2) {
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));
  
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  
  return intersection.size / union.size;
}

/**
 * Generate a selector for an element
 */
function generateSelectorForElement(element) {
  // Try ID first
  if (element.id) {
    return `#${element.id}`;
  }
  
  // Try data-testid
  const testId = element.getAttribute('data-testid') || element.getAttribute('data-test');
  if (testId) {
    return `[data-testid="${testId}"]`;
  }
  
  // Try name
  if (element.name) {
    return `${element.tagName.toLowerCase()}[name="${element.name}"]`;
  }
  
  // Try aria-label
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) {
    return `[aria-label="${ariaLabel}"]`;
  }
  
  // Try classes (if not too many)
  if (element.classList.length > 0 && element.classList.length <= 3) {
    const classes = Array.from(element.classList).slice(0, 2).join('.');
    return `${element.tagName.toLowerCase()}.${classes}`;
  }
  
  // Fallback: path-based selector
  return generatePathSelector(element);
}

/**
 * Generate path-based selector
 */
function generatePathSelector(element) {
  const path = [];
  let current = element;
  
  while (current && current !== document.body && path.length < 5) {
    const tag = current.tagName.toLowerCase();
    
    if (current.id) {
      path.unshift(`#${current.id}`);
      break;
    }
    
    path.unshift(tag);
    current = current.parentElement;
  }
  
  return path.join(' > ');
}

/**
 * Check if element is visible
 */
function isVisible(element) {
  if (!element || !element.getBoundingClientRect) return false;
  
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0'
  );
}

/**
 * Check if self-healing is enabled
 */
export async function isSelfHealingEnabled() {
  const result = await chrome.storage.local.get(['selfHealingEnabled']);
  return result.selfHealingEnabled !== false; // Default to true
}

/**
 * Enable/disable self-healing
 */
export async function setSelfHealingEnabled(enabled) {
  await chrome.storage.local.set({ selfHealingEnabled: enabled });
  console.log("[self-healing] Self-healing", enabled ? 'enabled' : 'disabled');
}
