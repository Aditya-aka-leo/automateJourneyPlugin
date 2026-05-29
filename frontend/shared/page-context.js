/**
 * Page Context Extractor
 * 
 * Extracts relevant information from the current page for AI analysis.
 * Provides DOM snapshot, visible elements, and semantic structure.
 */

/**
 * Extract page context for AI analysis
 * @param {object} options - Extraction options
 * @returns {object} Page context
 */
export function extractPageContext(options = {}) {
  const {
    maxElements = 150,
    maxTextLength = 150,
    includeHidden = false,
    includeStyles = false
  } = options;
  
  console.log("[page-context] Extracting page context");
  
  const context = {
    url: window.location.href,
    title: document.title,
    timestamp: Date.now(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    elements: extractVisibleElements(maxElements, maxTextLength, includeHidden),
    structure: extractSemanticStructure(),
    forms: extractForms(),
    links: extractLinks(40), // Limit to 40 links
    headings: extractHeadings(),
    domStats: getDOMStats()
  };
  
  if (includeStyles) {
    context.styles = extractRelevantStyles();
  }
  
  console.log("[page-context] Extracted context:", {
    elementsCount: context.elements.length,
    formsCount: context.forms.length,
    linksCount: context.links.length
  });
  
  return context;
}

/**
 * Extract visible and interactive elements
 */
function extractVisibleElements(maxElements, maxTextLength, includeHidden) {
  const elements = [];
  
  // Interactive element selectors
  const selectors = [
    'button',
    'a[href]',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="textbox"]',
    '[onclick]',
    '[data-testid]',
    '[data-test]',
    '[aria-label]'
  ].join(', ');
  
  const interactiveElements = document.querySelectorAll(selectors);
  
  for (const el of interactiveElements) {
    if (elements.length >= maxElements) break;
    
    // Skip if not visible (unless includeHidden is true)
    if (!includeHidden && !isElementVisible(el)) continue;
    
    const elementInfo = extractElementInfo(el, maxTextLength);
    if (elementInfo) {
      elements.push(elementInfo);
    }
  }
  
  return elements;
}

/**
 * Check if element is visible
 */
function isElementVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0' &&
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  );
}

/**
 * Extract element information - Enhanced for multi-hop refinement
 */
function extractElementInfo(el, maxTextLength) {
  try {
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const parent = el.parentElement;
    
    // Extract all possible identifiers
    const label = el.getAttribute('aria-label') || 
                  el.getAttribute('placeholder') || 
                  el.getAttribute('name') || 
                  el.getAttribute('title') ||
                  (el.labels && el.labels[0]?.textContent?.trim()) ||
                  null;
    
    const text = getElementText(el, maxTextLength);
    
    const info = {
      // Basic identification
      tag,
      type: el.type || tag,
      id: el.id || null,
      name: el.name || null,
      classes: el.className ? Array.from(el.classList).slice(0, 5) : [],
      
      // Text content variants
      text: text,
      innerText: el.innerText?.trim()?.substring(0, maxTextLength),
      textContent: el.textContent?.trim()?.substring(0, maxTextLength),
      value: el.value || null,
      
      // Accessibility
      label: label,
      placeholder: el.placeholder || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      ariaDescribedby: el.getAttribute('aria-describedby') || null,
      ariaExpanded: el.getAttribute('aria-expanded'),
      ariaHaspopup: el.getAttribute('aria-haspopup'),
      role: el.getAttribute('role') || null,
      title: el.getAttribute('title') || null,
      
      // Selectors
      selector: generateBestSelector(el),
      xpath: generateXPath(el),
      cssPath: generateCSSPath(el),
      uniqueSelector: generateUniqueSelector(el),
      
      // Position & visibility
      position: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      boundingRect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
        right: rect.right
      },
      visible: isElementVisible(el),
      inViewport: rect.top >= 0 && rect.left >= 0 && 
                  rect.bottom <= window.innerHeight && 
                  rect.right <= window.innerWidth,
      zIndex: parseInt(style.zIndex) || 0,
      
      // Hierarchy
      parentTag: parent?.tagName?.toLowerCase() || null,
      parentId: parent?.id || null,
      parentClasses: parent?.className?.split(/\s+/).filter(Boolean).slice(0, 3) || [],
      parentText: parent?.textContent?.trim()?.substring(0, 50) || null,
      childCount: el.children?.length || 0,
      siblingIndex: getSiblingIndex(el),
      
      // Nearby elements context
      nearbyLabels: getNearbyLabels(el),
      formFieldLabel: getAssociatedLabel(el),
      precedingText: getPrecedingText(el),
      
      // Interaction hints
      isClickable: isClickable(el),
      isEditable: isEditable(el),
      isFocusable: el.tabIndex >= 0 || ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A'].includes(el.tagName),
      isDisabled: el.disabled || el.getAttribute('disabled') !== null,
      hasOnclick: !!el.onclick || el.hasAttribute('onclick'),
      
      // Data attributes
      dataTestid: el.getAttribute('data-testid') || el.getAttribute('data-test-id'),
      dataAttributes: extractDataAttributes(el),
      
      // Computed styles
      display: style.display,
      cursor: style.cursor,
      
      // Legacy support
      attributes: extractRelevantAttributes(el)
    };
    
    return info;
  } catch (err) {
    console.warn("[page-context] Failed to extract element info:", err);
    return null;
  }
}

/**
 * Generate XPath for an element
 */
function generateXPath(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
  
  const segments = [];
  let node = el;
  
  while (node && node.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase();
    let index = 1;
    let sibling = node.previousElementSibling;
    
    while (sibling) {
      if (sibling.tagName.toLowerCase() === tag) index++;
      sibling = sibling.previousElementSibling;
    }
    
    segments.unshift(`${tag}[${index}]`);
    node = node.parentElement;
  }
  
  return `/${segments.join('/')}`;
}

/**
 * Generate CSS path for an element
 */
function generateCSSPath(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
  
  const segments = [];
  let node = el;
  
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
    let selector = node.tagName.toLowerCase();
    
    if (node.id) {
      selector = `#${node.id}`;
      segments.unshift(selector);
      break; // ID is unique, stop here
    }
    
    if (node.className) {
      const classes = Array.from(node.classList).slice(0, 2).join('.');
      if (classes) {
        selector += `.${classes}`;
      }
    }
    
    // Add nth-child if needed for uniqueness
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        child => child.tagName === node.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(node) + 1;
        selector += `:nth-child(${index})`;
      }
    }
    
    segments.unshift(selector);
    node = node.parentElement;
  }
  
  return segments.join(' > ');
}

/**
 * Generate unique selector for an element
 */
function generateUniqueSelector(el) {
  if (!el) return null;
  
  // Try data-testid first
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
  if (testId) return `[data-testid="${testId}"]`;
  
  // Try ID
  if (el.id) return `#${el.id}`;
  
  // Try name + type for inputs
  const name = el.getAttribute('name');
  const type = el.getAttribute('type');
  if (name && type) return `${el.tagName.toLowerCase()}[name="${name}"][type="${type}"]`;
  if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
  
  // Try aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `[aria-label="${ariaLabel}"]`;
  
  return null;
}

/**
 * Get sibling index of an element
 */
function getSiblingIndex(el) {
  if (!el || !el.parentElement) return -1;
  return Array.from(el.parentElement.children).indexOf(el);
}

/**
 * Get nearby labels within search radius
 */
function getNearbyLabels(el) {
  const labels = [];
  const searchRadius = 100; // pixels
  
  const allLabels = document.querySelectorAll('label, [class*="label"], .form-label');
  const elRect = el.getBoundingClientRect();
  
  for (const label of allLabels) {
    const labelRect = label.getBoundingClientRect();
    const distance = Math.sqrt(
      Math.pow(labelRect.left - elRect.left, 2) + 
      Math.pow(labelRect.top - elRect.top, 2)
    );
    
    if (distance < searchRadius) {
      labels.push(label.textContent?.trim()?.substring(0, 50));
    }
  }
  
  return labels.slice(0, 5);
}

/**
 * Get text preceding the element
 */
function getPrecedingText(el) {
  const prev = el.previousSibling;
  if (prev && prev.nodeType === Node.TEXT_NODE) {
    return prev.textContent?.trim()?.substring(0, 50);
  }
  
  const prevEl = el.previousElementSibling;
  if (prevEl) {
    return prevEl.textContent?.trim()?.substring(0, 50);
  }
  
  return null;
}

/**
 * Check if element is clickable
 */
function isClickable(el) {
  const tag = el.tagName?.toUpperCase();
  const role = el.getAttribute('role');
  const cursor = window.getComputedStyle(el).cursor;
  
  return tag === 'BUTTON' || 
         tag === 'A' || 
         (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) ||
         role === 'button' || 
         role === 'link' ||
         cursor === 'pointer' ||
         el.onclick !== null ||
         el.hasAttribute('onclick');
}

/**
 * Check if element is editable
 */
function isEditable(el) {
  const tag = el.tagName?.toUpperCase();
  return tag === 'INPUT' || 
         tag === 'TEXTAREA' || 
         tag === 'SELECT' ||
         el.isContentEditable;
}

/**
 * Extract all data-* attributes
 */
function extractDataAttributes(el) {
  const attrs = {};
  for (const attr of el.attributes) {
    if (attr.name.startsWith('data-')) {
      attrs[attr.name] = attr.value;
    }
  }
  return Object.keys(attrs).length > 0 ? attrs : null;
}

/**
 * Get element text content (trimmed)
 */
function getElementText(el, maxLength) {
  let text = '';
  
  // For inputs, use placeholder or value
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    text = el.placeholder || el.value || '';
  } else {
    // Get direct text content (not children)
    text = Array.from(el.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent)
      .join(' ')
      .trim();
    
    // Fallback to full text content if no direct text
    if (!text) {
      text = el.textContent || '';
    }
  }
  
  text = text.trim().replace(/\s+/g, ' ');
  
  if (text.length > maxLength) {
    text = text.substring(0, maxLength) + '...';
  }
  
  return text;
}

/**
 * Extract relevant element attributes
 */
function extractRelevantAttributes(el) {
  const attrs = {};
  
  const relevantAttrs = [
    'name',
    'placeholder',
    'aria-label',
    'aria-labelledby',
    'aria-describedby',
    'role',
    'title',
    'alt',
    'value',
    'href',
    'data-testid',
    'data-test',
    'data-test-id'
  ];
  
  for (const attr of relevantAttrs) {
    const value = el.getAttribute(attr);
    if (value) {
      attrs[attr] = value;
    }
  }
  
  return attrs;
}

/**
 * Generate possible selectors for an element
 */
function generatePossibleSelectors(el) {
  const selectors = [];
  const tag = el.tagName.toLowerCase();
  
  // ID selector
  if (el.id) {
    selectors.push(`#${el.id}`);
  }
  
  // Data attributes
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
  if (testId) {
    selectors.push(`[data-testid="${testId}"]`);
  }
  
  // Name attribute
  if (el.name) {
    selectors.push(`${tag}[name="${el.name}"]`);
  }
  
  // Aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    selectors.push(`[aria-label="${ariaLabel}"]`);
  }
  
  // Role
  const role = el.getAttribute('role');
  if (role) {
    selectors.push(`[role="${role}"]`);
  }
  
  // Class-based (if unique enough)
  if (el.className && el.classList.length <= 3) {
    const classes = Array.from(el.classList).slice(0, 3).join('.');
    if (classes) {
      selectors.push(`${tag}.${classes}`);
    }
  }
  
  return selectors.slice(0, 5); // Limit to 5 selectors
}

/**
 * Generate best selector for an element (alias for compatibility)
 */
function generateBestSelector(el) {
  const selectors = generatePossibleSelectors(el);
  return selectors[0] || el.tagName.toLowerCase();
}

/**
 * Extract semantic structure
 */
function extractSemanticStructure() {
  const structure = {
    hasHeader: !!document.querySelector('header, [role="banner"]'),
    hasNav: !!document.querySelector('nav, [role="navigation"]'),
    hasMain: !!document.querySelector('main, [role="main"]'),
    hasFooter: !!document.querySelector('footer, [role="contentinfo"]'),
    hasSidebar: !!document.querySelector('aside, [role="complementary"]'),
    landmarks: []
  };
  
  // Extract ARIA landmarks
  const landmarks = document.querySelectorAll('[role]');
  for (const landmark of landmarks) {
    const role = landmark.getAttribute('role');
    if (['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form'].includes(role)) {
      structure.landmarks.push({
        role,
        label: landmark.getAttribute('aria-label') || landmark.getAttribute('aria-labelledby') || null
      });
    }
  }
  
  return structure;
}

/**
 * Extract forms
 */
function extractForms() {
  const forms = [];
  const formElements = document.querySelectorAll('form');
  
  for (const form of formElements) {
    if (!isElementVisible(form)) continue;
    
    const fields = [];
    const inputs = form.querySelectorAll('input, textarea, select');
    
    for (const input of inputs) {
      if (!isElementVisible(input)) continue;
      
      fields.push({
        tag: input.tagName.toLowerCase(),
        type: input.type || null,
        name: input.name || null,
        id: input.id || null,
        placeholder: input.placeholder || null,
        required: input.required || false,
        label: getAssociatedLabel(input)
      });
    }
    
    forms.push({
      id: form.id || null,
      name: form.name || null,
      action: form.action || null,
      method: form.method || null,
      fields
    });
  }
  
  return forms;
}

/**
 * Get associated label for an input
 */
function getAssociatedLabel(input) {
  // Try label[for]
  if (input.id) {
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (label) return label.textContent.trim();
  }
  
  // Try parent label
  const parentLabel = input.closest('label');
  if (parentLabel) {
    return parentLabel.textContent.trim().replace(input.textContent || '', '').trim();
  }
  
  // Try aria-label
  const ariaLabel = input.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;
  
  // Try aria-labelledby
  const labelledBy = input.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent.trim();
  }
  
  return null;
}

/**
 * Extract links
 */
function extractLinks(maxLinks) {
  const links = [];
  const linkElements = document.querySelectorAll('a[href]');
  
  for (const link of linkElements) {
    if (links.length >= maxLinks) break;
    if (!isElementVisible(link)) continue;
    
    links.push({
      text: link.textContent.trim().substring(0, 50),
      href: link.href,
      title: link.title || null,
      ariaLabel: link.getAttribute('aria-label') || null
    });
  }
  
  return links;
}

/**
 * Extract headings
 */
function extractHeadings() {
  const headings = [];
  const headingElements = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
  
  for (const heading of headingElements) {
    if (!isElementVisible(heading)) continue;
    
    headings.push({
      level: parseInt(heading.tagName[1]),
      text: heading.textContent.trim().substring(0, 100)
    });
  }
  
  return headings;
}

/**
 * Get DOM statistics
 */
function getDOMStats() {
  return {
    totalElements: document.querySelectorAll('*').length,
    interactiveElements: document.querySelectorAll('button, a, input, textarea, select, [onclick], [role="button"]').length,
    forms: document.querySelectorAll('form').length,
    images: document.querySelectorAll('img').length,
    iframes: document.querySelectorAll('iframe').length
  };
}

/**
 * Extract relevant CSS styles
 */
function extractRelevantStyles() {
  // Extract theme colors and common patterns
  const bodyStyle = window.getComputedStyle(document.body);
  
  return {
    backgroundColor: bodyStyle.backgroundColor,
    color: bodyStyle.color,
    fontFamily: bodyStyle.fontFamily,
    fontSize: bodyStyle.fontSize
  };
}

/**
 * Convert page context to a compact string for LLM prompts
 * @param {object} context - Page context object
 * @returns {string} Compact string representation
 */
export function contextToString(context) {
  const parts = [];
  
  parts.push(`URL: ${context.url}`);
  parts.push(`Title: ${context.title}`);
  
  if (context.forms.length > 0) {
    parts.push(`\nForms (${context.forms.length}):`);
    context.forms.forEach((form, i) => {
      parts.push(`  Form ${i + 1}: ${form.fields.length} fields`);
      form.fields.slice(0, 5).forEach(field => {
        parts.push(`    - ${field.type || field.tag}: ${field.label || field.placeholder || field.name || 'unlabeled'}`);
      });
    });
  }
  
  if (context.elements.length > 0) {
    parts.push(`\nVisible Interactive Elements (${context.elements.length}):`);
    context.elements.slice(0, 20).forEach((el, i) => {
      const desc = el.attributes['aria-label'] || el.text || el.attributes.placeholder || el.id || `${el.tag}${el.type ? `[${el.type}]` : ''}`;
      parts.push(`  ${i + 1}. ${el.tag}: "${desc.substring(0, 50)}"`);
    });
  }
  
  if (context.links.length > 0) {
    parts.push(`\nLinks (${context.links.length}):`);
    context.links.slice(0, 10).forEach(link => {
      parts.push(`  - "${link.text}" → ${link.href}`);
    });
  }
  
  if (context.headings.length > 0) {
    parts.push(`\nHeadings:`);
    context.headings.slice(0, 5).forEach(h => {
      parts.push(`  H${h.level}: ${h.text}`);
    });
  }
  
  return parts.join('\n');
}

/**
 * Find element matching description in context
 * @param {string} description - Element description
 * @param {object} context - Page context
 * @returns {object|null} Matching element info
 */
export function findElementInContext(description, context) {
  const lowerDesc = description.toLowerCase();
  
  // Try to find in elements array
  for (const el of context.elements) {
    // Check text content
    if (el.text && el.text.toLowerCase().includes(lowerDesc)) {
      return el;
    }
    
    // Check aria-label
    if (el.attributes['aria-label'] && el.attributes['aria-label'].toLowerCase().includes(lowerDesc)) {
      return el;
    }
    
    // Check placeholder
    if (el.attributes.placeholder && el.attributes.placeholder.toLowerCase().includes(lowerDesc)) {
      return el;
    }
    
    // Check name
    if (el.attributes.name && el.attributes.name.toLowerCase().includes(lowerDesc)) {
      return el;
    }
    
    // Check id
    if (el.id && el.id.toLowerCase().includes(lowerDesc)) {
      return el;
    }
  }
  
  return null;
}
