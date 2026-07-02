import { v4 as uuidv4 } from 'uuid';

export function generateId(prefix: string): string {
  return `${prefix}-${uuidv4().slice(0, 8)}`;
}

export function generateTimestampId(prefix: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${y}${m}${d}-${h}${min}${s}-${r}`;
}
