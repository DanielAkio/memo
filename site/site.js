// Download buttons: names the visitor's system ("Download for Windows") and
// points the button straight at that system's installer from the latest
// release, so the click downloads instead of opening the release page. The
// installer names carry the version, so they are looked up through the
// GitHub API; until it answers, or if it fails, the links keep their
// fallback href (the latest release page). Windows and Mac visitors also
// get the steps past their system's warning ([data-os]).
(function () {
  var ua = navigator.userAgent;
  var os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Android|iPhone|iPad/.test(ua) ? '' : /Linux/.test(ua) ? 'Linux' : '';
  if (!os) return;
  // A bilingual page has a button per language: each takes its own lang.
  var buttons = document.querySelectorAll('[data-download]');
  buttons.forEach(function (a) {
    var pt = (a.closest('[lang]') || document.documentElement).lang.indexOf('pt') === 0;
    a.textContent = (pt ? 'Baixar para ' : 'Download for ') + os;
  });

  // Unsigned installers make browsers and SmartScreen warn about the
  // download, and macOS blocks the app on first launch (it isn't
  // notarized): show the visitor's system the steps past that, which stay
  // hidden elsewhere. A download click also scrolls to them and flashes the
  // box, so they aren't missed; the installer still downloads, and the
  // release page (when the API hasn't answered) opens in a new tab to keep
  // the steps in sight.
  var note = document.querySelector('.os-note[data-os="' + os + '"]');
  if (note) {
    document.querySelectorAll('[data-os="' + os + '"]').forEach(function (el) { el.hidden = false; });
    var still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    buttons.forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
        e.preventDefault();
        if (/\/releases\/latest$/.test(a.href)) window.open(a.href, '_blank', 'noopener');
        else location.href = a.href;
        note.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
        note.classList.remove('flash');
        void note.offsetWidth;
        note.classList.add('flash');
      });
    });
  }

  // Every Mac browser reports "Intel" in its user agent. Chromium tells the
  // real architecture through userAgentData; elsewhere the WebGL renderer
  // names the GPU ("Apple M1" / "Apple GPU" on Apple chips). Apple chips are
  // the default: Intel Macs are no longer sold.
  function macArch() {
    var data = navigator.userAgentData;
    var hint = data && data.getHighEntropyValues
      ? data.getHighEntropyValues(['architecture']).then(function (v) { return v.architecture; })
      : Promise.resolve('');
    return hint.catch(function () { return ''; }).then(function (arch) {
      if (arch === 'arm') return 'aarch64';
      if (arch === 'x86') return 'x64';
      try {
        var gl = document.createElement('canvas').getContext('webgl');
        var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
        var gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
        if (/Intel|AMD|Radeon|NVIDIA/i.test(gpu)) return 'x64';
      } catch (e) {}
      return 'aarch64';
    });
  }

  // Installer suffix per system, matching the release asset names
  // (Memo_<version>_x64-setup.exe, Memo_<version>_aarch64.dmg, ...).
  var pattern = os === 'Windows' ? Promise.resolve(/_x64-setup\.exe$/)
    : os === 'macOS' ? macArch().then(function (arch) { return new RegExp('_' + arch + '\\.dmg$'); })
    : Promise.resolve(/_amd64\.AppImage$/);

  Promise.all([
    pattern,
    fetch('https://api.github.com/repos/DanielAkio/memo/releases/latest')
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
  ]).then(function (res) {
    var asset = (res[1].assets || []).filter(function (a) { return res[0].test(a.name); })[0];
    if (!asset) return;
    buttons.forEach(function (a) { a.href = asset.browser_download_url; });
    document.querySelectorAll('[data-platform="' + os + '"]').forEach(function (a) {
      a.href = asset.browser_download_url;
    });
  }).catch(function () {});
})();
