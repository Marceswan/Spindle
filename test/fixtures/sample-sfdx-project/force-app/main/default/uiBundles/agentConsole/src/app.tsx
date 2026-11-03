import { StrictMode } from 'react';
import HomePage from '@/pages/Home';
import { Card } from './components/Card';

export default function App() {
  return (
    <StrictMode>
      <HomePage />
      <Card title="Hello" />
    </StrictMode>
  );
}
