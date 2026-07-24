import 'react';

declare module 'react' {
  interface HTMLAttributes<T> {
    // NOTE: React 18.3.1 は inert を既知のboolean属性として扱わない。inert={true} は
    // DOM に属性を書き出さず、背面が不活性化されない（inert={false} は「非boolean属性に
    // false」警告）。空文字 '' なら標準のboolean属性表記 inert="" として書き出され、実際に
    // inert が効く。よって有効化は ''、無効化は undefined を渡す運用とし、型もそれに合わせて
    // boolean を許可しない（誤って true を渡す事故を型で防ぐ）。
    // React 19 は boolean をネイティブ対応するため、移行時に見直す。
    inert?: '' | undefined;
  }
}
