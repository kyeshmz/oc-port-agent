import assert from 'node:assert/strict';
import test from 'node:test';
import { removePrefixBom } from '../lib/strip-prefix.js';
import { localTag } from '../lib/target-helpers.js';

test('remove exactly one leading BOM, preserving repeated and interior BOMs', () => {
  for (const [input, expected] of [
    ['', ''],
    ['plain', 'plain'],
    ['\uFEFFplain', 'plain'],
    ['\uFEFF\uFEFFplain', '\uFEFFplain'],
    ['a\uFEFFb', 'a\uFEFFb'],
    ['\uFEFF日本語🙂', '日本語🙂'],
    ['\uFEFF', ''],
    ['\\path', '\\path'],
  ]) {
    assert.equal(removePrefixBom(input), expected);
  }
});

test('reject nonstrings without coercion', () => {
  for (const value of [undefined, null, 1, {}, [], false]) {
    assert.throws(() => removePrefixBom(value), TypeError);
  }
});

test('preserve the target-only helper', () => {
  assert.equal(localTag('kept'), 'target:kept');
  assert.equal(localTag('日本語🙂'), 'target:日本語🙂');
});
