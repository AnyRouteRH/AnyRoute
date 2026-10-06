'use client';
import useRunway from './useRunway.js';
import { runwayText } from '../../lib/runway.js';
export default function RunwayHint({ apiKey, revision }) {
  const text = runwayText(useRunway(apiKey, revision));
  return text ? <p className="help-text">{text}</p> : null;
}
