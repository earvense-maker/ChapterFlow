// NOTE: キー（projectId / sessionId など）ごとに非同期処理を直列化する promise-chain
// mutex。以前は同型の実装が8つのサービスへコピーされており、それぞれが
// 「Map の掃除は自分が末尾のときだけ」という繊細な条件を独立に維持していた。
// この条件を1箇所でも落とすと、後続が並んでいるのに Map からチェーンが消え、
// ロックが静かに効かなくなる（エラーは出ない）。正しさはここで一度だけ守る。
//
// re-entrant ではない。同じキーのロック中に同じキーを取ろうとするとデッドロックする。
// この性質はコピー元の全実装と同じで、呼び出し側は Unlocked 系関数の命名規約で回避
// している。
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, number>();

  // NOTE: ロックを取得し、解放関数を返す。try/finally を呼び出し側が書く形。
  // ほとんどの用途は runExclusive で足りる。解放関数は二重呼び出しを無視する。
  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, next);

    this.trackWaiter(key, 1);
    try {
      // 前走者の失敗はロックの成立に影響させない（catch で吸収して順番だけもらう）。
      await previous.catch(() => undefined);
    } finally {
      this.trackWaiter(key, -1);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      // NOTE: 自分の後ろに誰かが並ぶと tails の値は付け替わっている。無条件に delete
      // すると、実行中の後続がいるのに次の acquire が新しいチェーンを始めてしまい、
      // 排他が破れる。「まだ自分が末尾のときだけ」消すのが不変条件。
      if (this.tails.get(key) === next) {
        this.tails.delete(key);
      }
    };
  }

  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await task();
    } finally {
      release();
    }
  }

  // NOTE: 「並んだが、まだ取得していない」件数。ロック保持中の1件は含まない。
  // projectLock がテストの可観測点（getProjectWriteWaiterCountForTests）として
  // 使っていたものを引き継いだ。
  waiterCount(key: string): number {
    return this.waiters.get(key) ?? 0;
  }

  // NOTE: いま並んでいる分が全て終わるのを待つ（fire-and-forget ジョブの合流点）。
  // 待ち始めた後に並んだ分は待たない。チェーンは失敗を吸収するので reject しない。
  async whenIdle(key: string): Promise<void> {
    await this.tails.get(key);
  }

  private trackWaiter(key: string, delta: number): void {
    const next = (this.waiters.get(key) ?? 0) + delta;
    if (next > 0) this.waiters.set(key, next);
    else this.waiters.delete(key);
  }
}
