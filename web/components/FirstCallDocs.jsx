'use client';
import FirstCallQuickstart from './account/FirstCallQuickstart';
import { useAccountKey } from './account/useAccountKey.js';
export default function FirstCallDocs() {
  const [key] = useAccountKey();
  return <FirstCallQuickstart apiKey={key}/>;
}
