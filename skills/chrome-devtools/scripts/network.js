#!/usr/bin/env node
import { getBrowser, getPage, navigateTo, maybeCloseBrowser, outputJSON, outputError, parseCommonArgs } from './lib/browser.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { writeFileSync } from 'fs';

const argv = yargs(hideBin(process.argv))
  .option('url', { type: 'string', demandOption: true, describe: 'URL to monitor' })
  .option('duration', { type: 'number', default: 5000, describe: 'Monitoring duration in ms' })
  .option('filter', { type: 'string', describe: 'Filter requests by URL pattern (regex)' })
  .option('output', { type: 'string', describe: 'Save results to file' })
  .option('headless', { type: 'boolean', default: true, describe: 'Run in headless mode' })
  .option('close', { type: 'boolean', default: true, describe: 'Close browser after monitoring' })
  .option('timeout', { type: 'number', default: 30000, describe: 'Navigation timeout in ms' })
  .option('wait-until', { type: 'string', default: 'networkidle2', describe: 'Wait until: load, domcontentloaded, networkidle0, networkidle2' })
  .help()
  .argv;

async function main() {
  const args = parseCommonArgs(argv);
  const requests = [];
  const filter = argv.filter ? new RegExp(argv.filter) : null;

  try {
    const browser = await getBrowser({ headless: args.headless });
    const page = await getPage(browser);

    page.on('request', request => {
      const url = request.url();
      if (!filter || filter.test(url)) {
        requests.push({
          url,
          method: request.method(),
          resourceType: request.resourceType(),
          headers: request.headers(),
          timestamp: new Date().toISOString()
        });
      }
    });

    page.on('response', response => {
      const url = response.url();
      if (!filter || filter.test(url)) {
        const request = requests.find(r => r.url === url && !r.status);
        if (request) {
          request.status = response.status();
          request.statusText = response.statusText();
          request.responseHeaders = response.headers();
        }
      }
    });

    page.on('requestfailed', request => {
      const url = request.url();
      if (!filter || filter.test(url)) {
        const req = requests.find(r => r.url === url && !r.status);
        if (req) {
          req.failed = true;
          req.failureText = request.failure()?.errorText;
        }
      }
    });

    await navigateTo(page, args.url, {
      timeout: args.timeout,
      waitUntil: args.waitUntil
    });

    await new Promise(resolve => setTimeout(resolve, argv.duration));

    await maybeCloseBrowser(args.close);

    const result = {
      success: true,
      url: args.url,
      duration: argv.duration,
      requestCount: requests.length,
      failedCount: requests.filter(r => r.failed).length,
      requests
    };

    if (argv.output) {
      writeFileSync(argv.output, JSON.stringify(result, null, 2));
      result.savedTo = argv.output;
    }

    outputJSON(result);
  } catch (error) {
    await maybeCloseBrowser(true);
    outputError(error);
  }
}

main();
