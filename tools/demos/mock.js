// Fake Tauri API for recording the site GIFs in a browser. Injected into
// every frame; each iframe is one Memo window (?label=note-x / group-x /
// manager). All state lives in the top window (stage.js: window.Memo).
(() => {
  if (window === window.top) return;
  const params = new URLSearchParams(location.search);
  const label = params.get('label') || 'manager';
  const top = window.top;
  const style = () => {
    const s = document.createElement('style');
    s.textContent = ':root{--font-ui:Inter,sans-serif;--font-mono:"JetBrains Mono",monospace}';
    document.head.append(s);
  };
  if (document.head) style(); else document.addEventListener('DOMContentLoaded', style);
  const win = {
    setTitle: async () => {}, innerPosition: async () => ({ x: 0, y: 0 }),
    innerSize: async () => ({ width: innerWidth, height: innerHeight }), scaleFactor: async () => 1,
    startDragging: async () => {}, setFocus: async () => {}, close: async () => {}, hide: async () => {},
    show: async () => {}, label,
  };
  window.__TAURI__ = {
    core: { invoke: (cmd, args) => top.Memo.invoke(label, cmd, args || {}, window) },
    event: {
      listen: (ev, cb) => Promise.resolve(top.Memo.listen(ev, cb, window)),
      emit: async () => {},
    },
    window: { getCurrentWindow: () => win },
    webviewWindow: { getCurrentWebviewWindow: () => win },
    app: { getVersion: async () => '0.4.0' },
  };
})();
