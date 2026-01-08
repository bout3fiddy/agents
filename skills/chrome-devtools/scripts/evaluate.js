#!/usr/bin/env node
import { getBrowser, getPage, navigateTo, maybeCloseBrowser, outputJSON, outputError, parseCommonArgs } from './lib/browser.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('url', { type: 'string', describe: 'URL to navigate to first' })
  .option('script', { type: 'string', demandOption: true, describe: 'JavaScript to execute in page context' })
  .option('headless', { type: 'boolean', default: true, describe: 'Run in headless mode' })
  .option('close', { type: 'boolean', default: true, describe: 'Close browser after evaluation' })
  .option('timeout', { type: 'number', default: 30000, describe: 'Timeout in ms' })
  .option('wait-until', { type: 'string', default: 'networkidle2', describe: 'Wait until: load, domcontentloaded, networkidle0, networkidle2' })
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

    const result = await page.evaluate(argv.script);
    const url = page.url();

    await maybeCloseBrowser(args.close);

    outputJSON({
      success: true,
      result,
      url
    });
  } catch (error) {
    await maybeCloseBrowser(true);
    outputError(error);
  }
}

main();
