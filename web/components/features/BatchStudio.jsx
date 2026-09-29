"use client";

/**
 * Batch Studio workspace tab. Props (from Dashboard): { live, apiKey, ws, status, catalog, refresh, notify, fail, navigate }.
 * live=false is the explicit sample workspace: show clearly-labelled sample content or an explanatory state,
 * never simulated results presented as real.
 */
export default function BatchStudio({ live }) {
  return (
    <div className="empty">
      <h3>Batch Studio</h3>
      <p>{live ? "Coming soon." : "Available in the live workspace."}</p>
    </div>
  );
}
