import { TASKS } from './site-map.js';

// All matching runs in memory. Nothing is sent or retained.
const words = value => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+/g) || [];
const singular = word => word.length > 4 && word.endsWith('ies') ? word.slice(0, -3) + 'y'
  : word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
const normalize = value => words(value).map(singular).join(' ');

function oneEdit(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].flatMap((c, i) => c === b[i] ? [] : [i]);
    return diff.length === 1 || (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]);
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (short[i] === long[i] && i < short.length) i++;
  return short.slice(i) === long.slice(i + 1);
}

export function searchTasks(query, tasks = TASKS) {
  const q = normalize(query);
  if (!q) return tasks.filter(task => task.featured);
  const tokens = q.split(' ');
  const ranked = tasks.map((task, index) => {
    const title = normalize(task.title);
    const keywords = normalize(task.keywords.join(' '));
    const description = normalize(task.description);
    let score = title === q ? 600 : title.startsWith(q) ? 500 : title.includes(q) ? 400 : 0;
    if (!score) {
      const fields = [title.split(' '), keywords.split(' '), description.split(' ')];
      const scores = tokens.map(token => {
        if (fields[0].some(word => word.startsWith(token))) return 350;
        if (fields[1].some(word => word.startsWith(token))) return 300;
        if (fields[2].some(word => word.startsWith(token))) return 200;
        if (fields[0].some(word => oneEdit(token, word))) return 120;
        if (fields[1].some(word => oneEdit(token, word))) return 100;
        return 0;
      });
      score = scores.every(Boolean) ? Math.min(...scores) : 0;
    }
    return { task, index, score };
  });
  return ranked.filter(row => row.score).sort((a, b) => b.score - a.score || a.index - b.index).map(row => row.task);
}

// The Harness owns its keyboard shortcuts. Other dialogs also keep their keys.
export function isSearchShortcut(event, { pathname, editable = false, dialogOpen = false }) {
  if (event.defaultPrevented || event.isComposing || /^\/harness\/?$/.test(pathname) || dialogOpen) return false;
  const command = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';
  const slash = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !editable;
  return Boolean(command || slash);
}
