// Make the site name in the header clickable (linking to the documentation home)
//
// Zensical/Material renders the site name as plain text, while the home link
// is attached to the (optionally hidden) logo button. Our CSS hides the logo,
// so we recreate the link on the visible site name.
(function () {
  const logo = document.querySelector('header.md-header a.md-logo');
  const href = logo && logo.getAttribute('href');
  if (!href) return;

  const siteName = document.querySelector(
    'header.md-header .md-header__title .md-header__topic:not([data-md-component]) > .md-ellipsis'
  );
  if (!siteName) return;

  // Already linked
  if (siteName.closest('a')) return;

  const a = document.createElement('a');
  a.href = href;
  a.className = siteName.className;
  a.textContent = (siteName.textContent || '').trim();
  a.setAttribute('aria-label', 'Home');

  siteName.replaceWith(a);
})();
