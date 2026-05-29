/**
 * Step Converter
 * 
 * Bidirectional conversion between recorded steps and natural language steps.
 * Enables hybrid workflows (record + edit as NL, or write NL + execute as recorded).
 */

/**
 * Convert recorded step to natural language description
 * @param {object} step - Recorded step
 * @returns {string} Natural language description
 */
export function recordedToNL(step) {
  if (!step || !step.type) {
    return 'Unknown step';
  }
  
  const { type, elementName, value, selector, relativePath } = step;
  
  switch (type) {
    case 'click':
      return generateClickNL(elementName, selector);
    
    case 'input':
      return generateInputNL(elementName, value, selector);
    
    case 'navigation':
      return generateNavigationNL(relativePath, value);
    
    case 'wait':
      return generateWaitNL(step);
    
    case 'assert':
      return generateAssertNL(step);
    
    case 'select':
      return generateSelectNL(elementName, value);
    
    default:
      return `Perform ${type} action`;
  }
}

function generateClickNL(elementName, selector) {
  if (elementName) {
    // Clean up element name
    const cleanName = cleanElementName(elementName);
    
    // Determine element type from selector or name
    const type = inferElementType(elementName, selector);
    
    return `Click the "${cleanName}" ${type}`;
  }
  
  if (selector?.primary?.value) {
    const selectorStr = selector.primary.value;
    
    // Extract meaningful info from selector
    if (selectorStr.includes('button')) {
      return `Click the button`;
    } else if (selectorStr.includes('link') || selectorStr.includes('[href')) {
      return `Click the link`;
    } else if (selectorStr.includes('[role="button"]')) {
      return `Click the button`;
    }
  }
  
  return 'Click the element';
}

function generateInputNL(elementName, value, selector) {
  const cleanName = cleanElementName(elementName);
  const fieldType = inferFieldType(elementName, selector);
  
  if (value) {
    return `Type "${value}" in the ${cleanName || fieldType} field`;
  } else {
    return `Focus on the ${cleanName || fieldType} field`;
  }
}

function generateNavigationNL(relativePath, value) {
  const path = relativePath || value || '';
  
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return `Navigate to ${path}`;
  } else if (path.startsWith('/')) {
    return `Go to ${path}`;
  } else if (path) {
    return `Go to ${path}`;
  }
  
  return 'Navigate to page';
}

function generateWaitNL(step) {
  const { waitCondition, elementName } = step;
  
  if (elementName) {
    return `Wait for "${cleanElementName(elementName)}" to appear`;
  }
  
  if (waitCondition) {
    if (waitCondition.includes('visible')) {
      return 'Wait for element to be visible';
    } else if (waitCondition.includes('load')) {
      return 'Wait for page to load';
    } else if (waitCondition.includes('network')) {
      return 'Wait for network to be idle';
    }
  }
  
  return 'Wait for condition';
}

function generateAssertNL(step) {
  const { assertCondition, elementName } = step;
  
  if (!assertCondition) {
    return 'Verify element exists';
  }
  
  const { type, expected } = assertCondition;
  const cleanName = cleanElementName(elementName);
  
  switch (type) {
    case 'exists':
      return `Verify "${cleanName}" exists`;
    
    case 'not_exists':
      return `Verify "${cleanName}" does not exist`;
    
    case 'visible':
      return `Verify "${cleanName}" is visible`;
    
    case 'not_visible':
      return `Verify "${cleanName}" is not visible`;
    
    case 'text_equals':
      return `Verify "${cleanName}" text equals "${expected}"`;
    
    case 'text_contains':
      return `Verify "${cleanName}" contains "${expected}"`;
    
    case 'attribute_equals':
      return `Verify "${cleanName}" attribute equals "${expected}"`;
    
    default:
      return `Verify "${cleanName}"`;
  }
}

function generateSelectNL(elementName, value) {
  const cleanName = cleanElementName(elementName);
  
  if (value) {
    return `Select "${value}" from ${cleanName || 'dropdown'}`;
  }
  
  return `Select option from ${cleanName || 'dropdown'}`;
}

/**
 * Clean up element name for NL description
 */
function cleanElementName(elementName) {
  if (!elementName) return '';
  
  return elementName
    .replace(/^(button|link|input|field|dropdown|checkbox|radio)\s*/i, '')
    .replace(/\s*(button|link|input|field|dropdown|checkbox|radio)$/i, '')
    .trim();
}

/**
 * Infer element type from name and selector
 */
function inferElementType(elementName, selector) {
  const lowerName = (elementName || '').toLowerCase();
  const selectorStr = selector?.primary?.value || '';
  
  if (lowerName.includes('button') || selectorStr.includes('button') || selectorStr.includes('[role="button"]')) {
    return 'button';
  }
  
  if (lowerName.includes('link') || selectorStr.includes('a[') || selectorStr.includes('[href')) {
    return 'link';
  }
  
  if (lowerName.includes('checkbox') || selectorStr.includes('[type="checkbox"]')) {
    return 'checkbox';
  }
  
  if (lowerName.includes('radio') || selectorStr.includes('[type="radio"]')) {
    return 'radio button';
  }
  
  return 'element';
}

/**
 * Infer field type from name and selector
 */
function inferFieldType(elementName, selector) {
  const lowerName = (elementName || '').toLowerCase();
  const selectorStr = selector?.primary?.value || '';
  
  if (lowerName.includes('email') || selectorStr.includes('[type="email"]')) {
    return 'email';
  }
  
  if (lowerName.includes('password') || selectorStr.includes('[type="password"]')) {
    return 'password';
  }
  
  if (lowerName.includes('search') || selectorStr.includes('[type="search"]')) {
    return 'search';
  }
  
  if (lowerName.includes('text') || selectorStr.includes('textarea')) {
    return 'text';
  }
  
  return 'input';
}

/**
 * Convert NL description to recorded-style step (partial)
 * Note: This creates a step template that needs selector resolution at runtime
 * @param {string} nlDescription - Natural language description
 * @returns {object} Partial step object
 */
export function nlToRecorded(nlDescription) {
  const lower = nlDescription.toLowerCase().trim();
  
  // Click patterns
  if (/^(click|press|tap)\s+(on\s+)?(the\s+)?["']?(.+?)["']?\s*(button|link|element)?$/i.test(lower)) {
    const match = lower.match(/^(click|press|tap)\s+(on\s+)?(the\s+)?["']?(.+?)["']?\s*(button|link|element)?$/i);
    return {
      type: 'click',
      nlDescription,
      elementName: match[4],
      selector: null, // To be resolved at runtime
      timestamp: Date.now()
    };
  }
  
  // Input patterns
  if (/^(type|enter|input|fill)\s+["'](.+?)["']\s+(in|into|to)\s+(the\s+)?["']?(.+?)["']?\s*(field|input)?$/i.test(lower)) {
    const match = lower.match(/^(type|enter|input|fill)\s+["'](.+?)["']\s+(in|into|to)\s+(the\s+)?["']?(.+?)["']?\s*(field|input)?$/i);
    return {
      type: 'input',
      nlDescription,
      value: match[2],
      elementName: match[5],
      selector: null,
      timestamp: Date.now()
    };
  }
  
  // Navigate patterns
  if (/^(go to|navigate to|visit|open)\s+(.+)$/i.test(lower)) {
    const match = lower.match(/^(go to|navigate to|visit|open)\s+(.+)$/i);
    return {
      type: 'navigation',
      nlDescription,
      relativePath: match[2],
      timestamp: Date.now()
    };
  }
  
  // Wait patterns
  if (/^wait\s+for\s+["']?(.+?)["']?\s*(to\s+(appear|load|be visible))?$/i.test(lower)) {
    const match = lower.match(/^wait\s+for\s+["']?(.+?)["']?\s*(to\s+(appear|load|be visible))?$/i);
    return {
      type: 'wait',
      nlDescription,
      elementName: match[1],
      waitCondition: 'element visible',
      selector: null,
      timestamp: Date.now()
    };
  }
  
  // Assert patterns
  if (/^(verify|check|assert|confirm)\s+(that\s+)?["']?(.+?)["']?\s*(exists|is visible|contains|equals)?/i.test(lower)) {
    const match = lower.match(/^(verify|check|assert|confirm)\s+(that\s+)?["']?(.+?)["']?\s*(exists|is visible|contains|equals)?/i);
    return {
      type: 'assert',
      nlDescription,
      elementName: match[3],
      assertCondition: {
        type: match[4] ? match[4].replace(/\s+/g, '_') : 'exists',
        expected: true
      },
      selector: null,
      timestamp: Date.now()
    };
  }
  
  // Default: treat as click
  return {
    type: 'click',
    nlDescription,
    elementName: nlDescription,
    selector: null,
    timestamp: Date.now()
  };
}

/**
 * Convert batch of recorded steps to NL
 * @param {object[]} steps - Array of recorded steps
 * @returns {object[]} Steps with NL descriptions added
 */
export function batchRecordedToNL(steps) {
  return steps.map(step => ({
    ...step,
    nlDescription: step.nlDescription || recordedToNL(step)
  }));
}

/**
 * Convert batch of NL descriptions to recorded steps
 * @param {string[]} nlDescriptions - Array of NL descriptions
 * @returns {object[]} Array of partial steps
 */
export function batchNLToRecorded(nlDescriptions) {
  return nlDescriptions.map(nl => nlToRecorded(nl));
}

/**
 * Enhance recorded step with NL metadata
 * @param {object} step - Recorded step
 * @returns {object} Enhanced step
 */
export function enhanceStepWithNL(step) {
  if (!step.nlDescription) {
    step.nlDescription = recordedToNL(step);
  }
  
  if (!step.nlMetadata) {
    step.nlMetadata = {
      generatedAt: Date.now(),
      source: 'auto-generated',
      editable: true
    };
  }
  
  return step;
}

/**
 * Validate NL-to-recorded conversion
 * @param {object} step - Converted step
 * @returns {object} Validation result
 */
export function validateConversion(step) {
  const errors = [];
  
  if (!step.type) {
    errors.push('Missing step type');
  }
  
  if (step.type === 'input' && !step.value) {
    errors.push('Input step missing value');
  }
  
  if (step.type === 'navigation' && !step.relativePath) {
    errors.push('Navigation step missing path');
  }
  
  if (!step.nlDescription) {
    errors.push('Missing NL description');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Generate user-friendly step summary
 * @param {object} step - Step object
 * @returns {string} Summary string
 */
export function getStepSummary(step) {
  if (step.nlDescription) {
    return step.nlDescription;
  }
  
  return recordedToNL(step);
}

/**
 * Compare two steps for similarity
 * @param {object} step1 - First step
 * @param {object} step2 - Second step
 * @returns {number} Similarity score (0-1)
 */
export function compareSteps(step1, step2) {
  let score = 0;
  let total = 0;
  
  // Compare type
  total++;
  if (step1.type === step2.type) score++;
  
  // Compare element names
  if (step1.elementName && step2.elementName) {
    total++;
    const similarity = stringSimilarity(step1.elementName.toLowerCase(), step2.elementName.toLowerCase());
    score += similarity;
  }
  
  // Compare values
  if (step1.value && step2.value) {
    total++;
    if (step1.value === step2.value) score++;
  }
  
  // Compare NL descriptions
  if (step1.nlDescription && step2.nlDescription) {
    total++;
    const similarity = stringSimilarity(step1.nlDescription.toLowerCase(), step2.nlDescription.toLowerCase());
    score += similarity;
  }
  
  return total > 0 ? score / total : 0;
}

/**
 * Simple string similarity (Jaccard)
 */
function stringSimilarity(str1, str2) {
  const words1 = new Set(str1.split(/\s+/));
  const words2 = new Set(str2.split(/\s+/));
  
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  
  return intersection.size / union.size;
}
