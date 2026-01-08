#!/usr/bin/env node
import { getBrowser, getPage, navigateTo, maybeCloseBrowser, outputJSON, outputError, parseCommonArgs, waitForSelector, compressImage } from './lib/browser.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import path from 'path';
import { statSync } from 'fs';

const argv = yargs(hideBin(process.argv))
  .option('url', { type: 'string', demandOption: true, describe: 'URL to screenshot' })
  .option('output', { type: 'string', demandOption: true, describe: 'Output file path' })
  .option('selector', { type: 'string', describe: 'CSS/XPath selector for element screenshot' })
  .option('full-page', { type: 'boolean', default: true, describe: 'Capture full page' })
  .option('headless', { type: 'boolean', default: true, describe: 'Run in headless mode' })
  .option('close', { type: 'boolean', default: true, describe: 'Close browser after screenshot' })
  .option('timeout', { type: 'number', default: 30000, describe: 'Timeout in ms' })
  .option('wait-until', { type: 'string', default: 'networkidle2', describe: 'Wait until: load, domcontentloaded, networkidle0, networkidle2' })
  .option('max-size', { type: 'number', default: 5, describe: 'Max file size in MB before compression' })
  .option('compress', { type: 'boolean', default: true, describe: 'Enable auto-compression' })
  .option('format', { type: 'string', describe: 'Image format: png, jpeg, webp' })
  .option('quality', { type: 'number', describe: 'Image quality (0-100, jpeg/webp only)' })
  .help()
  .argv;

async function main() {
  const args = parseCommonArgs(argv);

  try {
    const browser = await getBrowser({ headless: args.headless });
    const page = await getPage(browser);
    await navigateTo(page, args.url, {
      timeout: args.timeout,
      waitUntil: args.waitUntil
    });

    const outputPath = path.resolve(argv.output);
    const screenshotOptions = {
      path: outputPath,
      fullPage: argv['full-page']
    };

    if (argv.format) {
      screenshotOptions.type = argv.format;
    }
    if (argv.quality) {
      screenshotOptions.quality = argv.quality;
    }

    if (args.selector) {
      const element = await waitForSelector(page, args.selector, { timeout: args.timeout });
      await element.screenshot(screenshotOptions);
    } else {
      await page.screenshot(screenshotOptions);
    }

    let compressionResult = { compressed: false };
    if (argv.compress) {
      compressionResult = compressImage(outputPath, argv['max-size']);
    }

    const stats = statSync(outputPath);

    await maybeCloseBrowser(args.close);

    outputJSON({
      success: true,
      output: outputPath,
      url: args.url,
      size: stats.size,
      ...compressionResult
    });
  } catch (error) {
    await maybeCloseBrowser(true);
    outputError(error);
  }
}

main();
