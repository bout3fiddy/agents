/**
 * Shared browser utilities for Puppeteer automation scripts.
 * Provides browser lifecycle management, page creation, and JSON output helpers.
 */

import puppeteer from 'puppeteer';
import { existsSync, unlinkSync, statSync, renameSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

// Singleton browser instance for session reuse
let browserInstance = null;

// Default launch options
const DEFAULT_LAUNCH_OPTIONS = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--window-size=1920,1080'
  ]
};

// Default page options
const DEFAULT_PAGE_OPTIONS = {
  waitUntil: 'networkidle2',
  timeout: 30000
};

/**
 * Get or create a browser instance.
 * Supports connecting to existing browser via WebSocket or launching new one.
 */
export async function getBrowser(options = {}) {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  const launchOptions = {
    ...DEFAULT_LAUNCH_OPTIONS,
    headless: options.headless !== false,
    args: [...DEFAULT_LAUNCH_OPTIONS.args]
  };

  if (options.browserUrl || options.wsEndpoint) {
    // Connect to existing browser
    browserInstance = await puppeteer.connect({
      browserURL: options.browserUrl,
      browserWSEndpoint: options.wsEndpoint
    });
  } else {
    // Launch new browser
    browserInstance = await puppeteer.launch(launchOptions);
  }

  return browserInstance;
}

/**
 * Get a page from the browser.
 * Reuses existing page if available, otherwise creates new one.
 */
export async function getPage(browser, options = {}) {
  const pages = await browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();

  // Set viewport
  await page.setViewport({
    width: options.width || 1920,
    height: options.height || 1080,
    deviceScaleFactor: options.deviceScaleFactor || 1
  });

  // Set user agent if specified
  if (options.userAgent) {
    await page.setUserAgent(options.userAgent);
  }

  return page;
}

/**
 * Navigate to a URL with configurable wait strategy.
 */
export async function navigateTo(page, url, options = {}) {
  const waitUntil = options.waitUntil || DEFAULT_PAGE_OPTIONS.waitUntil;
  const timeout = options.timeout || DEFAULT_PAGE_OPTIONS.timeout;

  await page.goto(url, { waitUntil, timeout });

  return {
    url: page.url(),
    title: await page.title()
  };
}

/**
 * Close the browser instance.
 */
export async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Conditionally close browser based on options.
 */
export async function maybeCloseBrowser(shouldClose = true) {
  if (shouldClose) {
    await closeBrowser();
  }
}

/**
 * Output JSON to stdout and exit.
 */
export function outputJSON(data, exitCode = 0) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(exitCode);
}

/**
 * Output error JSON to stderr and exit.
 */
export function outputError(error, exitCode = 1) {
  console.error(JSON.stringify({
    success: false,
    error: error.message || String(error)
  }, null, 2));
  process.exit(exitCode);
}

/**
 * Wait for a selector with configurable timeout.
 */
export async function waitForSelector(page, selector, options = {}) {
  const timeout = options.timeout || DEFAULT_PAGE_OPTIONS.timeout;
  const visible = options.visible !== false;

  // Handle XPath selectors
  if (selector.startsWith('//') || selector.startsWith('(//')) {
    await page.waitForSelector(`::-p-xpath(${selector})`, { timeout, visible });
    return page.$$(`::-p-xpath(${selector})`);
  }

  await page.waitForSelector(selector, { timeout, visible });
  return page.$(selector);
}

/**
 * Compress image using ImageMagick if available and file exceeds size limit.
 * @param {string} filePath - Path to the image file
 * @param {number} maxSizeMB - Maximum file size in MB (default: 5)
 * @returns {object} Compression result with metadata
 */
export function compressImage(filePath, maxSizeMB = 5) {
  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  const stats = statSync(filePath);
  const originalSize = stats.size;

  if (originalSize <= maxSizeBytes) {
    return {
      compressed: false,
      originalSize,
      size: originalSize
    };
  }

  // Check if ImageMagick is available
  let magickCmd = null;
  try {
    execSync('magick -version', { stdio: 'ignore' });
    magickCmd = 'magick';
  } catch {
    try {
      execSync('convert -version', { stdio: 'ignore' });
      magickCmd = 'convert';
    } catch {
      // ImageMagick not available
      return {
        compressed: false,
        originalSize,
        size: originalSize,
        warning: 'ImageMagick not installed - cannot compress'
      };
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const tempPath = filePath + '.tmp' + ext;

  try {
    // First attempt: moderate compression
    if (ext === '.png') {
      execSync(`${magickCmd} "${filePath}" -resize 90% -quality 85 "${tempPath}"`, { stdio: 'ignore' });
    } else if (ext === '.jpg' || ext === '.jpeg') {
      execSync(`${magickCmd} "${filePath}" -quality 80 -interlace Plane "${tempPath}"`, { stdio: 'ignore' });
    } else {
      // Convert other formats to JPEG
      execSync(`${magickCmd} "${filePath}" -quality 80 "${tempPath}"`, { stdio: 'ignore' });
    }

    let newStats = statSync(tempPath);

    // If still too large, try more aggressive compression
    if (newStats.size > maxSizeBytes) {
      if (ext === '.png') {
        execSync(`${magickCmd} "${filePath}" -resize 75% -quality 70 "${tempPath}"`, { stdio: 'ignore' });
      } else {
        execSync(`${magickCmd} "${filePath}" -quality 60 -interlace Plane "${tempPath}"`, { stdio: 'ignore' });
      }
      newStats = statSync(tempPath);
    }

    renameSync(tempPath, filePath);

    const finalStats = statSync(filePath);
    const ratio = ((1 - finalStats.size / originalSize) * 100).toFixed(2);

    return {
      compressed: true,
      originalSize,
      size: finalStats.size,
      compressionRatio: `${ratio}%`
    };
  } catch (error) {
    // Cleanup temp file if exists
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
    return {
      compressed: false,
      originalSize,
      size: originalSize,
      error: error.message
    };
  }
}

/**
 * Parse common CLI arguments.
 */
export function parseCommonArgs(argv) {
  return {
    url: argv.url,
    headless: argv.headless !== false,
    close: argv.close !== false,
    timeout: parseInt(argv.timeout) || DEFAULT_PAGE_OPTIONS.timeout,
    waitUntil: argv['wait-until'] || DEFAULT_PAGE_OPTIONS.waitUntil,
    selector: argv.selector,
    output: argv.output
  };
}

export default {
  getBrowser,
  getPage,
  navigateTo,
  closeBrowser,
  maybeCloseBrowser,
  outputJSON,
  outputError,
  waitForSelector,
  compressImage,
  parseCommonArgs
};
