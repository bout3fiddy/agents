#!/usr/bin/env node
import { getBrowser, getPage, navigateTo, maybeCloseBrowser, outputJSON, outputError, parseCommonArgs, waitForSelector } from './lib/browser.js';
import { toPuppeteerSelector, isXPath } from './lib/selector.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('url', { type: 'string', describe: 'URL to navigate to first' })
  .option('selector', { type: 'string', demandOption: true, describe: 'CSS/XPath selector to click' })
  .option('headless', { type: 'boolean', default: true, describe: 'Run in headless mode' })
  .option('close', { type: 'boolean', default: true, describe: 'Close browser after click' })
  .option('timeout', { type: 'number', default: 30000, describe: 'Timeout in ms' })
  .option('wait-until', { type: 'string', default: 'networkidle2', describe: 'Wait until: load, domcontentloaded, networkidle0, networkidle2' })
  .option('wait-for-navigation', { type: 'boolean', default: false, describe: 'Wait for navigation after click' })
  .help()
  .argv;

async function main() {
  const args = parseCommonArgs(argv);

  try {
    const browser = await getBrowser({ headless: args.headless });
    const page = await getPage(browser);

    if (args.url) {
      await navigateTo(page, args.url, {
        timeout: args.timeout,
        waitUntil: args.waitUntil
      });
    }

    const element = await waitForSelector(page, args.selector, { timeout: args.timeout });

    if (!element) {
      throw new Error(`Element not found: ${args.selector}`);
    }

    if (argv['wait-for-navigation']) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: args.waitUntil, timeout: args.timeout }),
        element.click()
      ]);
    } else {
      await element.click();
    }

    const url = page.url();
    const title = await page.title();

    await maybeCloseBrowser(args.close);

    outputJSON({
      success: true,
      selector: args.selector,
      url,
      title
    });
  } catch (error) {
    await maybeCloseBrowser(true);
    outputError(error);
  }
}

main();
