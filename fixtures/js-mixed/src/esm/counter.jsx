import { useState, memo } from 'react';

export const Badge = memo(function Badge({ value }) {
  return <span className="badge">{value}</span>;
});

export function Counter() {
  const [count, setCount] = useState(0);
  const label = (n) => `cliques: ${n}`;
  const increment = () => setCount(count + 1);
  return (
    <button onClick={increment}>
      {label(count)} <Badge value={count} />
    </button>
  );
}
