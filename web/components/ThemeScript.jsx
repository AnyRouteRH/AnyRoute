import { THEME_SCRIPT } from '../lib/theme.js';
export default function ThemeScript() {
  return <script id="anyroute-theme" dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}/>;
}
