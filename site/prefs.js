// Visitor preferences, loaded in <head> so they apply before the page draws.
// Language: a visitor whose browser prefers Portuguese gets the pt/ pages,
// everyone else the English ones. Picking a language in the nav is
// remembered and wins over the browser from then on.
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

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('a[hreflang]').forEach(function (a) {
      a.addEventListener('click', function () { save('memo-lang', a.hreflang.indexOf('pt') === 0 ? 'pt' : 'en'); });
    });
  });
})();
