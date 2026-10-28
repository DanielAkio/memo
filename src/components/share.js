// MemoShare: sharing memories, boards and groups as a link (share.rs),
// shown with components/toast.js: "Link copied" for a moment after "Share
// link", and the offer to import the item of a link opened (share-available,
// to every window, until imported or dismissed), with Import and ✕. (Memo
// Web asks where to import a link's item in a dialog instead, web.js.)
(function () {
  const t = (k, v) => window.MemoI18n.t(k, v);
  let invoke = null;

  // "Shared memory “X”", "Shared board “X” · 3 memories", ...
  function offerText(s) {
    const name = s.name && s.name.trim() ? s.name.trim() : t('untitled');
    const key = s.kind === 'board' ? 'shareOfferBoard' : s.kind === 'group' ? 'shareOfferGroup' : 'shareOfferNote';
    let line = t(key, { name });
    if (s.kind !== 'note' && s.notes) line += ` · ${t(s.notes === 1 ? 'shareOneMemory' : 'shareMemories', { n: s.notes })}`;
    return line;
  }

  function offer(summary) {
    MemoToast.set('share', summary && {
      text: offerText(summary),
      action: {
        label: t('shareImport'),
        run: () => {
          MemoToast.set('share', null);
          invoke('import_share').catch((err) => console.error('import_share', err));
        },
      },
      onClose: () => {
        MemoToast.set('share', null);
        invoke('dismiss_share').catch((err) => console.error('dismiss_share', err));
      },
    });
  }

  window.MemoShare = {
    // Listens for offers in this window: { invoke, listen }.
    attach(options) {
      invoke = options.invoke;
      options.listen('share-available', (e) => offer(e.payload));
      // Opened while an item is offered: shows it too.
      invoke('share_offer').then(offer).catch((err) => console.error('share_offer', err));
    },
    // "Share link": the link goes to the clipboard (share.rs writes it),
    // `args` = { kind, id } outside the item's own window.
    async copy(args) {
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
