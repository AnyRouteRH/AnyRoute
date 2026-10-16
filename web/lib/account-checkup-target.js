// J177: only public hashes and fixed control names go into links.
const controls = { telegram: { tab: 'Settings', title: 'Telegram' }, security: { tab: 'Settings', title: 'Security alerts' }, balance: { tab: 'Payments', title: 'Balance alert' }, notifications: { tab: 'Notifications', title: 'Notifications' } };
export function checkupTarget(search) {
  const query = new URLSearchParams(search), control = query.get('checkup');
  if (['expiry', 'limit', 'ip'].includes(control)) {
    const hash = query.get('checkup_key');
    return /^[a-f0-9]{64}$/.test(hash || '') ? { control, hash, tab: 'API keys' } : null;
  }
  return Object.hasOwn(controls, control) ? { control, ...controls[control] } : null;
}
export function checkupControl(root, target) {
  if (target.hash) return root.querySelector({ expiry: '#key-expiry', ip: 'dialog textarea', limit: '#key-limits-budget' }[target.control]);
  const heading = [...root.querySelectorAll('h2,h3')].find(node => node.textContent === target.title);
  return heading?.closest('section')?.querySelector('input:not(:disabled),button:not(:disabled)');
}
