#!/usr/bin/env node
import { getBrowser, getPage, navigateTo, maybeCloseBrowser, outputJSON, outputError, parseCommonArgs } from './lib/browser.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { writeFileSync } from 'fs';
import path from 'path';

const argv = yargs(hideBin(process.argv))
  .option('url', { type: 'string', demandOption: true, describe: 'URL to analyze' })
  .option('trace', { type: 'string', describe: 'Save trace to file' })
  .option('headless', { type: 'boolean', default: true, describe: 'Run in headless mode' })
  .option('close', { type: 'boolean', default: true, describe: 'Close browser after analysis' })
  .option('timeout', { type: 'number', default: 30000, describe: 'Navigation timeout in ms' })
  .option('wait-until', { type: 'string', default: 'networkidle2', describe: 'Wait until: load, domcontentloaded, networkidle0, networkidle2' })
  .option('throttle-cpu', { type: 'number', describe: 'CPU throttling factor (e.g., 4 for 4x slowdown)' })
  .option('throttle-network', { type: 'string', describe: 'Network preset: slow3g, fast3g, 4g' })
  .help()
  .argv;

const networkPresets = {
  slow3g: { downloadThroughput: 500 * 1024 / 8, uploadThroughput: 500 * 1024 / 8, latency: 400 },
  fast3g: { downloadThroughput: 1.5 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8, latency: 150 },
  '4g': { downloadThroughput: 4 * 1024 * 1024 / 8, uploadThroughput: 3 * 1024 * 1024 / 8, latency: 100 }
};

async function main() {
  const args = parseCommonArgs(argv);

  try {
    const browser = await getBrowser({ headless: args.headless });
    const page = await getPage(browser);
    const client = await page.createCDPSession();

    if (argv['throttle-cpu']) {
      await client.send('Emulation.setCPUThrottlingRate', { rate: argv['throttle-cpu'] });
    }

    if (argv['throttle-network']) {
      const preset = networkPresets[argv['throttle-network']];
      if (preset) {
        await client.send('Network.emulateNetworkConditions', {
          offline: false,
          ...preset
        });
      }
    }

    if (argv.trace) {
      await page.tracing.start({ path: argv.trace, screenshots: true });
    }

    const startTime = Date.now();
    await navigateTo(page, args.url, {
      timeout: args.timeout,
      waitUntil: args.waitUntil
    });
    const loadTime = Date.now() - startTime;

    if (argv.trace) {
      await page.tracing.stop();
    }

    const metrics = await page.metrics();
    const performanceTiming = await page.evaluate(() => {
      const timing = performance.timing;
      const navigationStart = timing.navigationStart;
      return {
        dnsLookup: timing.domainLookupEnd - timing.domainLookupStart,
        tcpConnect: timing.connectEnd - timing.connectStart,
        ttfb: timing.responseStart - navigationStart,
        domContentLoaded: timing.domContentLoadedEventEnd - navigationStart,
        loadComplete: timing.loadEventEnd - navigationStart,
        domInteractive: timing.domInteractive - navigationStart
      };
    });

    const vitals = await page.evaluate(() => {
      return new Promise(resolve => {
        const result = {};

        const lcpObserver = new PerformanceObserver(list => {
          const entries = list.getEntries();
          const lastEntry = entries[entries.length - 1];
          result.LCP = Math.round(lastEntry.startTime);
        });
        lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });

        const clsObserver = new PerformanceObserver(list => {
          let cls = 0;
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              cls += entry.value;
            }
          }
          result.CLS = Math.round(cls * 1000) / 1000;
        });
        clsObserver.observe({ type: 'layout-shift', buffered: true });

        const fidObserver = new PerformanceObserver(list => {
          const entries = list.getEntries();
          if (entries.length > 0) {
            result.FID = Math.round(entries[0].processingStart - entries[0].startTime);
          }
        });
        fidObserver.observe({ type: 'first-input', buffered: true });

        const paintEntries = performance.getEntriesByType('paint');
        for (const entry of paintEntries) {
          if (entry.name === 'first-paint') {
            result.FP = Math.round(entry.startTime);
          }
          if (entry.name === 'first-contentful-paint') {
            result.FCP = Math.round(entry.startTime);
          }
        }

        setTimeout(() => {
          lcpObserver.disconnect();
          clsObserver.disconnect();
          fidObserver.disconnect();
          resolve(result);
        }, 1000);
      });
    });

    await maybeCloseBrowser(args.close);

    const result = {
      success: true,
      url: args.url,
      loadTime,
      vitals,
      timing: performanceTiming,
      metrics: {
        jsHeapUsedSize: metrics.JSHeapUsedSize,
        jsHeapTotalSize: metrics.JSHeapTotalSize,
        documents: metrics.Documents,
        frames: metrics.Frames,
        jsEventListeners: metrics.JSEventListeners,
        nodes: metrics.Nodes,
        layoutCount: metrics.LayoutCount,
        styleRecalcCount: metrics.RecalcStyleCount
      }
    };

    if (argv.trace) {
      result.trace = path.resolve(argv.trace);
    }

    outputJSON(result);
  } catch (error) {
    await maybeCloseBrowser(true);
    outputError(error);
  }
}

main();
