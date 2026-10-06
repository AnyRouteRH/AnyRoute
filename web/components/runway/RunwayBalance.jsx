'use client';
import useRunway from './useRunway.js';
import { BalanceLink } from '../nav/AccountTrigger.js';
import s from './Runway.module.css';
export default function RunwayBalance({ apiKey, snapshot, className }) {
  const runway = useRunway(apiKey);
  return <BalanceLink snapshot={{ ...snapshot, runway }} className={`${className} ${s.balance}`}/>;
}
