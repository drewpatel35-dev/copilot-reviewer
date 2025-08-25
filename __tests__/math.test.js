import { sub, clamp, div } from '../src/math';

test('sub function', () => {
  expect(sub(5, 3)).toBe(2);
});

test('clamp function', () => {
  expect(clamp(10, 5, 15)).toBe(10);
  expect(clamp(20, 5, 15)).toBe(15);
  expect(() => clamp(10, 15, 5)).toThrow('min>max');
});

test('div function', () => {
  expect(div(6, 2)).toBe(3);
  expect(() => div(6, 0)).toThrow('div by zero');
});