import { useState, useEffect } from 'react';

export function useFetch(): string {
  const [value, setValue] = useState('');
  useEffect(() => {
    setValue('ok');
  }, []);
  return value;
}
