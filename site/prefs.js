// Visitor preferences, loaded in <head> so they apply before the page draws.
// Language: a visitor whose browser prefers Portuguese gets the pt/ pages,
// everyone else the English ones. Picking a language in the nav is
// remembered and wins over the browser from then on.
// Theme: follows the system's light/dark setting (style.css) until the
// visitor flips the nav's theme button; that choice is remembered and set
// as data-theme on <html>, which the CSS and the GIFs' <picture>s obey.
(function () {
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function save(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }

  // Each page and its translation ([en, pt], relative to the site root).
  var PAGES = [['', 'pt/'], ['index.html', 'pt/index.html'], ['privacy.html', 'pt/privacidade.html']];
  var path = location.pathname;
  var root = path.replace(/(pt\/)?[^\/]*$/, '');
  var here = path.slice(root.length);
  var pair = PAGES.filter(function (p) { return p[0] === here || p[1] === here; })[0];
  var isPt = document.documentElement.lang.indexOf('pt') === 0;

  if (pair) {
    var wanted = load('memo-lang');
    if (wanted !== 'pt' && wanted !== 'en') {
      var langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
      wanted = /^pt\b/i.test(langs[0] || '') ? 'pt' : 'en';
    }
    if ((wanted === 'pt') !== isPt) {
      location.replace(root + pair[wanted === 'pt' ? 1 : 0] + location.search + location.hash);
      return;
    }
  }

  var html = document.documentElement;
  var system = matchMedia('(prefers-color-scheme: dark)');
  var chosen = load('memo-theme');
  if (chosen === 'light' || chosen === 'dark') html.dataset.theme = chosen;
  function current() { return html.dataset.theme || (system.matches ? 'dark' : 'light'); }

  // The demo GIFs pick their light version with a prefers-color-scheme
  // <source>: under a chosen theme it matches always or never instead.
  function applyToPictures() {
    document.querySelectorAll('picture source[media*="prefers-color-scheme"], picture source[data-media]').forEach(function (src) {
      if (!src.dataset.media) src.dataset.media = src.media;
      var light = /light/.test(src.dataset.media);
      src.media = !html.dataset.theme ? src.dataset.media : (html.dataset.theme === 'light') === light ? 'all' : 'not all';
    });
  }

  function labelButtons() {
    var dark = current() === 'dark';
    var label = isPt ? (dark ? 'Mudar para o tema claro' : 'Mudar para o tema escuro')
      : (dark ? 'Switch to light theme' : 'Switch to dark theme');
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) { b.title = label; b.setAttribute('aria-label', label); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    applyToPictures();
    labelButtons();
    if (system.addEventListener) system.addEventListener('change', labelButtons);
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        html.dataset.theme = current() === 'dark' ? 'light' : 'dark';
        save('memo-theme', html.dataset.theme);
        applyToPictures();
        labelButtons();
      });
    });
    document.querySelectorAll('a[hreflang]').forEach(function (a) {
      a.addEventListener('click', function () { save('memo-lang', a.hreflang.indexOf('pt') === 0 ? 'pt' : 'en'); });
    });
  });
})();
