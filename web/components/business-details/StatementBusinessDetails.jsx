'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { statementPath } from '../../lib/statements.js';
import { billedToLines, downloadStatementCsv } from '../../lib/business-details.js';
import { Button } from '../UI';
import s from './BusinessDetails.module.css';
export function BilledTo({ details }) {
  const lines = billedToLines(details);
  return lines.length ? <section className={s.billed} aria-label="Billed to"><h3>Billed to</h3><p>User-entered · outside the signed statement. Anyroute has not verified these details.</p><dl>{lines.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section> : null;
}
export default function StatementBusinessDetails({ statement, apiKey }) {
  const [record, setRecord] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setRecord(null); setError('');
    // Use the existing statement read authority, including its read-only allow-list.
    api(statementPath(statement.payload.month) + '?business_details=true', { key: apiKey, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setRecord({ statement, details: result.data.business_details });
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [apiKey, statement]);
  const loaded = record?.statement === statement;
  return <><div className={s.controls}><Button secondary disabled={!loaded} onClick={() => downloadStatementCsv(statement, record.details)}>Download CSV</Button><a href="/dashboard/#settings">Edit business details in Settings</a></div>
    {error ? <p role="alert">Business details could not be read: {error}. Read the statement again before exporting.</p> : !loaded ? <p role="status">Reading business details. Wait before printing.</p> : <BilledTo details={record.details}/>}
  </>;
}
