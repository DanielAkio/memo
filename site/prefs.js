// Visitor preferences, loaded in <head> so they apply before the page draws.
// Language: a visitor whose browser prefers Portuguese sees the pages in
// Portuguese, everyone else in English. Picking a language in the nav
// switches in place, is remembered and wins over the browser from then on.
// Theme: follows the system's light/dark setting (style.css) until the
// visitor flips the nav's theme button; that choice is remembered and set
// as data-theme on <html>, which the CSS and the GIFs' <picture>s obey.
(function () {
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function save(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }

  var html = document.documentElement;

  // Bilingual pages carry both texts, marked lang="en" / lang="pt-BR";
  // style.css shows the ones matching <html lang>. ?lang=pt|en (the nav's
  // links, old pt/ addresses) counts as a pick.
  var bilingual = html.hasAttribute('data-bilingual');
  var asked = (location.search.match(/[?&]lang=(pt|en)\b/) || [])[1];
  if (asked) {
    save('memo-lang', asked);
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.hash);
  }
  function pickedLang() {
    var lang = load('memo-lang');
    if (lang === 'pt' || lang === 'en') return lang;
    var langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    return /^pt\b/i.test(langs[0] || '') ? 'pt' : 'en';
  }
  var isPt = bilingual ? pickedLang() === 'pt' : html.lang.indexOf('pt') === 0;
  if (bilingual) html.lang = isPt ? 'pt-BR' : 'en';

  // Title and description have no room for both texts: the Portuguese ones
  // wait in data-pt and swap with the English ones.
  function setLang(pt) {
    isPt = pt;
    html.lang = pt ? 'pt-BR' : 'en';
    document.querySelectorAll('title[data-pt], meta[data-pt]').forEach(function (el) {
      var isTitle = el.tagName === 'TITLE';
      if (!el.dataset.en) el.dataset.en = isTitle ? el.textContent : el.content;
      var text = pt ? el.dataset.pt : el.dataset.en;
      if (isTitle) el.textContent = text; else el.content = text;
    });
    labelButtons();
  }

  // Theme
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
    if (bilingual) setLang(isPt);
    document.querySelectorAll('a[data-lang]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
        e.preventDefault();
        save('memo-lang', a.dataset.lang);
        setLang(a.dataset.lang === 'pt');
      });
    });
  });
})();
