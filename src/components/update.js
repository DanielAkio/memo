// MemoUpdate: a newer Memo (updater.rs) as a notice in every window
// (components/toast.js): "New version X" with "Update and restart" and ✕,
// then the download's progress, or why it failed. ✕ hides it until a newer
// version or a manual check ("dismiss_update"); Settings and the tray keep
// offering it.
(function () {
  const t = (k, v) => window.MemoI18n.t(k, v);

  window.MemoUpdate = {
    attach({ invoke, listen }) {
      const install = () => invoke('install_update').catch((err) => console.error('install_update', err));
      const dismiss = () => {
        MemoToast.set('update', null);
        invoke('dismiss_update').catch((err) => console.error('dismiss_update', err));
      };
      const render = (s) => {
        const installing = Boolean(s && s.progress != null);
        if (!s || !s.available || (s.dismissed && !installing)) {
          MemoToast.set('update', null);
          return;
        }
        let text = t('updateNotice', { version: s.available });
        if (installing) text = t('updateDownloading', { percent: s.progress });
        else if (s.error === 'install') text = t('updateErrInstall');
        MemoToast.set('update', {
          text,
          action: installing ? null : { label: t('updateInstall'), run: install },
          onClose: installing ? null : dismiss,
        });
      };
      listen('update-changed', (e) => render(e.payload));
      invoke('get_updates').then(([, status]) => render(status)).catch((err) => console.error('get_updates', err));
    },
  };
})();
