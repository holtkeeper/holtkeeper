import { useEffect, useState } from 'react'

/** The current time, updated every `intervalMs` while the component is mounted. */
export function useNow(intervalMs = 15_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
