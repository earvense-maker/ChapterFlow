import { describe, expect, it } from 'vitest';
import { verifyRewrite } from '../../src/server/services/ngRewriteService';
import { extractSentenceSpan } from '../../src/server/utils/textBoundary';

const target = { id: 'a', text: '瞳を揺らす' };
const registry = [target, { id: 'b', text: '息を呑んだ' }];
const original = '彼女はゆっくりと瞳を揺らす、その静けさが部屋に落ちた。';

describe('verifyRewrite', () => {
  it('accepts a rewrite that replaced the expression', () => {
    const verdict = verifyRewrite(
      '彼女はゆっくりと視線を泳がせ、その静けさが部屋に落ちた。',
      original,
      target,
      registry
    );
    expect(verdict.ok).toBe(true);
  });

  it('rejects a rewrite that still contains the expression', () => {
    const verdict = verifyRewrite(
      '彼女は静かに瞳を揺らす、部屋には物音ひとつなかった。',
      original,
      target,
      registry
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('瞳を揺らす');
  });

  it('rejects a rewrite that introduced a different registered expression', () => {
    const verdict = verifyRewrite(
      '彼女はゆっくりと息を呑んだ、その静けさが部屋に落ちた。',
      original,
      target,
      registry
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('息を呑んだ');
  });

  // NOTE: 元から2語入っていた一文で、対象語だけ直した出力を通すこと。ここで
  // 落とすと、2語入った一文はどちらを狙っても収束せず両方ハイライトのまま残る。
  it('accepts a rewrite that leaves an expression which was already in the original', () => {
    const twoHits = '彼女はゆっくりと瞳を揺らす、それから息を呑んだ。';
    const verdict = verifyRewrite(
      '彼女はゆっくりと視線を泳がせ、それから息を呑んだ。',
      twoHits,
      target,
      registry
    );
    expect(verdict.ok).toBe(true);
  });

  // NOTE: 上と対で、元に無かった語を新たに持ち込んだ場合は落とすこと。
  it('still rejects a newly introduced expression when the original had another one', () => {
    const twoHits = '彼女はゆっくりと瞳を揺らす、それから黙り込んだ。';
    const verdict = verifyRewrite(
      '彼女はゆっくりと息を呑んだ、それから黙り込んだ。',
      twoHits,
      target,
      registry
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('息を呑んだ');
  });

  // NOTE: この機能を入れた動機そのもの。一音だけ変えて実質同じ表現を残す逃げ方を、
  // 完全一致の検出だけでは捕まえられないので近似判定で弾く。
  it('rejects a rewrite that only changed one character of the expression', () => {
    const verdict = verifyRewrite(
      '彼女はゆっくりと瞳を揺らし、その静けさが部屋に落ちた。',
      original,
      target,
      registry
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('別の言葉に置き換える');
  });

  it('rejects an unchanged rewrite even if punctuation moved', () => {
    const verdict = verifyRewrite(
      '彼女はゆっくりと瞳を揺らす。その静けさが部屋に落ちた。',
      original,
      target,
      registry
    );
    expect(verdict.ok).toBe(false);
  });

  it('rejects an empty rewrite', () => {
    expect(verifyRewrite('   ', original, target, registry).ok).toBe(false);
  });

  it('rejects a rewrite that drifted far from the original length', () => {
    const verdict = verifyRewrite('視線が泳いだ。', original, target, registry);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('長さ');
  });
});

describe('extractSentenceSpan', () => {
  it('takes the sentence containing the hit, not the whole paragraph', () => {
    const text = '朝の光が差した。彼女は瞳を揺らす。誰も答えなかった。';
    const start = text.indexOf('瞳を揺らす');
    const span = extractSentenceSpan(text, start, start + '瞳を揺らす'.length);
    expect(text.slice(span.start, span.end)).toBe('彼女は瞳を揺らす。');
  });

  it('keeps the closing bracket that belongs to the sentence', () => {
    const text = '彼は言った。「瞳を揺らすな」と。それきり黙った。';
    const start = text.indexOf('瞳を揺らす');
    const span = extractSentenceSpan(text, start, start + '瞳を揺らす'.length);
    expect(text.slice(span.start, span.end)).toBe('「瞳を揺らすな」と。');
  });

  it('stops at a line break', () => {
    const text = '前の段落。\n彼女は瞳を揺らす\n次の段落。';
    const start = text.indexOf('瞳を揺らす');
    const span = extractSentenceSpan(text, start, start + '瞳を揺らす'.length);
    expect(text.slice(span.start, span.end)).toBe('彼女は瞳を揺らす');
  });

  // NOTE: 句読点の無い長い塊をそのまま投げると書き換え幅が大きくなりすぎるので、
  // 当該箇所の前後だけに縮める。
  it('narrows an overlong sentence to the neighbourhood of the hit', () => {
    const filler = 'あ'.repeat(500);
    const text = `${filler}瞳を揺らす${filler}`;
    const start = text.indexOf('瞳を揺らす');
    const span = extractSentenceSpan(text, start, start + '瞳を揺らす'.length);
    expect(span.end - span.start).toBeLessThan(400);
    expect(text.slice(span.start, span.end)).toContain('瞳を揺らす');
  });
});
