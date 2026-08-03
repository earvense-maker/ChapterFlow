import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../../src/server/utils/keyedMutex';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  // promise チェーンの継続を全て流す。1 tick では足りないことがある。
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('KeyedMutex', () => {
  it('runs tasks for the same key strictly in FIFO order without overlap', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const gateA = deferred();
    const gateB = deferred();

    const a = mutex.runExclusive('k', async () => {
      log.push('a:start');
      await gateA.promise;
      log.push('a:end');
    });
    const b = mutex.runExclusive('k', async () => {
      log.push('b:start');
      await gateB.promise;
      log.push('b:end');
    });
    const c = mutex.runExclusive('k', async () => {
      log.push('c');
    });

    await settle();
    expect(log).toEqual(['a:start']);

    gateA.resolve();
    await settle();
    expect(log).toEqual(['a:start', 'a:end', 'b:start']);

    gateB.resolve();
    await Promise.all([a, b, c]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c']);
  });

  it('does not serialize different keys against each other', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const gate = deferred();

    const slow = mutex.runExclusive('k1', async () => {
      await gate.promise;
      log.push('k1');
    });
    const fast = mutex.runExclusive('k2', async () => {
      log.push('k2');
    });

    await fast;
    expect(log).toEqual(['k2']);
    gate.resolve();
    await slow;
    expect(log).toEqual(['k2', 'k1']);
  });

  it('keeps the chain intact when an earlier task fails', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];

    const failing = mutex.runExclusive('k', async () => {
      throw new Error('boom');
    });
    const following = mutex.runExclusive('k', async () => {
      log.push('after-failure');
    });

    await expect(failing).rejects.toThrow('boom');
    await following;
    expect(log).toEqual(['after-failure']);
  });

  // NOTE: これが8箇所コピーの中で一番落としやすかった不変条件。解放時に「自分が
  // まだ末尾のときだけ」Map を掃除しないと、後続の実行中に次の acquire が新しい
  // チェーンを始め、排他が静かに破れる。
  it('does not let a new task overlap a queued task after an earlier release cleans up', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const gateA = deferred();
    const gateB = deferred();

    const a = mutex.runExclusive('k', async () => {
      log.push('a:start');
      await gateA.promise;
      log.push('a:end');
    });
    // b を並べてから a を解放する。誤実装だと a の解放が Map を消し、
    // ここで並べる c が b と並走する。
    const b = mutex.runExclusive('k', async () => {
      log.push('b:start');
      await gateB.promise;
      log.push('b:end');
    });

    await settle();
    gateA.resolve();
    await settle();
    expect(log).toEqual(['a:start', 'a:end', 'b:start']);

    const c = mutex.runExclusive('k', async () => {
      log.push('c');
    });
    await settle();
    // b が保持中なので c はまだ走れないこと。
    expect(log).toEqual(['a:start', 'a:end', 'b:start']);

    gateB.resolve();
    await Promise.all([a, b, c]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c']);
  });

  it('acquire returns an idempotent release', async () => {
    const mutex = new KeyedMutex();
    const release = await mutex.acquire('k');
    release();
    release(); // 二重解放は無視される

    const log: string[] = [];
    await mutex.runExclusive('k', async () => {
      log.push('ran');
    });
    expect(log).toEqual(['ran']);
  });

  it('counts enqueued-but-not-acquired waiters per key', async () => {
    const mutex = new KeyedMutex();
    const gate = deferred();

    const holder = mutex.runExclusive('k', () => gate.promise);
    await settle();
    expect(mutex.waiterCount('k')).toBe(0); // 保持中の1件は数えない

    const waiting = mutex.runExclusive('k', async () => undefined);
    await settle();
    expect(mutex.waiterCount('k')).toBe(1);
    expect(mutex.waiterCount('other')).toBe(0);

    gate.resolve();
    await Promise.all([holder, waiting]);
    expect(mutex.waiterCount('k')).toBe(0);
  });
});
