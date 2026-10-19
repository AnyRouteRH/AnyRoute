import KeyboardShortcuts from '../components/shortcuts/KeyboardShortcuts'; // K193

export default function Template({ children }) {
  return <>{children}<KeyboardShortcuts/></>;
}
