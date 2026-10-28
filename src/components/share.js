// MemoShare: sharing memories, boards and groups as a link (share.rs): the
// titlebar's share button puts the item's link in the clipboard, and
// components/toast.js says so for a moment. Opening a link imports it (Memo
// Web asks where first, web.js; the desktop app imports right away).
(function () {
  const t = (k, v) => window.MemoI18n.t(k, v);

  window.MemoShare = {
    // "Share link": the link goes to the clipboard (share.rs writes it),
    // `args` = { kind, id } outside the item's own window.
    async copy(args) {
      const { invoke } = (window.__TAURI__ || window.parent.__TAURI__).core;
      try {
        await invoke('copy_share', args || {});
        MemoToast.flash('copied', t('shareCopied'), 3500);
      } catch (err) {
        console.error('copy_share', err);
        MemoToast.flash('copied', t(String(err).includes('too big') ? 'shareTooBig' : 'shareFailed'), 4500);
      }
    },
  };
})();
