// Names the visitor's system on the download buttons ("Download for Windows").
(function () {
  var ua = navigator.userAgent;
  var os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Android|iPhone|iPad/.test(ua) ? '' : /Linux/.test(ua) ? 'Linux' : '';
  if (!os) return;
  var pt = document.documentElement.lang.indexOf('pt') === 0;
  var label = (pt ? 'Baixar para ' : 'Download for ') + os;
  document.querySelectorAll('[data-download]').forEach(function (a) { a.textContent = label; });
})();
