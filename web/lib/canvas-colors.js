// C126: brand canvases use invariant tokens, including in dark mode.
export function canvasColors(element) {
  const style = getComputedStyle(element);
  const value = name => style.getPropertyValue(`--${name}`).trim();
  const alpha = (name, opacity) => {
    const hex = value(name).replace('#', '');
    const rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    return `rgba(${rgb.join(',')},${opacity})`;
  };
  return { value, alpha };
}
