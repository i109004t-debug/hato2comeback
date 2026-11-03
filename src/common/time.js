import { setTimeout } from 'node:timers/promises';

export const now = () => Date.now();
export const sleep = (ms) => setTimeout(ms);

export function createTime(deps = {}) {
  return { now: deps.now ?? now, sleep: deps.sleep ?? sleep };
}

export function jstDate(value = now()) {
  return new Date(Number(new Date(value)) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function nextJstDayAt0005(value = now()) {
  const day = jstDate(value);
  return new Date(Date.parse(`${day}T00:05:00+09:00`) + 24 * 60 * 60 * 1000).toISOString();
}

export function unixSeconds(value = now()) {
  return Math.floor(Number(new Date(value)) / 1000);
}
