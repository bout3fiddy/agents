#!/usr/bin/env node
import { getBrowser, getPage, navigateTo, maybeCloseBrowser, outputJSON, outputError, parseCommonArgs, waitForSelector } from './lib/browser.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('url', { type: 'string', describe: 'URL to navigate to first' })
  .option('selector', { type: 'string', demandOption: true, describe: 'CSS/XPath selector for input field' })
  .option('value', { type: 'string', demandOption: true, describe: 'Value to fill' })
  .option('clear', { type: 'boolean', default: true, describe: 'Clear field before typing' })
  .option('headless', { type: 'boolean', default: true, describe: 'Run in headless mode' })
  .option('close', { type: 'boolean', default: true, describe: 'Close browser after fill' })
  .option('timeout', { type: 'number', default: 30000, describe: 'Timeout in ms' })
  .option('wait-until', { type: 'string', default: 'networkidle2', describe: 'Wait until: load, domcontentloaded, networkidle0, networkidle2' })
  .option('delay', { type: 'number', default: 0, describe: 'Typing delay in ms between characters' })
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

    if (argv.clear) {
      await element.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
    }

    await element.type(argv.value, { delay: argv.delay });

    const url = page.url();

    await maybeCloseBrowser(args.close);

    outputJSON({
      success: true,
      selector: args.selector,
      value: argv.value,
      url
    });
  } catch (error) {
    await maybeCloseBrowser(true);
    outputError(error);
  }
}

main();
