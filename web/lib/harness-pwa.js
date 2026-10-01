export function isInstalled(navigator, matchMedia) {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

export function isIOS(navigator) {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// Attach before registration so the browser's install event cannot race the UI.
export function listenForInstall(win, onChange) {
  let prompt = null;
  const update = () => onChange({ prompt, installed: isInstalled(win.navigator, win.matchMedia.bind(win)), ios: isIOS(win.navigator) });
  const before = event => { event.preventDefault(); prompt = event; update(); };
  const installed = () => { prompt = null; onChange({ prompt: null, installed: true, ios: isIOS(win.navigator) }); };
  const display = win.matchMedia('(display-mode: standalone)');
  win.addEventListener('beforeinstallprompt', before);
  win.addEventListener('appinstalled', installed);
  display.addEventListener('change', update);
  update();
  return () => {
    win.removeEventListener('beforeinstallprompt', before);
    win.removeEventListener('appinstalled', installed);
    display.removeEventListener('change', update);
  };
}
