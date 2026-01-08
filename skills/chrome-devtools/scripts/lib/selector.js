/**
 * Selector utilities for handling CSS and XPath selectors.
 */

/**
 * Check if a selector is XPath.
 */
export function isXPath(selector) {
  return selector.startsWith('//') || selector.startsWith('(//');
}

/**
 * Convert selector to Puppeteer-compatible format.
 * Puppeteer uses ::-p-xpath() prefix for XPath selectors.
 */
export function toPuppeteerSelector(selector) {
  if (isXPath(selector)) {
    return `::-p-xpath(${selector})`;
  }
  return selector;
}

/**
 * Generate a unique CSS selector for an element.
 */
export function generateSelector(element) {
  // This function is meant to be evaluated in page context
  if (element.id) {
    return `#${element.id}`;
  }

  const path = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let selector = current.tagName.toLowerCase();

    if (current.id) {
      selector = `#${current.id}`;
      path.unshift(selector);
      break;
    }

    // Add class names (first 2 classes max)
    const classes = Array.from(current.classList).slice(0, 2);
    if (classes.length > 0) {
      selector += '.' + classes.join('.');
    }

    // Add nth-child if needed for uniqueness
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        child => child.tagName === current.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-child(${index})`;
      }
    }

    path.unshift(selector);
    current = current.parentElement;

    // Stop at body
    if (current && current.tagName.toLowerCase() === 'body') {
      break;
    }
  }

  return path.join(' > ');
}

/**
 * Validate a CSS selector.
 */
export function isValidCSSSelector(selector) {
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

export default {
  isXPath,
  toPuppeteerSelector,
  generateSelector,
  isValidCSSSelector
};
