#!/usr/bin/env node
import { getBrowser, getPage, navigateTo, maybeCloseBrowser, outputJSON, outputError, parseCommonArgs } from './lib/browser.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('url', { type: 'string', demandOption: true, describe: 'URL to monitor' })
  .option('types', { type: 'string', default: 'all', describe: 'Message types: log,warn,error,info,debug,all' })
  .option('duration', { type: 'number', default: 5000, describe: 'Monitoring duration in ms' })
  .option('headless', { type: 'boolean', default: true, describe: 'Run in headless mode' })
  .option('close', { type: 'boolean', default: true, describe: 'Close browser after monitoring' })
  .option('timeout', { type: 'number', default: 30000, describe: 'Navigation timeout in ms' })
  .option('wait-until', { type: 'string', default: 'networkidle2', describe: 'Wait until: load, domcontentloaded, networkidle0, networkidle2' })
  .help()
  .argv;

async function main() {
  const args = parseCommonArgs(argv);
  const messages = [];
  const allowedTypes = argv.types === 'all'
    ? ['log', 'warn', 'error', 'info', 'debug']
    : argv.types.split(',').map(t => t.trim());

  try {
    const browser = await getBrowser({ headless: args.headless });
    const page = await getPage(browser);

    page.on('console', msg => {
      const type = msg.type();
      if (allowedTypes.includes(type)) {
        messages.push({
          type,
          text: msg.text(),
          location: msg.location(),
          timestamp: new Date().toISOString()
        });
      }
    });

    page.on('pageerror', error => {
      if (allowedTypes.includes('error')) {
        messages.push({
          type: 'pageerror',
          text: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString()
        });
      }
    });

    await navigateTo(page, args.url, {
      timeout: args.timeout,
      waitUntil: args.waitUntil
    });

    await new Promise(resolve => setTimeout(resolve, argv.duration));

    await maybeCloseBrowser(args.close);

    const errorCount = messages.filter(m => m.type === 'error' || m.type === 'pageerror').length;
    const warnCount = messages.filter(m => m.type === 'warn').length;

    outputJSON({
      success: true,
      url: args.url,
      duration: argv.duration,
      messageCount: messages.length,
      errorCount,
      warnCount,
      messages
    });
  } catch (error) {
    await maybeCloseBrowser(true);
    outputError(error);
  }
}

main();
