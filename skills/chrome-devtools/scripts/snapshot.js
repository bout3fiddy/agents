#!/usr/bin/env node
import { getBrowser, getPage, navigateTo, maybeCloseBrowser, outputJSON, outputError, parseCommonArgs } from './lib/browser.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('url', { type: 'string', demandOption: true, describe: 'URL to snapshot' })
  .option('headless', { type: 'boolean', default: true, describe: 'Run in headless mode' })
  .option('close', { type: 'boolean', default: true, describe: 'Close browser after snapshot' })
  .option('timeout', { type: 'number', default: 30000, describe: 'Timeout in ms' })
  .option('wait-until', { type: 'string', default: 'networkidle2', describe: 'Wait until: load, domcontentloaded, networkidle0, networkidle2' })
  .option('interactive-only', { type: 'boolean', default: true, describe: 'Only extract interactive elements' })
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

    const elements = await page.evaluate((interactiveOnly) => {
      const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'];
      const interactiveRoles = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'menu', 'menuitem', 'tab'];

      function getSelector(el) {
        if (el.id) return `#${el.id}`;

        const parts = [];
        let current = el;

        while (current && current.nodeType === 1) {
          let selector = current.tagName.toLowerCase();

          if (current.id) {
            parts.unshift(`#${current.id}`);
            break;
          }

          const classes = Array.from(current.classList).slice(0, 2);
          if (classes.length > 0) {
            selector += '.' + classes.join('.');
          }

          parts.unshift(selector);
          current = current.parentElement;

          if (current && current.tagName === 'BODY') break;
        }

        return parts.join(' > ');
      }

      function isInteractive(el) {
        if (interactiveTags.includes(el.tagName)) return true;
        const role = el.getAttribute('role');
        if (role && interactiveRoles.includes(role)) return true;
        if (el.onclick || el.hasAttribute('onclick')) return true;
        if (el.tabIndex >= 0) return true;
        return false;
      }

      const allElements = interactiveOnly
        ? Array.from(document.querySelectorAll('*')).filter(isInteractive)
        : Array.from(document.querySelectorAll('*'));

      return allElements.slice(0, 500).map(el => {
        const rect = el.getBoundingClientRect();
        return {
          tagName: el.tagName,
          id: el.id || null,
          className: el.className || null,
          text: el.textContent?.slice(0, 100)?.trim() || null,
          href: el.href || null,
          type: el.type || null,
          name: el.name || null,
          placeholder: el.placeholder || null,
          role: el.getAttribute('role') || null,
          ariaLabel: el.getAttribute('aria-label') || null,
          selector: getSelector(el),
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          visible: rect.width > 0 && rect.height > 0
        };
      }).filter(el => el.visible);
    }, argv['interactive-only']);

    const title = await page.title();

    await maybeCloseBrowser(args.close);

    outputJSON({
      success: true,
      url: args.url,
      title,
      elementCount: elements.length,
      elements
    });
  } catch (error) {
    await maybeCloseBrowser(true);
    outputError(error);
  }
}

main();
