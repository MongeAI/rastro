import React from 'react';
import './view.css';

export function render(data) {
  return <Card title={data.title} />;
}

function Card(props) {
  return <div className="card">{props.title}</div>;
}
