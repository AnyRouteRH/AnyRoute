'use client';
import { useEffect } from 'react';
import { receiptIdFromSearch } from '../lib/privacy.js';
import { recordGettingStartedReceiptVisit } from '../lib/getting-started.js';
export default function GettingStartedReceiptVisit() {
  useEffect(() => {
    try { recordGettingStartedReceiptVisit(window.localStorage, receiptIdFromSearch(window.location.search)); } catch { /* Optional browser preference. */ }
  }, []);
  return null;
}
