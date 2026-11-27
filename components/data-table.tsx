import type { ReactNode } from 'react';

/** Real table for admin lists: hidden caption, column headers with scope. Put a <th scope="row"> first in each row. */
export default function DataTable({ caption, heads, children }: { caption: string; heads: string[]; children: ReactNode }) {
  return <div style={{ overflowX: 'auto' }}>
    <table className="data-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '10px 6px', textAlign: 'start' }}>
      <caption className="visually-hidden">{caption}</caption>
      <thead><tr>{heads.map(h => <th key={h} scope="col" style={{ textAlign: 'start' }}>{h}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>;
}
